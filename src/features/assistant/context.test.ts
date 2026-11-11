import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleProjectAssistantContext } from "./context";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signScopeChangeAnalysisSnapshot } from "@/features/scope-changes/snapshot";
import type { ScopeChangeAnalysis } from "@/features/scope-changes/schema";

const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const ownerId = "u0000000-0000-4000-a000-000000000001";
const agreementId = "a1111111-1111-4111-8111-111111111111";
const v1Id = "b1111111-1111-4111-8111-111111111111";
const v2Id = "b2222222-2222-4222-8222-222222222222";
const m1Id = "m1111111-1111-4111-8111-111111111111";
const m2Id = "m2222222-2222-4222-8222-222222222222";
const pi1Id = "p1111111-1111-4111-8111-111111111111";
const pi2Id = "p2222222-2222-4222-8222-222222222222";

const sampleScopeAnalysis: ScopeChangeAnalysis = {
  changeSummary: {
    requestedChangeSummary: "Add OAuth SSO login and audit export.",
    changeType: "ADDITION",
    conflictsOrContradictions: [],
  },
  originalAgreementContext: {
    agreementVersionNumber: 1,
    agreementStatus: "APPROVED",
    confirmedBudgetMinor: 300000,
    currency: "USD",
    summaryExcerpt: "Approved v1 contract baseline.",
  },
  affectedDeliverables: [],
  affectedMilestones: [],
  proposedChanges: {
    newDeliverables: [],
    removedOrReplacedWork: [],
    proposedNewMilestones: [],
  },
  financialImpact: {
    direction: "INCREASE",
    existingAgreedBudgetMinor: 300000,
    currency: "USD",
    proposedCostDeltaMinor: 50000,
    proposedRevisedTotalMinor: 350000,
    costDriversJustification: "SSO integration engineering.",
    reconcilesExistingMilestonesUnchanged: true,
    requiresHumanReviewNotice:
      "AI-generated financial and scope estimate only — requires mutual human review.",
  },
  timelineImpact: {
    classification: "POTENTIAL_EXTENSION",
    estimatedAdditionalDaysMin: 4,
    estimatedAdditionalDaysMax: 6,
    canProceedInParallel: false,
    parallelWorkNotes: null,
    criticalPathMilestones: ["Milestone 2: Billing Portal"],
    missingSchedulingInformation: [],
    explanation: "Adds 4-6 days to Milestone 2 schedule.",
  },
  dependencyChanges: [],
  riskAssessment: [],
  assumptions: [],
  unresolvedQuestions: ["Which IdP should be prioritized first?"],
  recommendedNextSteps: ["Create v2 agreement draft for bilateral sign-off."],
  overallClassification: "MODERATE",
  classificationCriteria: ["Proposes incremental budget addition (+50000 USD)."],
};

function makeDraftContent(overrides?: {
  summary?: string;
  dueDate?: string | null;
  amount2?: number;
  extraScope?: boolean;
}) {
  return {
    summary: overrides?.summary ?? "Build client portal MVP in two milestones.",
    objective: "Deliver secure client onboarding and billing UI.",
    scopeItems: [
      {
        id: "s-1",
        title: "Core Onboarding",
        description: "Auth and profile setup.",
        deliverables: ["Login flow", "Workspace shell"],
        acceptanceCriteria: ["Tests pass"],
        assumptions: ["Branding finalized"],
      },
      ...(overrides?.extraScope
        ? [
            {
              id: "s-2",
              title: "SAML Enterprise SSO",
              description: "Enterprise SAML login.",
              deliverables: ["SAML ACS endpoint"],
              acceptanceCriteria: ["Okta SSO verified"],
              assumptions: [],
            },
          ]
        : []),
    ],
    exclusions: ["Native mobile apps"],
    milestones: [
      {
        id: "ms-1",
        title: "Milestone 1: Onboarding",
        description: "Core onboarding screens.",
        amountMinor: 150000,
        currency: "USD",
        dueDate: "2026-12-01",
        deliverables: ["Login flow"],
        acceptanceCriteria: ["Verified flow"],
      },
      {
        id: "ms-2",
        title: "Milestone 2: Billing Portal",
        description: "Invoice and billing UI.",
        amountMinor: overrides?.amount2 ?? 150000,
        currency: "USD",
        dueDate: overrides?.dueDate !== undefined ? overrides.dueDate : "2026-12-20",
        deliverables: ["Billing dashboard"],
        acceptanceCriteria: ["Exports accurate"],
      },
    ],
    timeline: [
      {
        label: "Target Launch",
        date: overrides?.dueDate !== undefined ? overrides.dueDate : "2026-12-20",
        notes: "Initial schedule.",
      },
    ],
    clientResponsibilities: ["Provide sandbox API credentials"],
    freelancerResponsibilities: ["Deliver tested Next.js implementation"],
    paymentTerms: ["Milestone releases via PayPal upon deliverable submission"],
    revisionPolicy: ["Two revision rounds included per milestone"],
    changeProcess: ["Written scope change review required prior to work"],
    terminationNotes: ["Settled work remains billable"],
    disputeResolution: ["Good faith escalation"],
    openQuestions: ["Preferred SSO launch window?"],
    warnings: [],
  };
}

