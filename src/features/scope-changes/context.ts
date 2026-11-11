import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { agreementDraftSchema } from "@/features/agreements/schema";
import type { AuthoritativeMilestoneContext, OpenChangeRequestContext } from "./prompts";
import {
  storedScopeChangeAnalysisSchema,
  type ScopeChangeRequesterRole,
  type StoredScopeChangeAnalysis,
} from "./schema";
import {
  hashChangeRequestText,
  SnapshotSigningConfigurationError,
  verifyScopeChangeSnapshotSignature,
} from "./snapshot";

export interface AuthoritativeProjectRecord {
  id: string;
  owner_id: string;
  title: string;
  client_name: string;
  client_email: string;
  brief: string;
  currency: string;
  total_amount_minor: number;
  status: string;
  start_date: string | null;
  target_end_date: string | null;
}

export interface AuthoritativeAgreementVersionRecord {
  id: string;
  agreement_id: string;
  version_number: number;
  content: unknown;
  content_hash: string;
  status: string;
}

export interface AuthoritativeScopeChangeContext {
  project: AuthoritativeProjectRecord;
  agreement: {
    id: string;
    status: string;
    current_version_id: string | null;
  };
  targetVersion: AuthoritativeAgreementVersionRecord;
  milestones: AuthoritativeMilestoneContext[];
  openChangeRequests: OpenChangeRequestContext[];
  rawAgreementSummary: string | null;
  confirmedBudgetMinor: number | null;
  establishedCurrency: string | null;
}

export type LoadScopeChangeContextResult =
  | { ok: true; context: AuthoritativeScopeChangeContext }
  | { ok: false; code: "DATABASE_ERROR"; status: 500 }
  | { ok: false; code: "FORBIDDEN"; status: 403 }
  | { ok: false; code: "NOT_FOUND"; status: 404 }
  | { ok: false; code: "VERSION_FORBIDDEN"; status: 403 }
  | { ok: false; code: "AGREEMENT_VERSION_REQUIRED"; status: 409 };

const LOCKED_OR_ACTIVE_INTENT_STATUSES = new Set([
  "ORDER_CREATING",
  "ORDER_CREATED",
  "BUYER_APPROVED",
  "CAPTURING",
  "RECONCILING",
  "RECONCILIATION_REQUIRED",
  "COMPLETED",
]);

const PROTECTED_MILESTONE_STATUSES = new Set([
  "APPROVED",
  "IN_PROGRESS",
  "SUBMITTED",
  "ACCEPTED",
]);

function describeProtectionReason(
  milestoneStatus: string,
  intentStatuses: string[]
): { locked: boolean; reason: string | null } {
  if (intentStatuses.includes("COMPLETED")) {
    return { locked: true, reason: "Completed payment intent exists on this milestone" };
  }
  const activeIntent = intentStatuses.find((s) => LOCKED_OR_ACTIVE_INTENT_STATUSES.has(s));
  if (activeIntent) {
    return {
      locked: true,
      reason: `Active payment or reconciliation intent (${activeIntent}) exists`,
    };
  }
  if (milestoneStatus === "ACCEPTED") {
    return { locked: true, reason: "Milestone status is ACCEPTED" };
  }
  if (PROTECTED_MILESTONE_STATUSES.has(milestoneStatus)) {
    return {
      locked: true,
      reason: `Milestone status is contractual (${milestoneStatus})`,
    };
  }
  return { locked: false, reason: null };
}

/**
 * Loads the server-authoritative project, agreement version, milestones, payment locks,
 * and open change requests. Strictly verifies that any requested agreementVersionId belongs
 * to the target project's agreement to block cross-project references.
 */
