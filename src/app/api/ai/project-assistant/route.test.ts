import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as assistantService from "@/features/assistant/service";
import {
  AiConfigurationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import type { ProjectAssistantReply } from "@/features/assistant/schema";

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
  rpc: mockRpc,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

describe("POST /api/ai/project-assistant (AI-6 Freelancer Dashboard)", () => {
  const validProjectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  let dbMutations: string[];

  const sampleReply: ProjectAssistantReply = {
    answerStatus: "ANSWERED",
    summary: "Agreement v1 is approved and Milestone 1 is SUBMITTED awaiting client acceptance.",
    recordedFacts: [
      {
        fact: "Agreement v1 is APPROVED.",
        authorityLabel: "APPROVED_AGREEMENT",
        sourceRef: "Agreement v1 (APPROVED)",
      },
    ],
    aiInterpretation: "Next action is client acceptance on Milestone 1.",
    uncertaintiesAndGaps: [],
    clarificationQuestions: [],
    recommendedNextSteps: ["Wait for client milestone review or discuss via change request workflow."],
    isAiGenerated: true,
    readOnlyNotice:
      "AI-generated read-only summary based on PayRoost project records. AI outputs do not constitute legal advice and cannot modify agreements, milestones, change requests, or payments.",
    model: "gemini-3.8-flash",
    participantRole: "OWNER",
    generatedAt: "2026-11-11T12:00:00.000Z",
    contextStats: {
      approvedAgreementVersion: 1,
      currentAgreementVersion: 1,
      milestoneCount: 1,
      openChangeRequestCount: 0,
      recordedPaymentIntentCount: 0,
    },
  };

  function setupMockDb(options?: { ownerId?: string; dbError?: boolean }) {
    const projectOwner = options?.ownerId ?? mockUser.id;
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
          if (options?.dbError && table === "projects") {
            return { data: null, error: { message: "connection failure" } };
          }
          if (table === "projects") {
            return {
              data: {
                id: validProjectId,
                owner_id: projectOwner,
                title: "Acme Portal",
                client_name: "Acme Corp",
                client_email: "client@acme.example",
                client_email_verified_at: "2026-11-01T10:00:00.000Z",
                brief: "Acme portal delivery brief.",
                currency: "USD",
                total_amount_minor: 200000,
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

  function makeReq(body: unknown, rawText?: string) {
    return new Request("http://localhost:3000/api/ai/project-assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawText ?? JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    dbMutations = [];
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 15,
      resetAt: Date.now() + 60_000,
      status: "allowed",
      isUnavailable: false,
    });
    setupMockDb();
  });

  it("enforces authentication (401), strict payload validation (400), rate limits (429/503), and project ownership (403)", async () => {
    const resMalformed = await POST(makeReq(null, "{bad-json"));
    expect(resMalformed.status).toBe(400);

    const resStrictExtra = await POST(
      makeReq({
        projectId: validProjectId,
        question: "What is approved?",
        authoritativeContext: { budget: 999 },
      })
    );
    expect(resStrictExtra.status).toBe(400);

    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res401 = await POST(
      makeReq({ projectId: validProjectId, question: "What is approved?" })
    );
    expect(res401.status).toBe(401);

    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
      allowed: false,
      current: 16,
      limit: 15,
      resetAt: Date.now() + 60_000,
      status: "rate_limited",
      isUnavailable: false,
    });
    const res429 = await POST(
      makeReq({ projectId: validProjectId, question: "What is approved?" })
    );
    expect(res429.status).toBe(429);

    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
      allowed: false,
      current: 0,
      limit: 15,
      resetAt: Date.now() + 60_000,
      status: "service_unavailable",
      isUnavailable: true,
    });
    const res503 = await POST(
      makeReq({ projectId: validProjectId, question: "What is approved?" })
    );
    expect(res503.status).toBe(503);

    const spyAsk = vi.spyOn(assistantService, "askProjectAssistant");
    setupMockDb({ ownerId: "other-owner-uuid" });
    const res403 = await POST(
      makeReq({ projectId: validProjectId, question: "What is approved?" })
    );
    expect(res403.status).toBe(403);
    expect(spyAsk).not.toHaveBeenCalled();

    setupMockDb({ dbError: true });
    const res500Db = await POST(
      makeReq({ projectId: validProjectId, question: "What is approved?" })
    );
    expect(res500Db.status).toBe(500);
  });

  it("answers grounded project questions read-only without mutating any DB table", async () => {
    const spyAsk = vi
      .spyOn(assistantService, "askProjectAssistant")
      .mockResolvedValue({
        reply: sampleReply,
        model: "gemini-3.8-flash",
        durationMs: 240,
      });

    const res = await POST(
      makeReq({
        projectId: validProjectId,
        question: "What milestones are outstanding?",
        history: [{ role: "user", content: "Hi" }],
      })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(json.data.reply.isAiGenerated).toBe(true);
    expect(json.data.reply.participantRole).toBe("OWNER");
    expect(spyAsk).toHaveBeenCalledTimes(1);
    expect(dbMutations).toHaveLength(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("maps AI errors into normalized HTTP status codes without leaking internal details", async () => {
    vi.spyOn(assistantService, "askProjectAssistant")
      .mockRejectedValueOnce(new AiRateLimitError("429 quota key=AIzaSecret"))
      .mockRejectedValueOnce(new AiUnavailableError("Timeout", { isTimeout: true }))
      .mockRejectedValueOnce(new AiOutputValidationError("Assistant cited invalid reference"))
      .mockRejectedValueOnce(new AiConfigurationError("Missing GEMINI_API_KEY"));

    const r1 = await POST(makeReq({ projectId: validProjectId, question: "Status?" }));
    expect(r1.status).toBe(429);

    const r2 = await POST(makeReq({ projectId: validProjectId, question: "Status?" }));
    expect(r2.status).toBe(503);

    const r3 = await POST(makeReq({ projectId: validProjectId, question: "Status?" }));
    expect(r3.status).toBe(422);

    const r4 = await POST(makeReq({ projectId: validProjectId, question: "Status?" }));
    expect(r4.status).toBe(500);
    expect(JSON.stringify(await r4.json())).not.toContain("GEMINI_API_KEY");
  });
});