function createMockSupabase(options?: {
  budgetMismatch?: boolean;
  includeReconciliationReason?: boolean;
}) {
  const selectedColumnsByTable: Record<string, string[]> = {};
  const signedAnalysis = signScopeChangeAnalysisSnapshot({
    analysis: sampleScopeAnalysis,
    requestText: "Add OAuth SSO login with Okta for enterprise team.",
    agreementVersionId: v1Id,
    agreementVersionNumber: 1,
    projectId,
    requesterRole: "CLIENT",
    model: "gemini-3.8-flash",
    analyzedAt: "2026-11-11T10:15:00.000Z",
  });

  const client = {
    from: vi.fn((table: string) => {
      const builder: Record<string, unknown> = {
        select: vi.fn((cols: string) => {
          selectedColumnsByTable[table] = [...(selectedColumnsByTable[table] ?? []), cols];
          return builder;
        }),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => {
          if (table === "projects") {
            return {
              data: {
                id: projectId,
                owner_id: ownerId,
                title: "Acme Billing Workspace",
                client_name: "Acme Corp",
                client_email: "buyer@acme.example",
                client_email_verified_at: "2026-11-01T10:00:00.000Z",
                brief:
                  "Structured brief: contact buyer@acme.example with api_key=AIzaSySecretKey1234567890123456789012 for webhook.",
                currency: "USD",
                total_amount_minor: options?.budgetMismatch ? 400000 : 300000,
                status: "ACTIVE",
                start_date: "2026-11-01",
                target_end_date: "2026-12-20",
                created_at: "2026-11-01T09:00:00.000Z",
                updated_at: "2026-11-10T10:00:00.000Z",
              },
              error: null,
            };
          }
          if (table === "agreements") {
            return {
              data: {
                id: agreementId,
                status: "APPROVED",
                current_version_id: v2Id,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        }),
        then: (resolve: (val: unknown) => void) => {
          if (table === "agreement_versions") {
            resolve({
              data: [
                {
                  id: v2Id,
                  agreement_id: agreementId,
                  version_number: 2,
                  content: makeDraftContent({
                    summary: "Updated v2 draft adding SAML SSO.",
                    dueDate: "2026-12-28",
                    amount2: 200000,
                    extraScope: true,
                  }),
                  status: "PENDING_CLIENT",
                  created_at: "2026-11-10T10:00:00.000Z",
                  sent_at: "2026-11-10T11:00:00.000Z",
                  approved_at: null,
                  approved_by_label: null,
                },
                {
                  id: v1Id,
                  agreement_id: agreementId,
                  version_number: 1,
                  content: makeDraftContent(),
                  status: "APPROVED",
                  created_at: "2026-11-01T12:00:00.000Z",
                  sent_at: "2026-11-01T13:00:00.000Z",
                  approved_at: "2026-11-02T09:00:00.000Z",
                  approved_by_label: "Client (buyer@acme.example)",
                },
              ],
              error: null,
            });
            return;
          }
          if (table === "milestones") {
            resolve({
              data: [
                {
                  id: m1Id,
                  agreement_version_id: v1Id,
                  sort_order: 1,
                  title: "Milestone 1: Onboarding",
                  description: "Onboarding screens.",
                  deliverables: ["Login flow"],
                  acceptance_criteria: ["Tests pass"],
                  amount_minor: 150000,
                  currency: "USD",
                  due_date: "2026-12-01",
                  status: "ACCEPTED",
                },
                {
                  id: m2Id,
                  agreement_version_id: v1Id,
                  sort_order: 2,
                  title: "Milestone 2: Billing Portal",
                  description: "Billing UI.",
                  deliverables: ["Billing dashboard"],
                  acceptance_criteria: ["Exports accurate"],
                  amount_minor: 150000,
                  currency: "USD",
                  due_date: "2026-12-20",
                  status: "SUBMITTED",
                },
              ],
              error: null,
            });
            return;
          }
          if (table === "change_requests") {
            resolve({
              data: [
                {
                  id: "cr-1",
                  agreement_version_id: v1Id,
                  request_text: "Add OAuth SSO login with Okta for enterprise team.",
                  submitted_by_label: "Client (buyer@acme.example)",
                  status: "OPEN",
                  created_at: "2026-11-09T14:00:00.000Z",
                  resolved_at: null,
                  ai_analysis: signedAnalysis,
                  ai_analyzed_at: "2026-11-11T10:15:00.000Z",
                  ai_model: "gemini-3.8-flash",
                },
              ],
              error: null,
            });
            return;
          }
          if (table === "payment_intents") {
            resolve({
              data: [
                {
                  id: pi1Id,
                  milestone_id: m1Id,
                  agreement_version_id: v1Id,
                  status: "COMPLETED",
                  expected_currency: "USD",
                  expected_amount_cents: 150000,
                  provider: "PAYPAL",
                  buyer_approved_at: "2026-11-05T10:00:00.000Z",
                  completed_at: "2026-11-05T10:01:00.000Z",
                  reconciliation_reason: null,
                  created_at: "2026-11-05T09:55:00.000Z",
                },
                {
                  id: pi2Id,
                  milestone_id: m2Id,
                  agreement_version_id: v1Id,
                  status: "RECONCILIATION_REQUIRED",
                  expected_currency: "USD",
                  expected_amount_cents: 150000,
                  provider: "PAYPAL",
                  buyer_approved_at: "2026-11-08T10:00:00.000Z",
                  completed_at: null,
                  reconciliation_reason: options?.includeReconciliationReason
                    ? "PAYPAL_CAPTURE_MERCHANT_MISMATCH_SELLER_M123"
                    : "PAYPAL_CAPTURE_PENDING",
                  created_at: "2026-11-08T09:50:00.000Z",
                },
              ],
              error: null,
            });
            return;
          }
          if (table === "payment_transactions") {
            resolve({
              data: [
                {
                  id: "tx-1",
                  payment_intent_id: pi1Id,
                  parent_transaction_id: null,
                  transaction_type: "CAPTURE",
                  status: "COMPLETED",
                  amount_cents: 150000,
                  currency: "USD",
                  captured_at: "2026-11-05T10:01:00.000Z",
                },
                {
                  id: "tx-2",
                  payment_intent_id: pi2Id,
                  parent_transaction_id: null,
                  transaction_type: "CAPTURE",
                  status: "PENDING",
                  amount_cents: 150000,
                  currency: "USD",
                  captured_at: "2026-11-08T10:01:00.000Z",
                },
              ],
              error: null,
            });
            return;
          }
          if (table === "activity_events") {
            resolve({
              data: [
                {
                  id: "act-1",
                  actor_label: "Freelancer (dev@payroost.test)",
                  event_type: "agreement.version_sent",
                  summary: "Sent v2 draft to buyer@acme.example for OTP review.",
                  created_at: "2026-11-10T11:00:00.000Z",
                },
              ],
              error: null,
            });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return builder;
    }),
  } as unknown as SupabaseClient;

  return { client, selectedColumnsByTable };
}

describe("assembleProjectAssistantContext (AI-6)", () => {
  const originalSnapshotSecret = process.env.PAYROOST_AI_SNAPSHOT_SECRET;
  const testSnapshotSecret = "test-assistant-context-snapshot-secret-32-bytes!!";

  beforeEach(() => {
    process.env.PAYROOST_AI_SNAPSHOT_SECRET = testSnapshotSecret;
  });

  afterEach(() => {
    if (originalSnapshotSecret === undefined) {
      delete process.env.PAYROOST_AI_SNAPSHOT_SECRET;
    } else {
      process.env.PAYROOST_AI_SNAPSHOT_SECRET = originalSnapshotSecret;
    }
  });

  it("enforces owner and client authorization before returning project context", async () => {
    const { client } = createMockSupabase();

    const wrongOwner = await assembleProjectAssistantContext(client, {
      projectId,
      participantRole: "OWNER",
      expectedOwnerId: "other-user-uuid",
    });
    expect(wrongOwner).toEqual({ ok: false, code: "FORBIDDEN", status: 403 });

    const wrongClient = await assembleProjectAssistantContext(client, {
      projectId,
      participantRole: "CLIENT",
      expectedClientEmail: "attacker@evil.example",
    });
    expect(wrongClient).toEqual({ ok: false, code: "FORBIDDEN", status: 403 });
  });

  it("distinguishes APPROVED vs PENDING_CLIENT agreement versions, computes diff notes, separates human request_text from AI scope advice, and detects budget/payment conflicts", async () => {
    const { client, selectedColumnsByTable } = createMockSupabase({
      budgetMismatch: true,
    });

    const res = await assembleProjectAssistantContext(client, {
      projectId,
      participantRole: "OWNER",
      expectedOwnerId: ownerId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ctx = res.context;

    // Distinguishes approved baseline v1 from current unapproved v2
    expect(ctx.agreement.approvedVersionNumber).toBe(1);
    expect(ctx.agreement.currentVersionNumber).toBe(2);
    expect(ctx.agreement.approvedVersion?.status).toBe("APPROVED");
    expect(ctx.agreement.currentVersion?.status).toBe("PENDING_CLIENT");
    expect(
      ctx.agreement.versionChangesBetweenBaselineAndCurrent.some((d) =>
        d.includes("SAML Enterprise SSO")
      )
    ).toBe(true);
    expect(
      ctx.agreement.versionChangesBetweenBaselineAndCurrent.some((d) =>
        d.includes("2026-12-28")
      )
    ).toBe(true);

    // Separates original change request text from AI-generated advice
    expect(ctx.changeRequests[0]?.originalRequestText).toContain("Add OAuth SSO login");
    expect(ctx.changeRequests[0]?.persistedAiAdvice?.isAiGeneratedAdviceOnly).toBe(true);
    expect(ctx.changeRequests[0]?.persistedAiAdvice?.proposedCostDeltaMinor).toBe(50000);

    // Distinguishes capture verification vs pending reconciliation & ledger boundary
    expect(ctx.payments.hasAnyCompletedCapture).toBe(true);
    expect(ctx.payments.hasAnyPendingVerificationOrReconciliation).toBe(true);
    expect(ctx.payments.ledgerCapabilitiesNote).toContain("NOT tracked");
    expect(ctx.payments.records[0]?.statusExplanation).toContain(
      "does not verify downstream bank payout settlement"
    );
    expect(ctx.payments.records[1]?.statusExplanation).toContain(
      "RECONCILIATION_REQUIRED"
    );

    // Conflicts surface project budget mismatch & unapproved v2 alongside v1
    expect(
      ctx.detectedConflicts.some((c) => c.includes("400000 USD") && c.includes("300000 USD"))
    ).toBe(true);
    expect(
      ctx.detectedConflicts.some((c) => c.includes("Agreement v1 (APPROVED)"))
    ).toBe(true);

    // Never queries sensitive PayPal merchant IDs, raw payloads, or user/session secrets
    expect(selectedColumnsByTable["payment_intents"]?.[0]).not.toContain("expected_merchant_id");
    expect(selectedColumnsByTable["payment_intents"]?.[0]).not.toContain("canonical_payload_json");
    expect(selectedColumnsByTable["payment_transactions"]?.[0]).not.toContain("payee_merchant_id");
    expect(selectedColumnsByTable["payment_transactions"]?.[0]).not.toContain("raw_response");
    expect(selectedColumnsByTable["agreement_versions"]?.[0]).not.toContain("created_by");
    expect(selectedColumnsByTable["freelancer_paypal_accounts"]).toBeUndefined();
  });

  it("redacts emails, API keys, and internal PayPal diagnostics in Client Portal context", async () => {
    const { client } = createMockSupabase({
      includeReconciliationReason: true,
    });

    const res = await assembleProjectAssistantContext(client, {
      projectId,
      participantRole: "CLIENT",
      expectedClientEmail: "buyer@acme.example",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const serialized = JSON.stringify(res.context);
    expect(serialized).not.toContain("AIzaSySecretKey");
    expect(serialized).not.toContain("buyer@acme.example");
    expect(serialized).not.toContain("dev@payroost.test");
    expect(serialized).not.toContain("PAYPAL_CAPTURE_MERCHANT_MISMATCH_SELLER_M123");
    expect(res.context.payments.records[1]?.verificationNote).toBe(
      "Verification with payment provider is still pending"
    );
  });
});
