import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import * as milestoneService from "@/features/milestones/service";
import type { MilestonePlan } from "@/features/milestones/schema";
import * as rateLimitModule from "@/lib/security/rate-limit";
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

describe("POST /api/ai/generate-milestones (AI-4)", () => {
  const validProjectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  const mockProject = {
    id: validProjectId,
    owner_id: mockUser.id,
    title: "Mobile Commerce Portal",
    client_name: "Acme Retail",
    brief: "Build an iOS/Android commerce backend and merchant milestone portal.",
    currency: "USD",
    total_amount_minor: 200000,
    status: "DRAFT",
    start_date: "2026-11-15",
    target_end_date: "2027-01-15",
  };

  const samplePlan: MilestonePlan = {
    overallTimelineEstimate: "8 weeks across 2 milestones",
    milestoneCount: 2,
    allocatesFullBudget: true,
    totalProposedAmountMinor: 200000,
    currency: "USD",
    milestones: [
      {
        id: "m-1",
        position: 1,
        title: "Backend API & Auth",
        description: "Implement catalog and authentication endpoints.",
        deliverables: ["REST API"],
        acceptanceCriteria: ["API tests green"],
        estimatedDuration: "4 weeks",
        dueDate: null,
        dependsOn: [],
        proposedAmountMinor: 120000,
        currency: "USD",
        assumptions: [],
        openQuestions: [],
      },
      {
        id: "m-2",
        position: 2,
        title: "Merchant Portal & QA",
        description: "Finish frontend dashboard and handoff.",
        deliverables: ["Admin portal"],
        acceptanceCriteria: ["UAT sign-off"],
        estimatedDuration: "4 weeks",
        dueDate: null,
        dependsOn: ["m-1"],
        proposedAmountMinor: 80000,
        currency: "USD",
        assumptions: [],
        openQuestions: [],
      },
    ],
    assumptions: [],
    unresolvedQuestions: [],
    risksAndDependencies: [],
  };

  let milestoneInserts: unknown[];
  let agreementVersionInserts: unknown[];
  let paymentIntentInserts: unknown[];

  function setupDbMocks(options?: {
    project?: typeof mockProject | null;
    projectError?: { message: string } | null;
    agreement?: { id: string; status: string; current_version_id: string | null } | null;
    version?: { id: string; version_number: number; status: string; content: unknown } | null;
    milestones?: Array<Record<string, unknown>>;
  }) {
    mockFrom.mockImplementation((table: string) => {
      if (table === "projects") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: options && "project" in options ? options.project : mockProject,
                error: options?.projectError ?? null,
              })),
            })),
          })),
        };
      }
      if (table === "agreements") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data:
                  options && "agreement" in options
                    ? options.agreement
                    : { id: "agree-1", status: "DRAFT", current_version_id: "ver-1" },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === "agreement_versions") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data:
                  options && "version" in options
                    ? options.version
                    : { id: "ver-1", version_number: 1, status: "DRAFT", content: {} },
                error: null,
              })),
            })),
          })),
          insert: vi.fn((payload: unknown) => {
            agreementVersionInserts.push(payload);
            return {};
          }),
        };
      }
      if (table === "milestones") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(async () => ({
                data: options?.milestones ?? [],
                error: null,
              })),
            })),
          })),
          insert: vi.fn((payload: unknown) => {
            milestoneInserts.push(payload);
            return {};
          }),
        };
      }
      if (table === "payment_intents") {
        return {
          insert: vi.fn((payload: unknown) => {
            paymentIntentInserts.push(payload);
            return {};
          }),
        };
      }
      return {};
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    milestoneInserts = [];
    agreementVersionInserts = [];
    paymentIntentInserts = [];
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(true);
    setupDbMocks();
  });

  it("returns 401 UNAUTHORIZED when requester is unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "No session" } });

    const req = new Request("http://localhost/api/ai/generate-milestones", {
      method: "POST",
      body: JSON.stringify({ projectId: validProjectId }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("UNAUTHORIZED");
  });

  it("returns 429 RATE_LIMITED when user exceeds quota", async () => {
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(false);

    const req = new Request("http://localhost/api/ai/generate-milestones", {
      method: "POST",
      body: JSON.stringify({ projectId: validProjectId }),
    });

    const res = await POST(req);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("RATE_LIMITED");
  });

  it("rejects browser-supplied financial fields (totalAmountMinor, currency, ownerId) via strict validation", async () => {
    const req = new Request("http://localhost/api/ai/generate-milestones", {
      method: "POST",
      body: JSON.stringify({
        projectId: validProjectId,
        totalAmountMinor: 1,
        currency: "EUR",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
  });

  it("returns 403 FORBIDDEN for missing projects or non-owners, and 500 DATABASE_ERROR on DB errors", async () => {
    setupDbMocks({ project: { ...mockProject, owner_id: "other-owner" } });
    const forbiddenRes = await POST(
      new Request("http://localhost/api/ai/generate-milestones", {
        method: "POST",
        body: JSON.stringify({ projectId: validProjectId }),
      })
    );
    expect(forbiddenRes.status).toBe(403);

    setupDbMocks({ project: null, projectError: { message: "db connection failed" } });
    const dbErrRes = await POST(
      new Request("http://localhost/api/ai/generate-milestones", {
        method: "POST",
        body: JSON.stringify({ projectId: validProjectId }),
      })
    );
    expect(dbErrRes.status).toBe(500);
    expect((await dbErrRes.json()).error).toBe("DATABASE_ERROR");
  });

  it("returns validated milestone proposal in preview-only mode with ZERO persistent DB writes", async () => {
    const generateSpy = vi
      .spyOn(milestoneService, "generateMilestonePlan")
      .mockResolvedValue({
        plan: samplePlan,
        model: "gemini-3.8-flash",
        durationMs: 210,
      });

    const req = new Request("http://localhost/api/ai/generate-milestones", {
      method: "POST",
      body: JSON.stringify({
        projectId: validProjectId,
        planningGoal: "Prioritize backend endpoints first",
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.preview).toBe(true);
    expect(json.data.persisted).toBe(false);
    expect(json.data.plan.milestoneCount).toBe(2);
    expect(json.data.projectContext.confirmedBudgetMinor).toBe(200000);
    expect(json.data.projectContext.currency).toBe("USD");

    // Authoritative server financial values passed to service
    expect(generateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedBudgetMinor: 200000,
        establishedCurrency: "USD",
        allocateBudget: true,
        planningGoal: "Prioritize backend endpoints first",
      }),
      expect.objectContaining({
        projectId: validProjectId,
        userId: mockUser.id,
      })
    );

    // Confirm zero persistence or payment side effects
    expect(milestoneInserts).toHaveLength(0);
    expect(agreementVersionInserts).toHaveLength(0);
    expect(paymentIntentInserts).toHaveLength(0);
  });

  it("maps normalized AI errors cleanly to HTTP status codes", async () => {
    vi.spyOn(milestoneService, "generateMilestonePlan")
      .mockRejectedValueOnce(new AiConfigurationError("Missing key"))
      .mockRejectedValueOnce(new AiRateLimitError("429 upstream"))
      .mockRejectedValueOnce(new AiUnavailableError("503 upstream"))
      .mockRejectedValueOnce(
        new AiFinancialReconciliationError("Sum mismatch", {
          expectedTotalMinor: 200000,
          actualTotalMinor: 150000,
          currency: "USD",
        })
      );

    const makeReq = () =>
      new Request("http://localhost/api/ai/generate-milestones", {
        method: "POST",
        body: JSON.stringify({ projectId: validProjectId }),
      });

    const resConfig = await POST(makeReq());
    expect(resConfig.status).toBe(500);
    expect((await resConfig.json()).error).toBe("AI_CONFIG_ERROR");

    const resRate = await POST(makeReq());
    expect(resRate.status).toBe(429);
    expect((await resRate.json()).error).toBe("AI_RATE_LIMITED");

    const resUnavailable = await POST(makeReq());
    expect(resUnavailable.status).toBe(503);
    expect((await resUnavailable.json()).error).toBe("AI_UNAVAILABLE");

    const resInvalid = await POST(makeReq());
    expect(resInvalid.status).toBe(422);
    expect((await resInvalid.json()).error).toBe("AI_OUTPUT_INVALID");
  });
});
