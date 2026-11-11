import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as assistantService from "@/features/assistant/service";
import type { ProjectAssistantReply } from "@/features/assistant/schema";
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

describe("POST /api/public/portal/[token]/assistant (AI-6 Client Portal)", () => {
  const validToken = "valid-portal-token-for-assistant-1234567890";
  const validRawSessionToken = "valid-test-portal-session-token-43-chars___";
  const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const validProjectId = "c0000000-0000-4000-a000-000000000001";
  const otherProjectId = "d0000000-0000-4000-a000-000000000009";
  const validClientEmail = "client@acme-corp.com";

  let dbMutations: string[];

  const sampleClientReply: ProjectAssistantReply = {
    answerStatus: "ANSWERED",
    summary: "Milestone 1 payment intent is COMPLETED with verified provider capture.",
    recordedFacts: [
      {
        fact: "Payment Intent #1 is COMPLETED with a COMPLETED CAPTURE transaction.",
        authorityLabel: "PAYMENT_RECORD",
        sourceRef: "Payment Intent #1",
      },
    ],
    aiInterpretation:
      "Capture verification is recorded; downstream bank payout settlement is not tracked in PayRoost.",
    uncertaintiesAndGaps: [],
    clarificationQuestions: [],
    recommendedNextSteps: ["Review remaining milestones in your Client Portal."],
    isAiGenerated: true,
    readOnlyNotice:
      "AI-generated read-only summary based on PayRoost project records. AI outputs do not constitute legal advice and cannot modify agreements, milestones, change requests, or payments.",
    model: "gemini-3.8-flash",
    participantRole: "CLIENT",
    generatedAt: "2026-11-11T12:00:00.000Z",
    contextStats: {
      approvedAgreementVersion: 1,
      currentAgreementVersion: 1,
      milestoneCount: 1,
      openChangeRequestCount: 0,
      recordedPaymentIntentCount: 1,
    },
  };

  function setupMockDb(options?: { clientEmailOnProject?: string }) {
    mockFrom.mockImplementation((table: string) => {
      const recordMutation = (op: string) => {
        dbMutations.push(`${op}:${table}`);
        return builder;
      };
      const builder: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        insert: vi.fn(() => recordMutation("insert")),
        update: vi.fn(() => recordMutation("update")),
        delete: vi.fn(() => recordMutation("delete")),
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
                client_email: options?.clientEmailOnProject ?? validClientEmail,
                client_email_verified_at: "2026-11-01T10:00:00.000Z",
                brief: "Acme portal brief.",
                currency: "USD",
                total_amount_minor: 300000,
                status: "ACTIVE",
                start_date: null,
                target_end_date: null,
                created_at: "2026-11-01T09:00:00.000Z",
                updated_at: "2026-11-10T09:00:00.000Z",
              },
              error: null,
            };
          }
          return { data: null, error: null };
        }),
        then: (resolve: (val: unknown) => void) => {
          resolve({ data: [], error: null });
        },
      };
      return builder;
    });
  }

  function makeReq(options?: { body?: unknown; csrf?: string | null }) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.csrf !== null) {
      headers["x-csrf-token"] = options?.csrf ?? validCsrfSecret;
    }
    return new Request(
      `http://localhost:3000/api/public/portal/${validToken}/assistant`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(options?.body ?? { question: "What payments are recorded?" }),
      }
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    dbMutations = [];
    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 15,
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

  it("enforces token format (404), rate limiting (429/503), CSRF (403), cross-project session binding (403), and client email mismatch (403)", async () => {
    const spyAsk = vi.spyOn(assistantService, "askProjectAssistant");

    const resBadToken = await POST(makeReq(), {
      params: Promise.resolve({ token: "short" }),
    });
    expect(resBadToken.status).toBe(404);

    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
      allowed: false,
      current: 16,
      limit: 15,
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
      limit: 15,
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

    setupMockDb({ clientEmailOnProject: "different-client@acme-corp.com" });
    const resEmailMismatch = await POST(makeReq(), {
      params: Promise.resolve({ token: validToken }),
    });
    expect(resEmailMismatch.status).toBe(403);

    expect(spyAsk).not.toHaveBeenCalled();
    expect(dbMutations).toHaveLength(0);
  });

  it("rejects browser-supplied projectId or role overrides via .strict()", async () => {
    const res = await POST(
      makeReq({
        body: {
          question: "Summarize project.",
          projectId: otherProjectId,
          participantRole: "OWNER",
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );
    expect(res.status).toBe(400);
  });

  it("executes verified Client Portal read-only query cleanly without mutating records", async () => {
    const spyAsk = vi
      .spyOn(assistantService, "askProjectAssistant")
      .mockResolvedValue({
        reply: sampleClientReply,
        model: "gemini-3.8-flash",
        durationMs: 185,
      });

    const res = await POST(
      makeReq({
        body: {
          question: "What payments have been recorded?",
          history: [],
        },
      }),
      { params: Promise.resolve({ token: validToken }) }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(json.data.reply.participantRole).toBe("CLIENT");
    expect(json.data.reply.isAiGenerated).toBe(true);
    expect(spyAsk).toHaveBeenCalledTimes(1);
    expect(dbMutations).toHaveLength(0);
  });
});
