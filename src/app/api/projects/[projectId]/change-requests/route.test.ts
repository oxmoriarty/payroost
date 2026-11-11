import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { PATCH } from "./[changeRequestId]/route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import { signScopeChangeAnalysisSnapshot } from "@/features/scope-changes/snapshot";
import type { ScopeChangeAnalysis } from "@/features/scope-changes/schema";

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

describe("/api/projects/[projectId]/change-requests & [changeRequestId] (AI-5)", () => {
  const validProjectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const otherProjectId = "e1111111-1111-4111-8111-111111111111";
  const validAgreementId = "a1111111-1111-4111-8111-111111111111";
  const validVersionId = "b2222222-2222-4222-8222-222222222222";
  const validChangeRequestId = "c3333333-3333-4333-8333-333333333333";

  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  const baseRequestText = "Add PDF invoice summary export to Milestone 2.";

  const baseAnalysis: ScopeChangeAnalysis = {
    changeSummary: {
      requestedChangeSummary: "Add PDF invoice export alongside CSV.",
      changeType: "ADDITION",
      conflictsOrContradictions: [],
    },
    originalAgreementContext: {
      agreementVersionNumber: 1,
      agreementStatus: "APPROVED",
      confirmedBudgetMinor: 200000,
      currency: "USD",
      summaryExcerpt: "Approved v1 agreement.",
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
      proposedCostDeltaMinor: 25000,
      proposedRevisedTotalMinor: 225000,
      costDriversJustification: "PDF template rendering.",
      reconcilesExistingMilestonesUnchanged: true,
      requiresHumanReviewNotice:
        "AI-generated financial and scope estimate only — requires mutual human review.",
    },
    timelineImpact: {
      classification: "POTENTIAL_EXTENSION",
      estimatedAdditionalDaysMin: 3,
      estimatedAdditionalDaysMax: 5,
      canProceedInParallel: true,
      parallelWorkNotes: null,
      criticalPathMilestones: [],
      missingSchedulingInformation: [],
      explanation: "Adds 3-5 days.",
    },
    dependencyChanges: [],
    riskAssessment: [],
    assumptions: [],
    unresolvedQuestions: [],
    recommendedNextSteps: ["Create v2 draft for client OTP sign-off."],
    overallClassification: "MODERATE",
    classificationCriteria: ["Proposes incremental cost increase and timeline extension."],
  };

  let insertedPayloads: Array<{ table: string; payload: unknown }>;
  let updatedPayloads: Array<{ table: string; payload: unknown }>;

  function setupMockDb(options?: {
    projectOwnerId?: string;
    existingChangeRequest?: { id: string; project_id: string; status: string } | null;
  }) {
    const projectOwnerId = options?.projectOwnerId ?? mockUser.id;
    const existingCr =
      options?.existingChangeRequest !== undefined
        ? options.existingChangeRequest
        : { id: validChangeRequestId, project_id: validProjectId, status: "OPEN" };

    mockFrom.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        insert: vi.fn((payload: unknown) => {
          insertedPayloads.push({ table, payload });
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn(async () => ({
                data: {
                  id: validChangeRequestId,
                  ...(payload as Record<string, unknown>),
                  created_at: "2026-11-11T10:30:00.000Z",
                  resolved_at: null,
                },
                error: null,
              })),
            }),
            then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
          };
        }),
        update: vi.fn((payload: unknown) => {
          updatedPayloads.push({ table, payload });
          return builder;
        }),
        single: vi.fn(async () => {
          if (table === "change_requests") {
            return {
              data: {
                id: validChangeRequestId,
                project_id: validProjectId,
                agreement_version_id: validVersionId,
                request_text: baseRequestText,
                submitted_by_label: `Freelancer (${mockUser.email})`,
                status: "RESOLVED",
                created_at: "2026-11-11T10:30:00.000Z",
                resolved_at: "2026-11-11T11:00:00.000Z",
                ai_analysis: null,
                ai_analyzed_at: null,
                ai_model: null,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        }),
        maybeSingle: vi.fn(async () => {
          if (table === "projects") {
            return {
              data: {
                id: validProjectId,
                owner_id: projectOwnerId,
                title: "Acme Portal",
                client_name: "Acme",
                client_email: "client@acme.com",
                brief: "Acme brief",
                currency: "USD",
                total_amount_minor: 200000,
                status: "ACTIVE",
                start_date: null,
                target_end_date: null,
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
          if (table === "change_requests") {
            return { data: existingCr, error: null };
          }
          return { data: null, error: null };
        }),
        then: (resolve: (val: unknown) => void) => {
          if (table === "agreement_versions") {
            resolve({
              data: [
                {
                  id: validVersionId,
                  agreement_id: validAgreementId,
                  version_number: 1,
                  content: { summary: "Approved summary" },
                  content_hash: "h".repeat(64),
                  status: "APPROVED",
                },
              ],
              error: null,
            });
          } else if (table === "change_requests") {
            resolve({
              data: existingCr
                ? [
                    {
                      id: validChangeRequestId,
                      project_id: validProjectId,
                      agreement_version_id: validVersionId,
                      request_text: baseRequestText,
                      submitted_by_label: "Freelancer (freelancer@payroost.dev)",
                      status: "OPEN",
                      created_at: "2026-11-11T10:30:00.000Z",
                      resolved_at: null,
                      ai_analysis: null,
                      ai_analyzed_at: null,
                      ai_model: null,
                    },
                  ]
                : [],
              error: null,
            });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return builder;
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    insertedPayloads = [];
    updatedPayloads = [];
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    vi.spyOn(rateLimitModule, "allowRequest").mockResolvedValue(true);
    setupMockDb();
  });

  it("persists separated original request_text and signed ai_analysis without touching agreements, milestones, or payments", async () => {
    const signedSnapshot = signScopeChangeAnalysisSnapshot({
      analysis: baseAnalysis,
      requestText: baseRequestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "OWNER",
      model: "gemini-3.8-flash",
    });

    const res = await POST(
      new Request(`http://localhost:3000/api/projects/${validProjectId}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestText: baseRequestText,
          agreementVersionId: validVersionId,
          aiAnalysis: signedSnapshot,
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: {
        persisted: boolean;
        agreementChanged: boolean;
        milestonesChanged: boolean;
        paymentsChanged: boolean;
        changeRequest: Record<string, unknown>;
      };
    };

    expect(json.data.persisted).toBe(true);
    expect(json.data.agreementChanged).toBe(false);
    expect(json.data.milestonesChanged).toBe(false);
    expect(json.data.paymentsChanged).toBe(false);

    const crInsert = insertedPayloads.find((p) => p.table === "change_requests");
    expect(crInsert).toBeDefined();
    expect((crInsert!.payload as { request_text: string }).request_text).toBe(baseRequestText);
    expect((crInsert!.payload as { ai_analysis: unknown }).ai_analysis).toEqual(signedSnapshot);
    expect(insertedPayloads.some((p) => p.table === "activity_events")).toBe(true);
    expect(
      insertedPayloads.some((p) =>
        ["agreement_versions", "milestones", "payment_intents"].includes(p.table)
      )
    ).toBe(false);
    expect(updatedPayloads).toHaveLength(0);
  });

  it("rejects stale analysis (409 STALE_ANALYSIS) when request_text is edited after analysis", async () => {
    const signedSnapshot = signScopeChangeAnalysisSnapshot({
      analysis: baseAnalysis,
      requestText: baseRequestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "OWNER",
      model: "gemini-3.8-flash",
    });

    const res = await POST(
      new Request(`http://localhost:3000/api/projects/${validProjectId}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestText: "Add full mobile app rewrite after analyzing PDF export.",
          agreementVersionId: validVersionId,
          aiAnalysis: signedSnapshot,
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("STALE_ANALYSIS");
    expect(insertedPayloads).toHaveLength(0);
  });

  it("rejects tampered HMAC signature and cross-project/client-role analysis snapshots (403)", async () => {
    const signedSnapshot = signScopeChangeAnalysisSnapshot({
      analysis: baseAnalysis,
      requestText: baseRequestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "OWNER",
      model: "gemini-3.8-flash",
    });

    // Tamper budget delta client-side without valid HMAC
    const tampered = {
      ...signedSnapshot,
      financialImpact: {
        ...signedSnapshot.financialImpact,
        proposedCostDeltaMinor: 900000,
      },
    };

    const resTampered = await POST(
      new Request(`http://localhost:3000/api/projects/${validProjectId}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestText: baseRequestText,
          agreementVersionId: validVersionId,
          aiAnalysis: tampered,
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );
    expect(resTampered.status).toBe(403);

    // Valid snapshot from another project cannot be replayed
    const crossProjectSnapshot = signScopeChangeAnalysisSnapshot({
      analysis: baseAnalysis,
      requestText: baseRequestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: otherProjectId,
      requesterRole: "OWNER",
      model: "gemini-3.8-flash",
    });

    const resCrossProject = await POST(
      new Request(`http://localhost:3000/api/projects/${validProjectId}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestText: baseRequestText,
          agreementVersionId: validVersionId,
          aiAnalysis: crossProjectSnapshot,
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );
    expect(resCrossProject.status).toBe(403);
  });

  it("supports GET list and PATCH explicit status transitions without modifying request_text, ai_analysis, or agreements", async () => {
    const resGet = await GET(
      new Request(`http://localhost:3000/api/projects/${validProjectId}/change-requests`),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );
    expect(resGet.status).toBe(200);

    const resPatch = await PATCH(
      new Request(
        `http://localhost:3000/api/projects/${validProjectId}/change-requests/${validChangeRequestId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "RESOLVED" }),
        }
      ),
      { params: Promise.resolve({ projectId: validProjectId, changeRequestId: validChangeRequestId }) }
    );
    expect(resPatch.status).toBe(200);

    const crUpdate = updatedPayloads.find((u) => u.table === "change_requests");
    expect(crUpdate?.payload).toMatchObject({ status: "RESOLVED" });
    expect((crUpdate?.payload as Record<string, unknown>).ai_analysis).toBeUndefined();
    expect((crUpdate?.payload as Record<string, unknown>).request_text).toBeUndefined();
    expect(updatedPayloads.some((u) => u.table === "agreement_versions")).toBe(false);

    // Rejects modifying non-OPEN change requests
    setupMockDb({
      existingChangeRequest: {
        id: validChangeRequestId,
        project_id: validProjectId,
        status: "RESOLVED",
      },
    });
    const resAlreadyClosed = await PATCH(
      new Request(
        `http://localhost:3000/api/projects/${validProjectId}/change-requests/${validChangeRequestId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "WITHDRAWN" }),
        }
      ),
      { params: Promise.resolve({ projectId: validProjectId, changeRequestId: validChangeRequestId }) }
    );
    expect(resAlreadyClosed.status).toBe(409);
  });
});