export async function loadAuthoritativeScopeChangeContext(
  supabase: SupabaseClient,
  params: {
    projectId: string;
    expectedOwnerId?: string;
    requestedAgreementVersionId?: string;
  }
): Promise<LoadScopeChangeContextResult> {
  const { data: projectData, error: projectError } = await supabase
    .from("projects")
    .select(
      "id, owner_id, title, client_name, client_email, brief, currency, total_amount_minor, status, start_date, target_end_date"
    )
    .eq("id", params.projectId)
    .maybeSingle();

  if (projectError) {
    return { ok: false, code: "DATABASE_ERROR", status: 500 };
  }

  const project = projectData as AuthoritativeProjectRecord | null;
  if (params.expectedOwnerId) {
    if (!project || project.owner_id !== params.expectedOwnerId) {
      return { ok: false, code: "FORBIDDEN", status: 403 };
    }
  } else if (!project) {
    return { ok: false, code: "NOT_FOUND", status: 404 };
  }

  const { data: agreementData, error: agreementError } = await supabase
    .from("agreements")
    .select("id, status, current_version_id")
    .eq("project_id", project.id)
    .maybeSingle();

  if (agreementError) {
    return { ok: false, code: "DATABASE_ERROR", status: 500 };
  }

  const agreement = agreementData as {
    id: string;
    status: string;
    current_version_id: string | null;
  } | null;

  if (!agreement) {
    return { ok: false, code: "AGREEMENT_VERSION_REQUIRED", status: 409 };
  }

  const [versionsRes, milestonesRes, intentsRes, openCrRes] = await Promise.all([
    supabase
      .from("agreement_versions")
      .select("id, agreement_id, version_number, content, content_hash, status")
      .eq("agreement_id", agreement.id)
      .order("version_number", { ascending: false }),
    supabase
      .from("milestones")
      .select("id, title, description, status, sort_order, amount_minor, currency, due_date, deliverables")
      .eq("project_id", project.id)
      .order("sort_order", { ascending: true }),
    supabase
      .from("payment_intents")
      .select("milestone_id, status")
      .eq("project_id", project.id),
    supabase
      .from("change_requests")
      .select("id, request_text, submitted_by_label, status, created_at")
      .eq("project_id", project.id)
      .eq("status", "OPEN")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (versionsRes.error || milestonesRes.error || intentsRes.error || openCrRes.error) {
    return { ok: false, code: "DATABASE_ERROR", status: 500 };
  }

  const versions = (versionsRes.data ?? []) as AuthoritativeAgreementVersionRecord[];
  if (versions.length === 0) {
    return { ok: false, code: "AGREEMENT_VERSION_REQUIRED", status: 409 };
  }

  let targetVersion: AuthoritativeAgreementVersionRecord | null = null;
  if (params.requestedAgreementVersionId) {
    targetVersion =
      versions.find(
        (v) =>
          v.id === params.requestedAgreementVersionId && v.agreement_id === agreement.id
      ) ?? null;
    if (!targetVersion) {
      return { ok: false, code: "VERSION_FORBIDDEN", status: 403 };
    }
  } else {
    // Prefer latest APPROVED version (contract baseline), then current pointer, then newest
    targetVersion =
      versions.find((v) => v.status === "APPROVED") ??
      versions.find((v) => v.id === agreement.current_version_id) ??
      versions[0] ??
      null;
  }

  if (!targetVersion) {
    return { ok: false, code: "AGREEMENT_VERSION_REQUIRED", status: 409 };
  }

  const intentsByMilestone = new Map<string, string[]>();
  for (const intent of (intentsRes.data ?? []) as Array<{
    milestone_id: string;
    status: string;
  }>) {
    const existing = intentsByMilestone.get(intent.milestone_id) ?? [];
    existing.push(intent.status);
    intentsByMilestone.set(intent.milestone_id, existing);
  }

  const rawMilestones = (milestonesRes.data ?? []) as Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    sort_order: number;
    amount_minor: number;
    currency: string;
    due_date: string | null;
    deliverables: string[] | null;
  }>;

  const milestones: AuthoritativeMilestoneContext[] = rawMilestones.map((m) => {
    const intentStatuses = intentsByMilestone.get(m.id) ?? [];
    const protection = describeProtectionReason(m.status, intentStatuses);
    return {
      title: m.title,
      description: m.description ?? "",
      status: m.status,
      sortOrder: m.sort_order,
      amountMinor:
        typeof m.amount_minor === "number" && Number.isInteger(m.amount_minor) && m.amount_minor > 0
          ? m.amount_minor
          : null,
      currency:
        typeof m.currency === "string" && /^[A-Z]{3}$/.test(m.currency)
          ? m.currency
          : null,
      dueDate: m.due_date ?? null,
      deliverables: Array.isArray(m.deliverables) ? m.deliverables : [],
      isPaymentLinkedOrLocked: protection.locked,
      protectionReason: protection.reason,
    };
  });

  const openChangeRequests: OpenChangeRequestContext[] = (
    (openCrRes.data ?? []) as Array<{
      id: string;
      request_text: string;
      submitted_by_label: string;
      status: string;
      created_at: string;
    }>
  ).map((cr) => ({
    id: cr.id,
    requestText: cr.request_text,
    submittedByLabel: cr.submitted_by_label,
    status: cr.status,
    createdAt: cr.created_at,
  }));

  const parsedContent = agreementDraftSchema.safeParse(targetVersion.content);
  const rawSummary =
    !parsedContent.success &&
    targetVersion.content &&
    typeof targetVersion.content === "object" &&
    "summary" in targetVersion.content &&
    typeof (targetVersion.content as { summary?: unknown }).summary === "string"
      ? ((targetVersion.content as { summary: string }).summary ?? null)
      : null;

  const hasConfirmedBudget =
    typeof project.total_amount_minor === "number" &&
    Number.isInteger(project.total_amount_minor) &&
    project.total_amount_minor > 0;
  const hasConfirmedCurrency =
    typeof project.currency === "string" && /^[A-Z]{3}$/.test(project.currency);

  return {
    ok: true,
    context: {
      project,
      agreement,
      targetVersion,
      milestones,
      openChangeRequests,
      rawAgreementSummary: rawSummary,
      confirmedBudgetMinor: hasConfirmedBudget && hasConfirmedCurrency ? project.total_amount_minor : null,
      establishedCurrency: hasConfirmedBudget && hasConfirmedCurrency ? project.currency : null,
    },
  };
}

export type ValidateSubmittedSnapshotResult =
  | { ok: true; analysis: StoredScopeChangeAnalysis }
  | {
      ok: false;
      status: 400 | 403 | 409 | 503;
      code:
        | "VALIDATION_ERROR"
        | "INVALID_ANALYSIS_SIGNATURE"
        | "FORBIDDEN_ANALYSIS_CONTEXT"
        | "STALE_ANALYSIS"
        | "CONFIGURATION_UNAVAILABLE";
      message: string;
    };

/**
 * Validates that an AI analysis snapshot submitted during change-request persistence matches
 * the exact project, agreement version, requester role, unmodified requestText, and HMAC tag.
 */
export function validateSubmittedAiAnalysisSnapshot(params: {
  rawAnalysis: unknown;
  projectId: string;
  agreementVersionId: string;
  requestText: string;
  expectedRole: ScopeChangeRequesterRole;
}): ValidateSubmittedSnapshotResult {
  const parsed = storedScopeChangeAnalysisSchema.safeParse(params.rawAnalysis);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Submitted AI scope-change analysis failed schema validation.",
    };
  }

  const snapshot = parsed.data;

  let isValidSignature: boolean;
  try {
    isValidSignature = verifyScopeChangeSnapshotSignature(snapshot);
  } catch (error) {
    if (error instanceof SnapshotSigningConfigurationError) {
      return {
        ok: false,
        status: 503,
        code: "CONFIGURATION_UNAVAILABLE",
        message: "Scope-change snapshot verification is unavailable due to server configuration.",
      };
    }
    throw error;
  }

  if (!isValidSignature) {
    return {
      ok: false,
      status: 403,
      code: "INVALID_ANALYSIS_SIGNATURE",
      message: "AI analysis snapshot integrity verification failed.",
    };
  }

  if (
    snapshot.snapshotMetadata.projectId !== params.projectId ||
    snapshot.snapshotMetadata.agreementVersionId !== params.agreementVersionId ||
    snapshot.snapshotMetadata.requesterRole !== params.expectedRole
  ) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN_ANALYSIS_CONTEXT",
      message: "AI analysis snapshot does not belong to this project, version, or requester.",
    };
  }

  const currentRequestHash = hashChangeRequestText(params.requestText);
  if (snapshot.snapshotMetadata.analyzedRequestTextSha256 !== currentRequestHash) {
    return {
      ok: false,
      status: 409,
      code: "STALE_ANALYSIS",
      message:
        "Change request text changed after the AI analysis was generated. Regenerate the analysis before submitting.",
    };
  }

  return { ok: true, analysis: snapshot };
}
