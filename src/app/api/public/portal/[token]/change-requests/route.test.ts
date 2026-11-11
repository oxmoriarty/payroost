import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import { signScopeChangeAnalysisSnapshot } from "@/features/scope-changes/snapshot";
import type { ScopeChangeAnalysis } from "@/features/scope-changes/schema";
import { PORTAL_SESSION_COOKIE_NAME_DEV } from "@/lib/security/portal-session";

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockServiceClient = { rpc: mockRpc, from: mockFrom };

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => mockServiceClient),
}));

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

describe("POST /api/public/portal/[token]/change-requests (AI-5 Client Portal Submission)", () => {
  const validToken = "valid-portal-token-for-scope-submit-123456789";
  const validRawSessionToken = "valid-test-portal-session-token-43-chars___";
  const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const validProjectId = "c0000000-0000-4000-a000-000000000001";
  const otherProjectId = "d0000000-0000-4000-a000-000000000009";
  const validAgreementId = "a1111111-1111-4111-8111-111111111111";
  const validVersionId = "b2222222-2222-4222-8222-222222222222";
  const foreignVersionId = "e9999999-9999-4999-8999-999999999999";
  const validChangeRequestId = "f5555555-5555-4555-8555-555555555555";
  const validClientEmail = "client@acme-corp.com";

  const baseRequestText = "Add custom outbound webhook notifications for completed events.";

  const baseAnalysis: ScopeChangeAnalysis = {
    changeSummary: {
      requestedChangeSummary: "Add custom outbound webhook queue.",
      changeType: "ADDITION",
      conflictsOrContradictions: [],
    },
    originalAgreementContext: {
      agreementVersionNumber: 1,
      agreementStatus: "APPROVED",
      confirmedBudgetMinor: 300000,
      currency: "USD",
      summaryExcerpt: "Approved v1 contract.",
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
      proposedCostDeltaMinor: 30000,
      proposedRevisedTotalMinor: 330000,
      costDriversJustification: "Outbound webhook queue and retry handler.",
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
    recommendedNextSteps: ["Review financial delta with freelancer before agreement revision."],
    overallClassification: "MODERATE",
    classificationCriteria: ["Incremental cost addition and minor schedule impact."],
  };

  let insertedPayloads: Array<{ table: string; payload: unknown }>;
  let updatedTables: string[];

  function setupMockDb() {
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
                  created_at: "2026-11-11T10:35:00.000Z",
                  resolved_at: null,
                },
                error: null,
              })),
            }),
            then: (resolve: (val: unknown) => void) => resolve({ data: null, error: null }),
          };
        }),
        update: vi.fn(() => {
          updatedTables.push(table);
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          if (table === "client_portal_tokens") {
            return {
              data: {
                project_id: validProjectId,
                revoked_at: null,
                consumed_at: null,
                expires_at: "2099-01-01T00:00:00.000Z",
              },
              error: null,
            };
          }
          if (table === "projects") {
            return {
              data: {
                id: validProjectId,
                owner_id: "owner-1",
                title: "Acme Project",
                client_name: "Acme",
                client_email: validClientEmail,
                brief: "Acme portal brief.",
                currency: "USD",
                total_amount_minor: 300000,
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
                  content: { summary: "Approved contract summary" },
                  content_hash: "h".repeat(64),
                  status: "APPROVED",
                },
              ],
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

  function makeReq(options?: { body?: unknown; rawBody?: string; csrf?: string | null }) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.csrf !== null) {
      headers["x-csrf-token"] = options?.csrf ?? validCsrfSecret;
    }
    return new Request(
      `http://localhost:3000/api/public/portal/${validToken}/change-requests`,
      {
        method: "POST",
        headers,
        body:
          options?.rawBody ??
          JSON.stringify(
            options?.body ?? {
              requestText: baseRequestText,
            }
          ),
      }
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    insertedPayloads = [];
    updatedTables = [];
    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 12,
      resetAt: Date.now() + 60_000,
      status: "allowed",
      isUnavailable: false,
    });
    mockCookieStore.get.mockImplementation((name: string) =>
      name === PORTAL_SESSION_COOKIE_NAME_DEV ? { value: validRawSessionToken } : undefined
    );
    mockRpc.mockResolvedValue({
      data: {
        valid: true,
        sessionId: "sess-1",
        projectId: validProjectId,
        clientEmail: validClientEmail,
        csrfSecret: validCsrfSecret,
      },
      error: null,
    });
    setupMockDb();
  });

  it("enforces token format (404), rate limiting (429/503), CSRF (403), and cross-project portal session binding (403)", async () => {
    const resBadToken = await POST(makeReq(), {
      params: Promise.resolve({ token: "short" }),
    });
    expect(resBadToken.status).toBe(404);

    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
      allowed: false,
      current: 13,
      limit: 12,
      resetAt: Date.now() + 60_000,
      status: "rate_limited",
    });
    const res429 = await POST(makeReq(), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(res429.status).toBe(429);

    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
      allowed: false,
      current: 0,
      limit: 12,
      resetAt: Date.now() + 60_000,
      status: "service_unavailable",
      isUnavailable: true,
    });
    const res503 = await POST(makeReq(), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(res503.status).toBe(503);

    const resMissingCsrf = await POST(makeReq({ csrf: null }), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(resMissingCsrf.status).toBe(403);

    mockRpc.mockResolvedValueOnce({
      data: {
        valid: true,
        sessionId: "sess-other",
        projectId: otherProjectId,
        clientEmail: validClientEmail,
        csrfSecret: validCsrfSecret,
      },
      error: null,
    });
    const resCrossProjectSess = await POST(makeReq(), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(resCrossProjectSess.status).toBe(403);
    expect(insertedPayloads).toHaveLength(0);
  });

  it("rejects empty body / malformed JSON (400) and strict unexpected fields (400)", async () => {
    const resEmpty = await POST(makeReq({ rawBody: "   " }), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(resEmpty.status).toBe(400);

    const resInvalidJson = await POST(makeReq({ rawBody: "{not-json" }), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(resInvalidJson.status).toBe(400);

    const resExtraField = await POST(
      makeReq({
        body: {
          requestText: baseRequestText,
          submittedByLabel: "Spoofed Admin",
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(resExtraField.status).toBe(400);
    expect(insertedPayloads).toHaveLength(0);
  });

  it("persists explicit client submission with signed CLIENT AI analysis without mutating agreement, milestones, or payments", async () => {
    const signedClientSnapshot = signScopeChangeAnalysisSnapshot({
      analysis: baseAnalysis,
      requestText: baseRequestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "CLIENT",
      model: "gemini-3.8-flash",
      analyzedAt: "2026-11-11T10:30:00.000Z",
    });

    const res = await POST(
      makeReq({
        body: {
          requestText: `  ${baseRequestText}  `,
          agreementVersionId: validVersionId,
          aiAnalysis: signedClientSnapshot,
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.persisted).toBe(true);
    expect(json.data.agreementChanged).toBe(false);
    expect(json.data.milestonesChanged).toBe(false);
    expect(json.data.paymentsChanged).toBe(false);
    expect(json.data.changeRequest.request_text).toBe(baseRequestText);
    expect(json.data.changeRequest.submitted_by_label).toBe(`Client (${validClientEmail})`);
    expect(json.data.changeRequest.status).toBe("OPEN");
    expect(json.data.changeRequest.ai_analysis.overallClassification).toBe("MODERATE");
    expect(json.data.changeRequest.ai_model).toBe("gemini-3.8-flash");

    expect(insertedPayloads.map((p) => p.table)).toEqual(["change_requests", "activity_events"]);
    expect(updatedTables).toHaveLength(0);

    const crInsert = insertedPayloads[0].payload as Record<string, unknown>;
    expect(crInsert.request_text).toBe(baseRequestText);
    expect(crInsert.submitted_by_label).toBe(`Client (${validClientEmail})`);
    expect(crInsert.ai_analysis).toEqual(signedClientSnapshot);

    const activityInsert = insertedPayloads[1].payload as Record<string, unknown>;
    expect(activityInsert.actor_user_id).toBeNull();
    expect(activityInsert.actor_label).toBe(`Client (${validClientEmail})`);
    expect(activityInsert.event_type).toBe("change_request.submitted");
  });

  it("allows explicit manual client submission when aiAnalysis is null (discarded proposal)", async () => {
    const res = await POST(
      makeReq({
        body: {
          requestText: baseRequestText,
          agreementVersionId: validVersionId,
          aiAnalysis: null,
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );

    expect(res.status).toBe(201);
    const crInsert = insertedPayloads[0].payload as Record<string, unknown>;
    expect(crInsert.ai_analysis).toBeNull();
    expect(crInsert.ai_analyzed_at).toBeNull();
    expect(crInsert.ai_model).toBeNull();
  });

  it("rejects stale analysis (409), FREELANCER snapshot replay (403), forged HMAC signature (403), and cross-project version ID (403)", async () => {
    const signedClientSnapshot = signScopeChangeAnalysisSnapshot({
      analysis: baseAnalysis,
      requestText: baseRequestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "CLIENT",
      model: "gemini-3.8-flash",
      analyzedAt: "2026-11-11T10:30:00.000Z",
    });

    // Edited text -> STALE_ANALYSIS (409)
    const resStale = await POST(
      makeReq({
        body: {
          requestText: `${baseRequestText} Plus SLA uptime guarantees.`,
          agreementVersionId: validVersionId,
          aiAnalysis: signedClientSnapshot,
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(resStale.status).toBe(409);
    expect((await resStale.json()).error).toBe("STALE_ANALYSIS");

    // OWNER role replay into client portal -> 403
    const signedOwnerSnapshot = signScopeChangeAnalysisSnapshot({
      analysis: baseAnalysis,
      requestText: baseRequestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "OWNER",
      model: "gemini-3.8-flash",
      analyzedAt: "2026-11-11T10:30:00.000Z",
    });
    const resWrongRole = await POST(
      makeReq({
        body: {
          requestText: baseRequestText,
          agreementVersionId: validVersionId,
          aiAnalysis: signedOwnerSnapshot,
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(resWrongRole.status).toBe(403);

    // Forged signature -> 403
    const forged = structuredClone(signedClientSnapshot);
    forged.financialImpact.proposedCostDeltaMinor = 1;
    const resForged = await POST(
      makeReq({
        body: {
          requestText: baseRequestText,
          agreementVersionId: validVersionId,
          aiAnalysis: forged,
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(resForged.status).toBe(403);

    // Foreign agreementVersionId -> 403
    const resForeignVer = await POST(
      makeReq({
        body: {
          requestText: baseRequestText,
          agreementVersionId: foreignVersionId,
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(resForeignVer.status).toBe(403);

    expect(insertedPayloads).toHaveLength(0);
  });
});
