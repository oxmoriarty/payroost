import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as scopeService from "@/features/scope-changes/service";
import { SnapshotSigningConfigurationError } from "@/features/scope-changes/snapshot";
import type { StoredScopeChangeAnalysis } from "@/features/scope-changes/schema";
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

describe("POST /api/public/portal/[token]/scope-change/analyze (AI-5 Client Portal)", () => {
  const validToken = "valid-portal-token-for-scope-analysis-12345678";
  const validRawSessionToken = "valid-test-portal-session-token-43-chars___";
  const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const validProjectId = "c0000000-0000-4000-a000-000000000001";
  const otherProjectId = "d0000000-0000-4000-a000-000000000009";
  const validAgreementId = "a1111111-1111-4111-8111-111111111111";
  const validVersionId = "b2222222-2222-4222-8222-222222222222";
  const foreignVersionId = "e9999999-9999-4999-8999-999999999999";
  const validClientEmail = "client@acme-corp.com";

  let insertedTables: string[];
  let updatedTables: string[];

  const sampleClientAnalysis: StoredScopeChangeAnalysis = {
    changeSummary: {
      requestedChangeSummary: "Add custom webhook integration.",
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
      costDriversJustification: "Outbound webhook queue.",
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
    recommendedNextSteps: ["Submit request for freelancer review."],
    overallClassification: "MODERATE",
    classificationCriteria: ["Incremental cost addition."],
    snapshotMetadata: {
      analyzedRequestTextSha256: "a".repeat(64),
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "CLIENT",
      analyzedAt: "2026-11-11T10:00:00.000Z",
      model: "gemini-3.8-flash",
      integrityTag: "c".repeat(64),
      isProposalOnly: true,
    },
  };

  function setupMockDb() {
    mockFrom.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        insert: vi.fn(() => {
          insertedTables.push(table);
          return builder;
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

  function makeReq(options?: {
    body?: unknown;
    csrf?: string | null;
  }) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.csrf !== null) {
      headers["x-csrf-token"] = options?.csrf ?? validCsrfSecret;
    }
    return new Request(
      `http://localhost:3000/api/public/portal/${validToken}/scope-change/analyze`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          options?.body ?? { requestText: "Add custom webhook integration for events." }
        ),
      }
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    insertedTables = [];
    updatedTables = [];
    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 8,
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
      current: 9,
      limit: 8,
      resetAt: Date.now() + 60_000,
      status: "rate_limited",
    });
    const res429 = await POST(makeReq(), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(res429.status).toBe(429);

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
  });

  it("rejects browser-supplied projectId overrides (400) and cross-project agreementVersionId (403)", async () => {
    const resExtra = await POST(
      makeReq({
        body: {
          projectId: otherProjectId,
          requestText: "Add SSO integration.",
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(resExtra.status).toBe(400);

    const resForeignVer = await POST(
      makeReq({
        body: {
          agreementVersionId: foreignVersionId,
          requestText: "Add SSO integration.",
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(resForeignVer.status).toBe(403);
  });

  it("returns preview-only CLIENT analysis without touching change_requests, agreements, milestones, or payments", async () => {
    const spy = vi.spyOn(scopeService, "analyzeScopeChange").mockResolvedValue({
      analysis: sampleClientAnalysis,
      model: "gemini-3.8-flash",
      durationMs: 145,
    });

    const res = await POST(makeReq(), {
      params: Promise.resolve({ token: validToken }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { preview: boolean; persisted: boolean; analysis: StoredScopeChangeAnalysis };
    };
    expect(json.data.preview).toBe(true);
    expect(json.data.persisted).toBe(false);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: validProjectId,
        requesterRole: "CLIENT",
      }),
      { userId: validClientEmail }
    );
    expect(insertedTables).toEqual([]);
    expect(updatedTables).toEqual([]);
  });

  it("returns 503 CONFIGURATION_UNAVAILABLE without leaking secrets when snapshot signing secret is invalid", async () => {
    vi.spyOn(scopeService, "analyzeScopeChange").mockRejectedValueOnce(
      new SnapshotSigningConfigurationError(
        "PAYROOST_AI_SNAPSHOT_SECRET must be configured with at least 32 bytes"
      )
    );

    const res = await POST(makeReq(), {
      params: Promise.resolve({ token: validToken }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error).toBe("CONFIGURATION_UNAVAILABLE");
  });
});
