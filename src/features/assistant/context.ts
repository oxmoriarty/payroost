import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { agreementDraftSchema, type AgreementDraft } from "@/features/agreements/schema";
import { storedScopeChangeAnalysisSchema } from "@/features/scope-changes/schema";
import { redactSensitiveData } from "@/lib/ai/errors";
import type { AssistantParticipantRole } from "./schema";

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function truncateText(text: string, maxLen: number): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 14)}... [truncated]`;
}

export function sanitizeTextForAssistant(
  input: string | null | undefined,
  maxLen = 2000
): string {
  if (!input || typeof input !== "string") return "";
  const withoutSecrets = redactSensitiveData(input);
  const withoutEmails = withoutSecrets.replace(EMAIL_REGEX, "[redacted-email]");
  const withoutUuids = withoutEmails.replace(UUID_REGEX, "[id]");
  return truncateText(withoutUuids, maxLen);
}

function normalizeActorRoleLabel(label: string | null | undefined): string {
  if (!label || typeof label !== "string") return "Participant";
  const cleaned = label.replace(/\([^)]*@[^)]*\)/g, "").replace(EMAIL_REGEX, "").trim();
  return cleaned.length > 0 ? truncateText(redactSensitiveData(cleaned), 80) : "Participant";
}

function summarizeReconciliationStatusForRole(
  status: string,
  reason: string | null,
  role: AssistantParticipantRole
): string | null {
  if (!reason) return null;
  if (role === "CLIENT") {
    // Expose safe non-sensitive customer verification status; withhold internal PayPal merchant/lease codes
    if (status === "RECONCILIATION_REQUIRED" || status === "RECONCILING" || status === "CAPTURING") {
      return "Verification with payment provider is still pending";
    }
    return null;
  }
  return sanitizeTextForAssistant(reason, 160);
}

export interface AssistantAgreementVersionSummary {
  versionNumber: number;
  status: string;
  isCurrentPointer: boolean;
  isLatestApproved: boolean;
  createdAt: string;
  sentAt: string | null;
  approvedAt: string | null;
  approvedByRoleLabel: string | null;
  sourceRef: string;
  draft: {
    summary: string;
    objective: string;
    scopeItems: Array<{
      title: string;
      description: string;
      deliverables: string[];
      acceptanceCriteria: string[];
      assumptions: string[];
    }>;
    exclusions: string[];
    milestonesInDraft: Array<{
      title: string;
      amountMinor: number;
      currency: string;
      dueDate: string | null;
      deliverables: string[];
    }>;
    timeline: Array<{ label: string; date: string | null; notes: string }>;
    paymentTerms: string[];
    revisionPolicy: string[];
    changeProcess: string[];
    openQuestions: string[];
    warnings: string[];
  } | null;
}

export interface AssistantMilestoneSummary {
  index: number;
  sourceRef: string;
  title: string;
  status: string;
  deliverableStatusMeaning: string;
  description: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  amountMinor: number;
  currency: string;
  dueDate: string | null;
  agreementVersionNumber: number | null;
  paymentStateSummary: string;
  hasActiveOrCompletedPaymentIntent: boolean;
}

export interface AssistantChangeRequestSummary {
  index: number;
  sourceRef: string;
  aiProposalSourceRef: string | null;
  agreementVersionNumber: number | null;
  submittedByRoleLabel: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  originalRequestText: string;
  contractualEffectNote: string;
  persistedAiAdvice: {
    isAiGeneratedAdviceOnly: true;
    analyzedAt: string;
    model: string;
    overallClassification: string;
    requestedChangeSummary: string;
    financialDirection: string;
    proposedCostDeltaMinor: number | null;
    currency: string | null;
    timelineClassification: string;
    estimatedAdditionalDaysMin: number | null;
    estimatedAdditionalDaysMax: number | null;
    unresolvedQuestions: string[];
    recommendedNextSteps: string[];
  } | null;
}

export interface AssistantPaymentRecordSummary {
  index: number;
  sourceRef: string;
  milestoneTitle: string;
  intentStatus: string;
  statusExplanation: string;
  amountMinor: number;
  currency: string;
  provider: string;
  buyerApprovedAt: string | null;
  completedAt: string | null;
  verificationNote: string | null;
  transactions: Array<{
    transactionType: string;
    status: string;
    amountMinor: number;
    currency: string;
    capturedAt: string;
  }>;
}

export interface AssistantActivitySummary {
  createdAt: string;
  actorRoleLabel: string;
  eventType: string;
  summary: string;
}

export interface AuthoritativeProjectAssistantContext {
  participantRole: AssistantParticipantRole;
  project: {
    id: string;
    title: string;
    status: string;
    clientName: string;
    clientVerified: boolean;
    currency: string;
    confirmedBudgetMinor: number;
    startDate: string | null;
    targetEndDate: string | null;
    briefText: string;
    createdAt: string;
    updatedAt: string;
  };
  agreement: {
    status: string | null;
    approvedVersionNumber: number | null;
    currentVersionNumber: number | null;
    totalVersionCount: number;
    approvedVersion: AssistantAgreementVersionSummary | null;
    currentVersion: AssistantAgreementVersionSummary | null;
    historicalVersions: Array<{
      versionNumber: number;
      status: string;
      createdAt: string;
      sentAt: string | null;
      approvedAt: string | null;
      approvedByRoleLabel: string | null;
      summaryExcerpt: string | null;
      sourceRef: string;
    }>;
    versionChangesBetweenBaselineAndCurrent: string[];
  };
  milestones: AssistantMilestoneSummary[];
  changeRequests: AssistantChangeRequestSummary[];
  payments: {
    records: AssistantPaymentRecordSummary[];
    hasAnyCompletedCapture: boolean;
    hasAnyPendingVerificationOrReconciliation: boolean;
    hasAnyBuyerApprovedUncaptured: boolean;
    ledgerCapabilitiesNote: string;
  };
  activities: AssistantActivitySummary[];
  outstandingItems: string[];
  detectedConflicts: string[];
  dataLimitations: string[];
  validSourceRefs: string[];
  stats: {
    approvedAgreementVersion: number | null;
    currentAgreementVersion: number | null;
    milestoneCount: number;
    openChangeRequestCount: number;
    recordedPaymentIntentCount: number;
  };
}

export type AssembleAssistantContextResult =
  | { ok: true; context: AuthoritativeProjectAssistantContext }
  | { ok: false; code: "FORBIDDEN" | "NOT_FOUND" | "DATABASE_ERROR"; status: 403 | 404 | 500 };

function summarizeMilestoneDeliverableStatus(status: string): string {
  switch (status) {
    case "SUBMITTED":
      return "Deliverables marked SUBMITTED by freelancer; awaiting client acceptance";
    case "ACCEPTED":
      return "Milestone marked ACCEPTED in milestone workflow";
    case "CHANGES_REQUESTED":
      return "Client requested changes on this milestone";
    case "IN_PROGRESS":
      return "Work in progress; deliverables not yet submitted";
    case "APPROVED":
      return "Contractually approved; work not marked submitted";
    case "AWAITING_APPROVAL":
      return "Awaiting agreement approval";
    case "CANCELLED":
      return "Cancelled";
    case "DRAFT":
    default:
      return "Draft milestone (not yet finalized)";
  }
}

function summarizePaymentIntentStatus(status: string, hasCompletedCapture: boolean): string {
  if (status === "COMPLETED" && hasCompletedCapture) {
    return "Provider CAPTURE verified in PayRoost ledger (does not verify downstream bank payout settlement)";
  }
  switch (status) {
    case "BUYER_APPROVED":
      return "Client approved checkout with provider; capture is NOT completed yet";
    case "CAPTURING":
    case "RECONCILING":
    case "RECONCILIATION_REQUIRED":
      return `Capture or provider reconciliation is pending (${status}); payment is NOT confirmed complete`;
    case "ORDER_CREATING":
    case "ORDER_CREATED":
      return "Checkout order created; buyer approval and capture have NOT occurred";
    case "FAILED":
      return "Payment attempt failed; no completed capture";
    case "CANCELLED":
      return "Payment attempt cancelled; no completed capture";
    case "COMPLETED":
      return "Payment intent marked COMPLETED";
    default:
      return `Status ${status}`;
  }
}

function summarizeDraftContent(rawContent: unknown): AssistantAgreementVersionSummary["draft"] {
  const parsed = agreementDraftSchema.safeParse(rawContent);
  if (!parsed.success) return null;
  const d: AgreementDraft = parsed.data;
  return {
    summary: sanitizeTextForAssistant(d.summary, 1200),
    objective: sanitizeTextForAssistant(d.objective, 600),
    scopeItems: d.scopeItems.slice(0, 12).map((item) => ({
      title: sanitizeTextForAssistant(item.title, 160),
      description: sanitizeTextForAssistant(item.description, 500),
      deliverables: item.deliverables.slice(0, 10).map((deliv) => sanitizeTextForAssistant(deliv, 250)),
      acceptanceCriteria: item.acceptanceCriteria
        .slice(0, 8)
        .map((ac) => sanitizeTextForAssistant(ac, 250)),
      assumptions: item.assumptions.slice(0, 6).map((a) => sanitizeTextForAssistant(a, 220)),
    })),
    exclusions: d.exclusions.slice(0, 10).map((e) => sanitizeTextForAssistant(e, 260)),
    milestonesInDraft: d.milestones.slice(0, 15).map((m) => ({
      title: sanitizeTextForAssistant(m.title, 160),
      amountMinor: m.amountMinor,
      currency: m.currency,
      dueDate: m.dueDate,
      deliverables: m.deliverables.slice(0, 8).map((deliv) => sanitizeTextForAssistant(deliv, 220)),
    })),
    timeline: d.timeline.slice(0, 10).map((t) => ({
      label: sanitizeTextForAssistant(t.label, 140),
      date: t.date,
      notes: sanitizeTextForAssistant(t.notes, 300),
    })),
    paymentTerms: d.paymentTerms.slice(0, 6).map((p) => sanitizeTextForAssistant(p, 260)),
    revisionPolicy: d.revisionPolicy.slice(0, 6).map((p) => sanitizeTextForAssistant(p, 260)),
    changeProcess: d.changeProcess.slice(0, 6).map((p) => sanitizeTextForAssistant(p, 260)),
    openQuestions: d.openQuestions.slice(0, 10).map((q) => sanitizeTextForAssistant(q, 260)),
    warnings: d.warnings.slice(0, 10).map((w) => sanitizeTextForAssistant(w, 260)),
  };
}

function computeAgreementDiffNotes(
  baseline: AssistantAgreementVersionSummary | null,
  current: AssistantAgreementVersionSummary | null
): string[] {
  if (!baseline || !current || baseline.versionNumber === current.versionNumber) {
    return [];
  }
  const diffs: string[] = [];
  const baseDraft = baseline.draft;
  const currDraft = current.draft;

  diffs.push(
    `Comparing Agreement v${baseline.versionNumber} (${baseline.status}) to v${current.versionNumber} (${current.status}).`
  );

  if (!baseDraft || !currDraft) {
    return diffs;
  }

  if (baseDraft.summary !== currDraft.summary || baseDraft.objective !== currDraft.objective) {
    diffs.push("Agreement summary or project objective text differs between versions.");
  }

  const baseScopes = new Set(baseDraft.scopeItems.map((s) => s.title.toLowerCase()));
  const currScopes = new Set(currDraft.scopeItems.map((s) => s.title.toLowerCase()));
  const addedScopes = currDraft.scopeItems
    .filter((s) => !baseScopes.has(s.title.toLowerCase()))
    .map((s) => s.title);
  const removedScopes = baseDraft.scopeItems
    .filter((s) => !currScopes.has(s.title.toLowerCase()))
    .map((s) => s.title);
  if (addedScopes.length > 0) {
    diffs.push(`Scope items added in v${current.versionNumber}: ${addedScopes.join(", ")}.`);
  }
  if (removedScopes.length > 0) {
    diffs.push(`Scope items removed in v${current.versionNumber}: ${removedScopes.join(", ")}.`);
  }

  const baseSum = baseDraft.milestonesInDraft.reduce((acc, m) => acc + BigInt(m.amountMinor), 0n);
  const currSum = currDraft.milestonesInDraft.reduce((acc, m) => acc + BigInt(m.amountMinor), 0n);
  if (baseSum !== currSum) {
    diffs.push(
      `Draft milestone total changed from ${baseSum.toString()} minor units in v${baseline.versionNumber} to ${currSum.toString()} minor units in v${current.versionNumber}.`
    );
  }

  const baseByTitle = new Map(
    baseDraft.milestonesInDraft.map((m) => [m.title.trim().toLowerCase(), m])
  );
  for (const cm of currDraft.milestonesInDraft) {
    const bm = baseByTitle.get(cm.title.trim().toLowerCase());
    if (!bm) {
      diffs.push(
        `Milestone "${cm.title}" appears in v${current.versionNumber} (${cm.amountMinor} ${cm.currency}) and was not in v${baseline.versionNumber}.`
      );
    } else if (bm.dueDate !== cm.dueDate) {
      diffs.push(
        `Due date for "${cm.title}" changed from ${bm.dueDate ?? "unset"} (v${baseline.versionNumber}) to ${cm.dueDate ?? "unset"} (v${current.versionNumber}).`
      );
    }
  }

  if (JSON.stringify(baseDraft.timeline) !== JSON.stringify(currDraft.timeline)) {
    diffs.push(
      `Timeline schedule entries differ between v${baseline.versionNumber} and v${current.versionNumber}.`
    );
  }

  return diffs;
}

/**
 * Canonical server-side context assembler for Phase AI-6 Project Assistant.
 * Enforces participant authorization, fetches authoritative PayRoost database records,
 * redacts private seller/account identifiers and unnecessary emails, and surfaces conflicts
 * and platform record boundaries explicitly.
 */
export async function assembleProjectAssistantContext(
  supabase: SupabaseClient,
  params: {
    projectId: string;
    participantRole: AssistantParticipantRole;
    expectedOwnerId?: string;
    expectedClientEmail?: string;
  }
): Promise<AssembleAssistantContextResult> {
  const { data: projectData, error: projectError } = await supabase
    .from("projects")
    .select(
      "id, owner_id, title, client_name, client_email, client_email_verified_at, brief, currency, total_amount_minor, status, start_date, target_end_date, created_at, updated_at"
    )
    .eq("id", params.projectId)
    .maybeSingle();

  if (projectError) {
    return { ok: false, code: "DATABASE_ERROR", status: 500 };
  }

  const project = projectData as {
    id: string;
    owner_id: string;
    title: string;
    client_name: string;
    client_email: string;
    client_email_verified_at: string | null;
    brief: string;
    currency: string;
    total_amount_minor: number;
    status: string;
    start_date: string | null;
    target_end_date: string | null;
    created_at: string;
    updated_at: string;
  } | null;

  if (params.expectedOwnerId) {
    if (!project || project.owner_id !== params.expectedOwnerId) {
      return { ok: false, code: "FORBIDDEN", status: 403 };
    }
  } else if (params.expectedClientEmail) {
    if (!project || project.client_email !== params.expectedClientEmail) {
      return { ok: false, code: "FORBIDDEN", status: 403 };
    }
  } else if (!project) {
    return { ok: false, code: "NOT_FOUND", status: 404 };
  }

  const [agreementRes, milestonesRes, changeRequestsRes, intentsRes, activityRes] =
    await Promise.all([
      supabase
        .from("agreements")
        .select("id, status, current_version_id")
        .eq("project_id", project.id)
        .maybeSingle(),
      supabase
        .from("milestones")
        .select(
          "id, agreement_version_id, sort_order, title, description, deliverables, acceptance_criteria, amount_minor, currency, due_date, status"
        )
        .eq("project_id", project.id)
        .order("sort_order", { ascending: true })
        .limit(40),
      supabase
        .from("change_requests")
        .select(
          "id, agreement_version_id, request_text, submitted_by_label, status, created_at, resolved_at, ai_analysis, ai_analyzed_at, ai_model"
        )
        .eq("project_id", project.id)
        .order("created_at", { ascending: false })
        .limit(15),
      supabase
        .from("payment_intents")
        .select(
          "id, milestone_id, agreement_version_id, status, expected_currency, expected_amount_cents, provider, buyer_approved_at, completed_at, reconciliation_reason, created_at"
        )
        .eq("project_id", project.id)
        .order("created_at", { ascending: false })
        .limit(40),
      supabase
        .from("activity_events")
        .select("id, actor_label, event_type, summary, created_at")
        .eq("project_id", project.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  if (
    agreementRes.error ||
    milestonesRes.error ||
    changeRequestsRes.error ||
    intentsRes.error ||
    activityRes.error
  ) {
    return { ok: false, code: "DATABASE_ERROR", status: 500 };
  }

  const agreementRow = agreementRes.data as {
    id: string;
    status: string;
    current_version_id: string | null;
  } | null;

  let rawVersions: Array<{
    id: string;
    agreement_id: string;
    version_number: number;
    content: unknown;
    status: string;
    created_at: string;
    sent_at: string | null;
    approved_at: string | null;
    approved_by_label: string | null;
  }> = [];

  if (agreementRow?.id) {
    const { data: versionsData, error: versionsError } = await supabase
      .from("agreement_versions")
      .select(
        "id, agreement_id, version_number, content, status, created_at, sent_at, approved_at, approved_by_label"
      )
      .eq("agreement_id", agreementRow.id)
      .order("version_number", { ascending: false })
      .limit(12);

    if (versionsError) {
      return { ok: false, code: "DATABASE_ERROR", status: 500 };
    }
    rawVersions = (versionsData ?? []) as typeof rawVersions;
  }

  const rawIntents = (intentsRes.data ?? []) as Array<{
    id: string;
    milestone_id: string;
    agreement_version_id: string;
    status: string;
    expected_currency: string;
    expected_amount_cents: number;
    provider: string;
    buyer_approved_at: string | null;
    completed_at: string | null;
    reconciliation_reason: string | null;
    created_at: string;
  }>;

  const intentIds = rawIntents.map((i) => i.id);
  let rawTransactions: Array<{
    id: string;
    payment_intent_id: string;
    parent_transaction_id: string | null;
    transaction_type: string;
    status: string;
    amount_cents: number;
    currency: string;
    captured_at: string;
  }> = [];

  if (intentIds.length > 0) {
    const { data: txData, error: txError } = await supabase
      .from("payment_transactions")
      .select(
        "id, payment_intent_id, parent_transaction_id, transaction_type, status, amount_cents, currency, captured_at"
      )
      .in("payment_intent_id", intentIds)
      .order("created_at", { ascending: false })
      .limit(50);

    if (txError) {
      return { ok: false, code: "DATABASE_ERROR", status: 500 };
    }
    rawTransactions = (txData ?? []) as typeof rawTransactions;
  }

  // Version mapping & authority hierarchy
  const validSourceRefs = new Set<string>([
    "Project Record",
    "Project Brief",
    "System Boundary",
    "PayRoost Context Boundaries",
  ]);

  const versionNumberById = new Map<string, number>();
  for (const v of rawVersions) {
    versionNumberById.set(v.id, v.version_number);
  }

  const approvedRow = rawVersions.find((v) => v.status === "APPROVED") ?? null;
  const currentRow =
    rawVersions.find((v) => v.id === agreementRow?.current_version_id) ??
    rawVersions[0] ??
    null;

  const buildVersionSummary = (
    row: (typeof rawVersions)[number] | null
  ): AssistantAgreementVersionSummary | null => {
    if (!row) return null;
    const sourceRef = `Agreement v${row.version_number} (${row.status})`;
    validSourceRefs.add(`Agreement v${row.version_number}`);
    validSourceRefs.add(sourceRef);
    return {
      versionNumber: row.version_number,
      status: row.status,
      isCurrentPointer: row.id === agreementRow?.current_version_id,
      isLatestApproved: row.id === approvedRow?.id,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      approvedAt: row.approved_at,
      approvedByRoleLabel: row.approved_by_label
        ? normalizeActorRoleLabel(row.approved_by_label)
        : null,
      sourceRef,
      draft: summarizeDraftContent(row.content),
    };
  };

  const approvedVersion = buildVersionSummary(approvedRow);
  const currentVersion =
    currentRow && currentRow.id === approvedRow?.id
      ? approvedVersion
      : buildVersionSummary(currentRow);

  const historicalVersions = rawVersions
    .filter((v) => v.id !== approvedRow?.id && v.id !== currentRow?.id)
    .slice(0, 8)
    .map((v) => {
      const sourceRef = `Agreement v${v.version_number} (${v.status})`;
      validSourceRefs.add(`Agreement v${v.version_number}`);
      validSourceRefs.add(sourceRef);
      const parsed = agreementDraftSchema.safeParse(v.content);
      return {
        versionNumber: v.version_number,
        status: v.status,
        createdAt: v.created_at,
        sentAt: v.sent_at,
        approvedAt: v.approved_at,
        approvedByRoleLabel: v.approved_by_label
          ? normalizeActorRoleLabel(v.approved_by_label)
          : null,
        summaryExcerpt: parsed.success
          ? sanitizeTextForAssistant(parsed.data.summary, 300)
          : null,
        sourceRef,
      };
    });

  // Earliest version vs current for comparison if multiple exist and approved !== current (or historical exists)
  const oldestLoadedRow = rawVersions[rawVersions.length - 1] ?? null;
  const comparisonBaseline =
    approvedVersion ??
    (oldestLoadedRow && oldestLoadedRow.id !== currentRow?.id
      ? buildVersionSummary(oldestLoadedRow)
      : null);
  const versionChangesBetweenBaselineAndCurrent = computeAgreementDiffNotes(
    comparisonBaseline,
    currentVersion
  );
  if (versionChangesBetweenBaselineAndCurrent.length > 0) {
    validSourceRefs.add("Agreement Version Comparison");
  }

  // Transactions indexed by intent ID
  const txByIntentId = new Map<string, typeof rawTransactions>();
  for (const tx of rawTransactions) {
    const arr = txByIntentId.get(tx.payment_intent_id) ?? [];
    arr.push(tx);
    txByIntentId.set(tx.payment_intent_id, arr);
  }

  // Group intents by milestone ID
  const intentsByMilestoneId = new Map<string, typeof rawIntents>();
  for (const intent of rawIntents) {
    const arr = intentsByMilestoneId.get(intent.milestone_id) ?? [];
    arr.push(intent);
    intentsByMilestoneId.set(intent.milestone_id, arr);
  }

  // Milestones assembly
  const rawMilestones = (milestonesRes.data ?? []) as Array<{
    id: string;
    agreement_version_id: string;
    sort_order: number;
    title: string;
    description: string;
    deliverables: string[] | null;
    acceptance_criteria: string[] | null;
    amount_minor: number;
    currency: string;
    due_date: string | null;
    status: string;
  }>;

  const milestoneTitleById = new Map<string, string>();
  const milestones: AssistantMilestoneSummary[] = rawMilestones.map((m, idx) => {
    const cleanTitle = sanitizeTextForAssistant(m.title, 140) || `Milestone ${idx + 1}`;
    milestoneTitleById.set(m.id, cleanTitle);

    const shortRef = `Milestone #${idx + 1}`;
    const fullRef = `Milestone #${idx + 1}: ${cleanTitle}`;
    validSourceRefs.add(shortRef);
    validSourceRefs.add(fullRef);

    const mIntents = intentsByMilestoneId.get(m.id) ?? [];
    const latestIntent = mIntents[0] ?? null;
    const latestTxs = latestIntent ? txByIntentId.get(latestIntent.id) ?? [] : [];
    const hasCompletedCapture = latestTxs.some(
      (t) => t.transaction_type === "CAPTURE" && t.status === "COMPLETED"
    );

    const paymentStateSummary = latestIntent
      ? summarizePaymentIntentStatus(latestIntent.status, hasCompletedCapture)
      : "No payment intent recorded for this milestone";

    return {
      index: idx + 1,
      sourceRef: fullRef,
      title: cleanTitle,
      status: m.status,
      deliverableStatusMeaning: summarizeMilestoneDeliverableStatus(m.status),
      description: sanitizeTextForAssistant(m.description, 500),
      deliverables: Array.isArray(m.deliverables)
        ? m.deliverables.slice(0, 12).map((d) => sanitizeTextForAssistant(d, 250))
        : [],
      acceptanceCriteria: Array.isArray(m.acceptance_criteria)
        ? m.acceptance_criteria.slice(0, 10).map((ac) => sanitizeTextForAssistant(ac, 250))
        : [],
      amountMinor: Number(m.amount_minor),
      currency: m.currency,
      dueDate: m.due_date,
      agreementVersionNumber: versionNumberById.get(m.agreement_version_id) ?? null,
      paymentStateSummary,
      hasActiveOrCompletedPaymentIntent: Boolean(
        latestIntent &&
          [
            "ORDER_CREATING",
            "ORDER_CREATED",
            "BUYER_APPROVED",
            "CAPTURING",
            "RECONCILING",
            "RECONCILIATION_REQUIRED",
            "COMPLETED",
          ].includes(latestIntent.status)
      ),
    };
  });

  // Payment records assembly
  const paymentRecords: AssistantPaymentRecordSummary[] = rawIntents.map((intent, idx) => {
    const mTitle = milestoneTitleById.get(intent.milestone_id) ?? "Milestone";
    const txs = txByIntentId.get(intent.id) ?? [];
    const hasCompletedCapture = txs.some(
      (t) => t.transaction_type === "CAPTURE" && t.status === "COMPLETED"
    );
    const shortRef = `Payment Intent #${idx + 1}`;
    const fullRef = `Payment Record (${mTitle})`;
    validSourceRefs.add(shortRef);
    validSourceRefs.add(fullRef);

    return {
      index: idx + 1,
      sourceRef: shortRef,
      milestoneTitle: mTitle,
      intentStatus: intent.status,
      statusExplanation: summarizePaymentIntentStatus(intent.status, hasCompletedCapture),
      amountMinor: Number(intent.expected_amount_cents),
      currency: intent.expected_currency,
      provider: intent.provider,
      buyerApprovedAt: intent.buyer_approved_at,
      completedAt: intent.completed_at,
      verificationNote: summarizeReconciliationStatusForRole(
        intent.status,
        intent.reconciliation_reason,
        params.participantRole
      ),
      transactions: txs.slice(0, 6).map((t) => ({
        transactionType: t.transaction_type,
        status: t.status,
        amountMinor: Number(t.amount_cents),
        currency: t.currency,
        capturedAt: t.captured_at,
      })),
    };
  });

  if (paymentRecords.length > 0) {
    validSourceRefs.add("Payment Ledger");
    validSourceRefs.add("Payment Ledger Summary");
  }

  const hasAnyCompletedCapture = paymentRecords.some(
    (p) =>
      p.intentStatus === "COMPLETED" ||
      p.transactions.some((t) => t.transactionType === "CAPTURE" && t.status === "COMPLETED")
  );
  const hasAnyPendingVerificationOrReconciliation = paymentRecords.some(
    (p) =>
      ["CAPTURING", "RECONCILING", "RECONCILIATION_REQUIRED"].includes(p.intentStatus) ||
      p.transactions.some((t) => t.status === "PENDING")
  );
  const hasAnyBuyerApprovedUncaptured = paymentRecords.some(
    (p) => p.intentStatus === "BUYER_APPROVED"
  );

  // Change requests assembly
  const rawChangeRequests = (changeRequestsRes.data ?? []) as Array<{
    id: string;
    agreement_version_id: string;
    request_text: string;
    submitted_by_label: string;
    status: string;
    created_at: string;
    resolved_at: string | null;
    ai_analysis: unknown;
    ai_analyzed_at: string | null;
    ai_model: string | null;
  }>;

  const changeRequests: AssistantChangeRequestSummary[] = rawChangeRequests.map((cr, idx) => {
    const shortRef = `Change Request #${idx + 1}`;
    const fullRef = `Change Request #${idx + 1} (${cr.status})`;
    validSourceRefs.add(shortRef);
    validSourceRefs.add(fullRef);

    const parsedAi = storedScopeChangeAnalysisSchema.safeParse(cr.ai_analysis);
    const aiProposalSourceRef = parsedAi.success ? `Change Request #${idx + 1} AI Analysis` : null;
    if (aiProposalSourceRef) {
      validSourceRefs.add(aiProposalSourceRef);
    }

    return {
      index: idx + 1,
      sourceRef: fullRef,
      aiProposalSourceRef,
      agreementVersionNumber: versionNumberById.get(cr.agreement_version_id) ?? null,
      submittedByRoleLabel: normalizeActorRoleLabel(cr.submitted_by_label),
      status: cr.status,
      createdAt: cr.created_at,
      resolvedAt: cr.resolved_at,
      originalRequestText: sanitizeTextForAssistant(cr.request_text, 1000),
      contractualEffectNote:
        "Submitted change requests (even if marked RESOLVED) do NOT amend contractual terms unless a formal new agreement version is approved.",
      persistedAiAdvice: parsedAi.success
        ? {
            isAiGeneratedAdviceOnly: true,
            analyzedAt: cr.ai_analyzed_at ?? parsedAi.data.snapshotMetadata.analyzedAt,
            model: cr.ai_model ?? parsedAi.data.snapshotMetadata.model,
            overallClassification: parsedAi.data.overallClassification,
            requestedChangeSummary: sanitizeTextForAssistant(
              parsedAi.data.changeSummary.requestedChangeSummary,
              500
            ),
            financialDirection: parsedAi.data.financialImpact.direction,
            proposedCostDeltaMinor: parsedAi.data.financialImpact.proposedCostDeltaMinor,
            currency: parsedAi.data.financialImpact.currency,
            timelineClassification: parsedAi.data.timelineImpact.classification,
            estimatedAdditionalDaysMin: parsedAi.data.timelineImpact.estimatedAdditionalDaysMin,
            estimatedAdditionalDaysMax: parsedAi.data.timelineImpact.estimatedAdditionalDaysMax,
            unresolvedQuestions: parsedAi.data.unresolvedQuestions
              .slice(0, 5)
              .map((q) => sanitizeTextForAssistant(q, 240)),
            recommendedNextSteps: parsedAi.data.recommendedNextSteps
              .slice(0, 4)
              .map((s) => sanitizeTextForAssistant(s, 240)),
          }
        : null,
    };
  });

  // Activity events assembly
  const rawActivities = (activityRes.data ?? []) as Array<{
    id: string;
    actor_label: string;
    event_type: string;
    summary: string;
    created_at: string;
  }>;

  const activities: AssistantActivitySummary[] = rawActivities.map((a) => ({
    createdAt: a.created_at,
    actorRoleLabel: normalizeActorRoleLabel(a.actor_label),
    eventType: sanitizeTextForAssistant(a.event_type, 80),
    summary: sanitizeTextForAssistant(a.summary, 360),
  }));
  if (activities.length > 0) {
    validSourceRefs.add("Activity Log");
  }

  // Deterministic outstanding items, conflicts & PayRoost record boundaries
  const outstandingItems: string[] = [];
  if (!project.client_email_verified_at) {
    outstandingItems.push("Client email verification is still pending.");
  }
  if (!currentVersion) {
    outstandingItems.push("No agreement version has been created or saved yet.");
  } else if (currentVersion.status === "PENDING_CLIENT") {
    outstandingItems.push(
      `Client review and OTP decision are pending on Agreement v${currentVersion.versionNumber}.`
    );
  } else if (currentVersion.status === "CHANGES_REQUESTED") {
    outstandingItems.push(
      `Client requested changes on Agreement v${currentVersion.versionNumber}; freelancer revision is needed.`
    );
  } else if (currentVersion.status === "DRAFT") {
    outstandingItems.push(
      `Agreement v${currentVersion.versionNumber} is still a DRAFT and has not been sent for client approval.`
    );
  }

  for (const cr of changeRequests) {
    if (cr.status === "OPEN") {
      outstandingItems.push(`Open scope-change request (${cr.sourceRef}) is awaiting resolution.`);
    }
  }

  for (const m of milestones) {
    if (m.status === "SUBMITTED") {
      outstandingItems.push(`${m.sourceRef} is SUBMITTED and awaiting client review/acceptance.`);
    } else if (m.status === "CHANGES_REQUESTED") {
      outstandingItems.push(`${m.sourceRef} has CHANGES_REQUESTED.`);
    }
  }

  if (approvedVersion?.draft?.openQuestions.length) {
    outstandingItems.push(
      `Agreement v${approvedVersion.versionNumber} lists ${approvedVersion.draft.openQuestions.length} open question(s).`
    );
  } else if (currentVersion?.draft?.openQuestions.length) {
    outstandingItems.push(
      `Agreement v${currentVersion.versionNumber} lists ${currentVersion.draft.openQuestions.length} open question(s).`
    );
  }

  const detectedConflicts: string[] = [];
  const activeMilestones = milestones.filter((m) => m.status !== "CANCELLED");
  if (activeMilestones.length > 0) {
    const milestoneSum = activeMilestones.reduce((acc, m) => acc + BigInt(m.amountMinor), 0n);
    if (milestoneSum !== BigInt(project.total_amount_minor)) {
      detectedConflicts.push(
        `Project total budget (${project.total_amount_minor} ${project.currency}) differs from the sum of non-cancelled milestones (${milestoneSum.toString()} ${project.currency}).`
      );
    }
  }

  if (
    approvedVersion &&
    currentVersion &&
    currentVersion.versionNumber !== approvedVersion.versionNumber &&
    ["DRAFT", "PENDING_CLIENT", "CHANGES_REQUESTED"].includes(currentVersion.status)
  ) {
    detectedConflicts.push(
      `Agreement v${approvedVersion.versionNumber} (APPROVED) remains the active contractual baseline while Agreement v${currentVersion.versionNumber} (${currentVersion.status}) has not been mutually approved.`
    );
  }

  if (hasAnyPendingVerificationOrReconciliation) {
    detectedConflicts.push(
      "At least one payment intent is pending provider capture or reconciliation verification and must not be treated as paid."
    );
  }
  if (hasAnyBuyerApprovedUncaptured) {
    detectedConflicts.push(
      "At least one payment intent is BUYER_APPROVED at checkout but NOT yet captured in PayRoost's payment ledger."
    );
  }

  const dataLimitations: string[] = [
    "PayRoost tracks deliverable submission and acceptance via milestone statuses (e.g. SUBMITTED, ACCEPTED); there is no separate deliverable file upload log.",
    "PayRoost tracks payment order approval, capture verification, pending verification/reconciliation, and refunds on payment_intents and payment_transactions, and does NOT track downstream bank/PayPal seller payout disbursement or bank settlement completion.",
    "No AI chat transcripts are persisted in PayRoost's database; this conversation exists only in the current browser session.",
  ];

  const openChangeRequestCount = changeRequests.filter((cr) => cr.status === "OPEN").length;

  return {
    ok: true,
    context: {
      participantRole: params.participantRole,
      project: {
        id: project.id,
        title: sanitizeTextForAssistant(project.title, 160),
        status: project.status,
        clientName: sanitizeTextForAssistant(project.client_name, 140),
        clientVerified: Boolean(project.client_email_verified_at),
        currency: project.currency,
        confirmedBudgetMinor: Number(project.total_amount_minor),
        startDate: project.start_date,
        targetEndDate: project.target_end_date,
        briefText: sanitizeTextForAssistant(project.brief, 4000),
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      },
      agreement: {
        status: agreementRow?.status ?? null,
        approvedVersionNumber: approvedVersion?.versionNumber ?? null,
        currentVersionNumber: currentVersion?.versionNumber ?? null,
        totalVersionCount: rawVersions.length,
        approvedVersion,
        currentVersion,
        historicalVersions,
        versionChangesBetweenBaselineAndCurrent,
      },
      milestones,
      changeRequests,
      payments: {
        records: paymentRecords,
        hasAnyCompletedCapture,
        hasAnyPendingVerificationOrReconciliation,
        hasAnyBuyerApprovedUncaptured,
        ledgerCapabilitiesNote:
          "Recorded payment ledger tracks checkout order creation, BUYER_APPROVED, CAPTURING/RECONCILING/RECONCILIATION_REQUIRED, and verified provider CAPTURE/REFUND/REVERSAL records. Downstream PayPal-to-bank seller settlement/payout disbursement is NOT tracked in PayRoost records.",
      },
      activities,
      outstandingItems,
      detectedConflicts,
      dataLimitations,
      validSourceRefs: Array.from(validSourceRefs),
      stats: {
        approvedAgreementVersion: approvedVersion?.versionNumber ?? null,
        currentAgreementVersion: currentVersion?.versionNumber ?? null,
        milestoneCount: milestones.length,
        openChangeRequestCount,
        recordedPaymentIntentCount: paymentRecords.length,
      },
    },
  };
}
