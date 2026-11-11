import type { SupabaseClient } from "@supabase/supabase-js";
import { agreementDraftSchema } from "@/features/agreements/schema";

export type SyncApprovedMilestonesResult = {
  synced: boolean;
  promotedCount: number;
  insertedCount: number;
  reason: string;
};

const COMMITTED_STATUSES = new Set([
  "APPROVED",
  "IN_PROGRESS",
  "SUBMITTED",
  "ACCEPTED",
  "CHANGES_REQUESTED",
]);

/**
 * Idempotently promotes DRAFT/AWAITING_APPROVAL milestones or materializes missing
 * milestones from the project's latest APPROVED agreement version into `public.milestones`
 * with status `APPROVED`.
 *
 * Preserves any committed or payment-linked milestone rows without alteration.
 */
export async function syncApprovedAgreementMilestones(params: {
  supabase: SupabaseClient;
  projectId: string;
  actorUserId?: string | null;
  actorLabel?: string;
}): Promise<SyncApprovedMilestonesResult> {
  const { supabase, projectId, actorUserId = null, actorLabel = "System" } = params;

  const agreementResult = await supabase
    .from("agreements")
    .select("id")
    .eq("project_id", projectId)
    .maybeSingle();

  if (agreementResult.error || !agreementResult.data?.id) {
    return { synced: false, promotedCount: 0, insertedCount: 0, reason: "NO_AGREEMENT" };
  }

  const approvedVersionResult = await supabase
    .from("agreement_versions")
    .select("id, version_number, content")
    .eq("agreement_id", agreementResult.data.id as string)
    .eq("status", "APPROVED")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (approvedVersionResult.error || !approvedVersionResult.data) {
    return { synced: false, promotedCount: 0, insertedCount: 0, reason: "NO_APPROVED_VERSION" };
  }

  const approvedVersion = approvedVersionResult.data as {
    id: string;
    version_number: number;
    content: unknown;
  };

  const [existingMilestonesRes, intentsRes] = await Promise.all([
    supabase
      .from("milestones")
      .select("id, agreement_version_id, status, sort_order")
      .eq("project_id", projectId)
      .order("sort_order"),
    supabase
      .from("payment_intents")
      .select("id, milestone_id")
      .eq("project_id", projectId),
  ]);

  if (existingMilestonesRes.error || intentsRes.error) {
    return { synced: false, promotedCount: 0, insertedCount: 0, reason: "QUERY_FAILED" };
  }

  const existingMilestones = (existingMilestonesRes.data ?? []) as Array<{
    id: string;
    agreement_version_id: string;
    status: string;
    sort_order: number;
  }>;

  const paymentLinkedMilestoneIds = new Set(
    ((intentsRes.data ?? []) as Array<{ milestone_id: string }>).map((i) => i.milestone_id),
  );

  const hasCommittedOrPaid = existingMilestones.some(
    (m) => COMMITTED_STATUSES.has(m.status) || paymentLinkedMilestoneIds.has(m.id),
  );

  let promotedCount = 0;
  let insertedCount = 0;

  // Case 1: Promote un-committed DRAFT / AWAITING_APPROVAL rows when safe
  const promotableRows = existingMilestones.filter((m) => {
    if (m.status !== "DRAFT" && m.status !== "AWAITING_APPROVAL") return false;
    if (paymentLinkedMilestoneIds.has(m.id)) return false;
    // If committed milestones already exist, only promote draft rows explicitly belonging to approvedVersion.id
    if (hasCommittedOrPaid) {
      return m.agreement_version_id === approvedVersion.id;
    }
    return true;
  });

  if (promotableRows.length > 0) {
    const promotableIds = promotableRows.map((m) => m.id);
    const { error: updateError } = await supabase
      .from("milestones")
      .update({
        status: "APPROVED",
        agreement_version_id: approvedVersion.id,
      })
      .in("id", promotableIds);

    if (updateError) {
      return { synced: false, promotedCount: 0, insertedCount: 0, reason: "PROMOTE_FAILED" };
    }
    promotedCount = promotableIds.length;
  } else if (existingMilestones.length === 0) {
    // Case 2: Agreement was approved directly (manual/AI-3 draft) without prior Milestone Planner apply
    const parsedDraft = agreementDraftSchema.safeParse(approvedVersion.content);
    if (!parsedDraft.success || parsedDraft.data.milestones.length === 0) {
      return { synced: false, promotedCount: 0, insertedCount: 0, reason: "NO_PLAN_MILESTONES" };
    }

    const rowsToInsert = parsedDraft.data.milestones.map((m, idx) => ({
      project_id: projectId,
      agreement_version_id: approvedVersion.id,
      title: m.title,
      description: m.description,
      deliverables: m.deliverables,
      acceptance_criteria: m.acceptanceCriteria,
      amount_minor: m.amountMinor,
      currency: m.currency,
      due_date: m.dueDate,
      sort_order: idx,
      status: "APPROVED",
    }));

    const { error: insertError } = await supabase.from("milestones").insert(rowsToInsert);
    if (insertError) {
      return { synced: false, promotedCount: 0, insertedCount: 0, reason: "INSERT_FAILED" };
    }
    insertedCount = rowsToInsert.length;
  }

  if (promotedCount > 0 || insertedCount > 0) {
    await supabase.from("activity_events").insert({
      project_id: projectId,
      actor_user_id: actorUserId,
      actor_label: actorLabel,
      event_type: "milestone.plan_synced",
      summary: `Synchronized ${promotedCount + insertedCount} agreed milestone(s) from approved Agreement v${approvedVersion.version_number}`,
      metadata: {
        agreementVersionId: approvedVersion.id,
        versionNumber: approvedVersion.version_number,
        promotedCount,
        insertedCount,
      },
    });
  }

  return {
    synced: true,
    promotedCount,
    insertedCount,
    reason:
      promotedCount > 0
        ? "PROMOTED_DRAFT_MILESTONES"
        : insertedCount > 0
          ? "MATERIALIZED_FROM_APPROVED_AGREEMENT"
          : "ALREADY_SYNCED",
  };
}
