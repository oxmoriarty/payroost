import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as scopeService from "@/features/scope-changes/service";
import type { StoredScopeChangeAnalysis } from "@/features/scope-changes/schema";
import {
  AiConfigurationError,
  AiFinancialReconciliationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  allowRequest: vi.fn(),
}));

describe("POST /api/ai/analyze-scope-change (AI-5 Freelancer Preview)", () => {
  const validProjectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const validAgreementId = "a1111111-1111-4111-8111-111111111111";
  const validVersionId = "b2222222-2222-4222-8222-222222222222";
  const foreignVersionId = "c3333333-3333-4333-8333-333333333333";

  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  const sampleAnalysis: StoredScopeChangeAnalysis = {
    changeSummary: {
      requestedChangeSummary: "Add export scheduler and SAML integration.",
      changeType: "ADDITION",
      conflictsOrContradictions: [],
    },
    originalAgreementContext: {
      agreementVersionNumber: 1,
      agreementStatus: "APPROVED",
      confirmedBudgetMinor: 200000,
      currency: "USD",
      summaryExcerpt: "Approved agreement v1.",
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
      existingAgreedBudgetMinor: 200000,
      currency: "USD",
      proposedCostDeltaMinor: 40000,
      proposedRevisedTotalMinor: 240000,
      costDriversJustification: "Covers scheduled exports.",
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
      criticalPathMilestones: [],
      missingSchedulingInformation: [],
      explanation: "Adds ~1 week.",
    },
    dependencyChanges: [],
    riskAssessment: [],
    assumptions: [],
    unresolvedQuestions: [],
    recommendedNextSteps: ["Review proposal with client."],
    overallClassification: "HIGH",
    classificationCriteria: ["20%+ proposed budget increase."],
    snapshotMetadata: {
      analyzedRequestTextSha256: "a".repeat(64),
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "OWNER",
      analyzedAt: "2026-11-11T10:00:00.000Z",
      model: "gemini-3.8-flash",
      integrityTag: "b".repeat(64),
      isProposalOnly: true,
    },
  };

  let insertedTables: string[];
  let updatedTables: string[];

  function setupMockDb(options?: {
    projectOwnerId?: string;
    projectError?: boolean;
    versions?: Array<Record<string, unknown>>;
    intents?: Array<Record<string, unknown>>;
  }) {
    const projectOwnerId = options?.projectOwnerId ?? mockUser.id;
    const versions = options?.versions ?? [
      {
        id: validVersionId,
        agreement_id: validAgreementId,
        version_number: 1,
        content: { summary: "Approved agreement summary" },
        content_hash: "h".repeat(64),
        status: "APPROVED",
      },
    ];
    const intents = options?.intents ?? [
      { milestone_id: "m-1", status: "COMPLETED" },
    ];

    mockFrom.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        insert: vi.fn((payload: unknown) => {
          insertedTables.push(table);
          void payload;
          return builder;
        }),
        update: vi.fn(() => {
          updatedTables.push(table);
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          if (table === "projects") {
            if (options?.projectError) {
              return { data: null, error: { message: "DB error" } };
            }
            return {
              data: {
                id: validProjectId,
                owner_id: projectOwnerId,
                title: "Acme Dashboard",
                client_name: "Acme",
                client_email: "client@acme.com",
                brief: "Build Acme dashboard.",
                currency: "USD",
                total_amount_minor: 200000,
                status: "ACTIVE",
                start_date: "2026-11-15",
                target_end_date: "2026-12-20",
              },
              error: null,
            };
          }
          if (table === "agreements") {
            return {
              data: {
                id: validAgreementId,
                status: "APPROVED",
                current_version_id: validVersionId,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        }),
        then: (resolve: (val: unknown) => void) => {
          if (table === "agreement_versions") {
            resolve({ data: versions, error: null });
          } else if (table === "milestones") {
            resolve({
              data: [
                {
                  id: "m-1",
                  title: "Milestone 1: Onboarding",
                  description: "Initial wizard",
                  status: "ACCEPTED",
                  sort_order: 1,
                  amount_minor: 200000,
                  currency: "USD",
                  due_date: "2026-12-01",
                  deliverables: ["Wizard UI"],
                },
              ],
              error: null,
            });
          } else if (table === "payment_intents") {
            resolve({ data: intents, error: null });
          } else if (table === "change_requests") {
            resolve({ data: [], error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return builder;
    });
  }

  function makeReq(body: unknown) {
    return new Request("http://localhost:3000/api/ai/analyze-scope-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    insertedTables = [];
    updatedTables = [];
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    vi.spyOn(rateLimitModule, "allowRequest").mockResolvedValue(true);
    setupMockDb();
  });

  it("rejects unauthenticated requests with 401 and rate-limited requests with 429", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res401 = await POST(
      makeReq({ projectId: validProjectId, requestText: "Add dark mode support." })
    );
    expect(res401.status).toBe(401);

    vi.spyOn(rateLimitModule, "allowRequest").mockResolvedValueOnce(false);
    const res429 = await POST(
      makeReq({ projectId: validProjectId, requestText: "Add dark mode support." })
    );
    expect(res429.status).toBe(429);
  });

  it("rejects browser-supplied financial fields via .strict() and separates DB failures (500) from ownership errors (403)", async () => {
    const resStrict = await POST(
      makeReq({
        projectId: validProjectId,
        requestText: "Add dark mode",
        totalAmountMinor: 999999,
      })
    );
    expect(resStrict.status).toBe(400);

    setupMockDb({ projectError: true });
    const resDbErr = await POST(
      makeReq({ projectId: validProjectId, requestText: "Add dark mode support." })
    );
    expect(resDbErr.status).toBe(500);

    setupMockDb({ projectOwnerId: "other-owner-uuid" });
    const resForbidden = await POST(
      makeReq({ projectId: validProjectId, requestText: "Add dark mode support." })
    );
    expect(resForbidden.status).toBe(403);
  });

  it("rejects cross-project agreementVersionId with 403 and missing agreement versions with 409", async () => {
    setupMockDb();
    const resCrossVersion = await POST(
      makeReq({
        projectId: validProjectId,
        agreementVersionId: foreignVersionId,
        requestText: "Extend analytics page.",
      })
    );
    expect(resCrossVersion.status).toBe(403);

    setupMockDb({ versions: [] });
    const resNoVersion = await POST(
      makeReq({
        projectId: validProjectId,
        requestText: "Extend analytics page.",
      })
    );
    expect(resNoVersion.status).toBe(409);
  });

  it("performs preview-only analysis without mutating change_requests, agreements, milestones, or payments", async () => {
    const analyzeSpy = vi.spyOn(scopeService, "analyzeScopeChange").mockResolvedValue({
      analysis: sampleAnalysis,
      model: "gemini-3.8-flash",
      durationMs: 180,
    });

    const res = await POST(
      makeReq({
        projectId: validProjectId,
        agreementVersionId: validVersionId,
        requestText: "Add export scheduler and SAML integration.",
      })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        preview: boolean;
        persisted: boolean;
        agreementVersionId: string;
        analysis: StoredScopeChangeAnalysis;
      };
    };
    expect(json.data.preview).toBe(true);
    expect(json.data.persisted).toBe(false);
    expect(json.data.agreementVersionId).toBe(validVersionId);
    expect(json.data.analysis.overallClassification).toBe("HIGH");

    // Passes payment lock derived from COMPLETED payment_intent on Milestone 1
    expect(analyzeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterRole: "OWNER",
        confirmedBudgetMinor: 200000,
        establishedCurrency: "USD",
        milestones: expect.arrayContaining([
          expect.objectContaining({
            title: "Milestone 1: Onboarding",
            isPaymentLinkedOrLocked: true,
          }),
        ]),
      }),
      { userId: mockUser.id }
    );

    // Zero DB mutations on preview
    expect(insertedTables).toEqual([]);
    expect(updatedTables).toEqual([]);
  });

  it("normalizes AI configuration, rate-limit, unavailable, and validation/reconciliation errors", async () => {
    vi.spyOn(scopeService, "analyzeScopeChange").mockRejectedValueOnce(
      new AiConfigurationError("Missing key")
    );
    expect(
      (
        await POST(
          makeReq({ projectId: validProjectId, requestText: "Add audit dashboard." })
        )
      ).status
    ).toBe(500);

    vi.spyOn(scopeService, "analyzeScopeChange").mockRejectedValueOnce(
      new AiRateLimitError("Quota exceeded")
    );
    expect(
      (
        await POST(
          makeReq({ projectId: validProjectId, requestText: "Add audit dashboard." })
        )
      ).status
    ).toBe(429);

    vi.spyOn(scopeService, "analyzeScopeChange").mockRejectedValueOnce(
      new AiUnavailableError("Upstream timeout", { isTimeout: true })
    );
    expect(
      (
        await POST(
          makeReq({ projectId: validProjectId, requestText: "Add audit dashboard." })
        )
      ).status
    ).toBe(503);

    vi.spyOn(scopeService, "analyzeScopeChange").mockRejectedValueOnce(
      new AiFinancialReconciliationError("Budget mismatch", {
        expectedTotalMinor: 200000,
        actualTotalMinor: 199000,
        currency: "USD",
      })
    );
    expect(
      (
        await POST(
          makeReq({ projectId: validProjectId, requestText: "Add audit dashboard." })
        )
      ).status
    ).toBe(422);
  });
});
