import { NextResponse } from "next/server";
import { z } from "zod";
import { saveAgreementDraft } from "@/app/api/projects/[projectId]/agreement/route";
import { agreementDraftSchema } from "@/features/agreements/schema";
import { manualAgreementDraft } from "@/features/agreements/versioning";
import { toAgreementMilestone } from "@/features/milestones/planning-utils";
import { applyMilestonePlanRequestSchema } from "@/features/milestones/schema";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const uuidSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  if (!uuidSchema.safeParse(projectId).success) {
    return apiError("VALIDATION_ERROR", 400);
  }

  let bodyRaw: unknown;
  try {
    bodyRaw = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400);
  }

  const parsed = applyMilestonePlanRequestSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid milestone plan payload.",
        issues: parsed.error.issues,
      },
      { status: 400 }
    );
  }

  try {
    // 1. Authenticate requester cleanly
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401);
    }

    // 2. Rate-limit apply mutations per owner & project
    if (!(await allowRequest(`milestone-apply:${user.id}:${projectId}`, 15, 60_000))) {
      return apiError("RATE_LIMITED", 429);
    }

    // 3. Authoritative project ownership & financial lookup
    const { data: projectData, error: projectError } = await supabase
      .from("projects")
      .select(
        "id, owner_id, title, client_name, brief, currency, total_amount_minor, target_end_date"
      )
      .eq("id", projectId)
      .maybeSingle();

    if (projectError) {
      return apiError("DATABASE_ERROR", 500);
    }

    const project = projectData as {
      id: string;
      owner_id: string;
      title: string;
      client_name: string;
      brief: string;
      currency: string;
      total_amount_minor: number;
      target_end_date: string | null;
    } | null;

    if (!project || project.owner_id !== user.id) {
      return apiError("FORBIDDEN", 403);
    }

    // 4. Financial reconciliation against authoritative project budget & currency
    if (
      typeof project.total_amount_minor !== "number" ||
      !Number.isInteger(project.total_amount_minor) ||
      project.total_amount_minor <= 0 ||
      !project.currency ||
      !/^[A-Z]{3}$/.test(project.currency)
    ) {
      return apiError("VALIDATION_ERROR", 400);
    }

    let allocatedTotalMinor = 0;
    for (const m of parsed.data.milestones) {
      if (m.currency !== project.currency) {
        return NextResponse.json(
          {
            error: "CURRENCY_MISMATCH",
            message: `Milestone "${m.title}" currency "${m.currency}" does not match project currency "${project.currency}".`,
          },
          { status: 400 }
        );
      }
      allocatedTotalMinor += m.amountMinor;
    }

    if (allocatedTotalMinor !== project.total_amount_minor) {
      return NextResponse.json(
        {
          error: "BUDGET_RECONCILIATION_MISMATCH",
          message: `Milestones total (${allocatedTotalMinor} ${project.currency}) must match project total (${project.total_amount_minor} ${project.currency}).`,
          expectedTotalMinor: project.total_amount_minor,
          actualTotalMinor: allocatedTotalMinor,
          currency: project.currency,
        },
        { status: 400 }
      );
    }

    // 5. Inspect current agreement, version status, milestones, and payment intents
    const { data: agreementData, error: agreementError } = await supabase
      .from("agreements")
      .select("id, status, current_version_id")
      .eq("project_id", project.id)
      .maybeSingle();

    if (agreementError) {
      return apiError("DATABASE_ERROR", 500);
    }

    const agreement = agreementData as {
      id: string;
      status: string;
      current_version_id: string | null;
    } | null;

    if (!agreement) {
      return apiError("NOT_FOUND", 404);
    }

    type CurrentAgreementVersionRow = {
      id: string;
      version_number: number;
      status: string;
      content: unknown;
    };

    let currentVersion: CurrentAgreementVersionRow | null = null;

    if (agreement.current_version_id) {
      const { data: versionData, error: versionError } = await supabase
        .from("agreement_versions")
        .select("id, version_number, status, content")
        .eq("id", agreement.current_version_id)
        .maybeSingle();

      if (versionError) {
        return apiError("DATABASE_ERROR", 500);
      }

      currentVersion = (versionData as CurrentAgreementVersionRow | null) ?? null;
    }

    const effectiveAgreementStatus = currentVersion?.status ?? agreement.status;
    const requiresRevisionConfirmation =
      effectiveAgreementStatus === "APPROVED" || effectiveAgreementStatus === "PENDING_CLIENT";

    if (requiresRevisionConfirmation && !parsed.data.confirmNewRevision) {
      return NextResponse.json(
        {
          error:
            effectiveAgreementStatus === "APPROVED"
              ? "APPROVED_AGREEMENT_REVISION_REQUIRED"
              : "AGREEMENT_REVIEW_IN_PROGRESS",
          message:
            effectiveAgreementStatus === "APPROVED"
              ? "Active agreement is already approved. Confirm creation of a new Draft agreement revision requiring client OTP approval before applying milestone changes."
              : "An agreement version is currently pending client review. Confirm creating a new Draft revision before applying changes.",
        },
        { status: 409 }
      );
    }

    const [existingMilestonesRes, existingIntentsRes] = await Promise.all([
      supabase
        .from("milestones")
        .select("id, status, sort_order")
        .eq("project_id", project.id),
      supabase
        .from("payment_intents")
        .select("id, milestone_id, status")
        .eq("project_id", project.id),
    ]);

    if (existingMilestonesRes.error || existingIntentsRes.error) {
      return apiError("DATABASE_ERROR", 500);
    }

    const existingMilestones = (existingMilestonesRes.data ?? []) as Array<{
      id: string;
      status: string;
      sort_order: number;
    }>;
    const existingIntents = (existingIntentsRes.data ?? []) as Array<{
      id: string;
      milestone_id: string;
      status: string;
    }>;

    // 6. Compose updated AgreementDraft preserving non-milestone agreement terms
    const existingParsedDraft = currentVersion?.content
      ? agreementDraftSchema.safeParse(currentVersion.content)
      : { success: false as const };

    const baseDraft = existingParsedDraft.success
      ? existingParsedDraft.data
      : manualAgreementDraft({
          title: project.title,
          brief: project.brief,
          clientName: project.client_name,
          currency: project.currency,
          totalAmountMinor: project.total_amount_minor,
          endDate: project.target_end_date,
        });

    const nextDraft = {
      ...baseDraft,
      milestones: parsed.data.milestones.map((item, idx) =>
        toAgreementMilestone(item, idx)
      ),
    };

    // 7. Persist via canonical saveAgreementDraft (preserves immutable approved versions and hashes content)
    const draftSaveSource =
      parsed.data.source === "MANUAL" ? "MANUAL" : "AI_ASSISTED";
    const saved = await saveAgreementDraft(project.id, nextDraft, {
      source: draftSaveSource,
    });

    if (saved.error) {
      return saved.error;
    }

    const savedVersion = saved.data as { id: string; version_number: number };
    const revisionCreated =
      Boolean(currentVersion) && currentVersion?.status !== "DRAFT";

    // 8. Sync public.milestones only when no committed/non-DRAFT or payment-linked rows exist
    const hasPaymentLinks = existingIntents.length > 0;
    const hasCommittedMilestones = existingMilestones.some(
      (m) => m.status !== "DRAFT"
    );

    let milestonesTableSynced = false;
    let syncNote: string;

    if (!hasPaymentLinks && !hasCommittedMilestones) {
      if (existingMilestones.length > 0) {
        const { error: deleteError } = await supabase
          .from("milestones")
          .delete()
          .eq("project_id", project.id)
          .eq("status", "DRAFT");

        if (deleteError) {
          return apiError("DATABASE_ERROR", 500);
        }
      }

      const rowsToInsert = parsed.data.milestones.map((m, idx) => ({
        project_id: project.id,
        agreement_version_id: savedVersion.id,
        title: m.title,
        description: m.description,
        deliverables: m.deliverables,
        acceptance_criteria: m.acceptanceCriteria,
        amount_minor: m.amountMinor,
        currency: m.currency,
        due_date: m.dueDate,
        sort_order: idx,
        status: "DRAFT",
      }));

      const { error: insertError } = await supabase
        .from("milestones")
        .insert(rowsToInsert);

      if (insertError) {
        return apiError("MILESTONE_SYNC_FAILED", 500);
      }

      milestonesTableSynced = true;
      syncNote = "SYNCED_TO_DRAFT_MILESTONES";
    } else {
      syncNote = "PRESERVED_COMMITTED_OR_PAYMENT_LINKED_MILESTONES";
    }

    // 9. Explicit milestone plan audit event
    await supabase.from("activity_events").insert({
      project_id: project.id,
      actor_user_id: user.id,
      actor_label: "Freelancer",
      event_type: "milestone.plan_applied",
      summary: revisionCreated
        ? `Applied ${parsed.data.milestones.length} planned milestones into new draft agreement version ${savedVersion.version_number}`
        : `Applied ${parsed.data.milestones.length} planned milestones to draft agreement version ${savedVersion.version_number}`,
      metadata: {
        source: parsed.data.source,
        milestoneCount: parsed.data.milestones.length,
        agreementVersionId: savedVersion.id,
        versionNumber: savedVersion.version_number,
        revisionCreated,
        milestonesTableSynced,
        syncNote,
      },
    });

    return NextResponse.json({
      data: {
        agreementVersion: savedVersion,
        revisionCreated,
        requiresClientApproval: effectiveAgreementStatus === "APPROVED" || revisionCreated,
        milestonesTableSynced,
        syncNote,
        milestoneCount: parsed.data.milestones.length,
      },
    });
  } catch {
    return apiError("INTERNAL_ERROR", 500);
  }
}
