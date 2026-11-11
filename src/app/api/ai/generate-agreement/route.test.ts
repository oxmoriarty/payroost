import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import * as geminiService from "@/features/agreements/gemini";
import * as agreementRouteModule from "@/app/api/projects/[projectId]/agreement/route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import { AiConfigurationError, AiRateLimitError } from "@/lib/ai/errors";
import type { AgreementDraft } from "@/features/agreements/schema";
import type { StructuredBrief } from "@/features/briefs/schema";

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

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

vi.mock("@/app/api/projects/[projectId]/agreement/route", () => ({
  saveAgreementDraft: vi.fn(),
}));

describe("POST /api/ai/generate-agreement (AI-3)", () => {
  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  const mockProject = {
    id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    owner_id: "u0000000-0000-4000-a000-000000000001",
    title: "Client Web Application",
    client_name: "Acme Corp",
    client_email: "client@acme.com",
    client_email_verified_at: "2026-11-01T12:00:00Z",
    brief: "Detailed project brief description with more than twenty characters.",
    currency: "USD",
    total_amount_minor: 200000,
    start_date: "2026-11-01",
    target_end_date: "2026-12-31",
  };

  const sampleStructuredBrief: StructuredBrief = {
    title: "Client Web Application",
    summary: "Build an authenticated client web dashboard and marketing portal.",
    objectives: ["Launch portal"],
    functionalRequirements: ["Auth", "Dashboard"],
    nonFunctionalRequirements: ["Responsive UI"],
    deliverables: ["Web app"],
    scopeInclusions: ["Frontend and backend"],
    scopeExclusions: ["Copywriting"],
    assumptions: ["Client supplies brand assets"],
    constraints: ["Deploy on Vercel"],
    dependencies: ["Supabase project"],
    timelineExpectations: "End of December",
    risks: ["Asset delays"],
    openQuestions: ["Preferred SSO provider?"],
  };

  const sampleGeneratedDraft: AgreementDraft = {
    summary: "Generated draft summary.",
    objective: "Project objectives.",
    scopeItems: [
      {
        id: "scope-1",
        title: "Frontend Build",
        description: "Next.js frontend",
        deliverables: ["Application"],
        acceptanceCriteria: ["Functional"],
        assumptions: [],
      },
    ],
    exclusions: ["Content entry"],
    milestones: [
      {
        id: "m-1",
        title: "Milestone 1",
        description: "Core features",
        amountMinor: 200000,
        currency: "USD",
        dueDate: "2026-12-31",
        deliverables: ["Code repository"],
        acceptanceCriteria: ["Tests pass"],
      },
    ],
    timeline: [],
    clientResponsibilities: ["Provide credentials"],
    freelancerResponsibilities: ["Develop solution"],
    paymentTerms: ["200000 minor units of USD"],
    revisionPolicy: ["2 rounds of revisions"],
    changeProcess: ["Scope changes require new version"],
    terminationNotes: ["7 days notice"],
    disputeResolution: ["Project agreement, not legal advice"],
    openQuestions: [],
    warnings: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetUser.mockResolvedValue({
      data: { user: mockUser },
      error: null,
    });

    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(true);

    mockMaybeSingle.mockResolvedValue({
      data: mockProject,
      error: null,
    });

    vi.spyOn(geminiService, "generateAgreementDraft").mockResolvedValue(sampleGeneratedDraft);
  });

  it("returns 400 INVALID_JSON when body is malformed", async () => {
    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 VALIDATION_ERROR when projectId is missing or non-UUID", async () => {
    const reqMissing = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect((await POST(reqMissing)).status).toBe(400);

    const reqInvalidUuid = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "not-a-uuid" }),
    });
    expect((await POST(reqInvalidUuid)).status).toBe(400);
  });

  it("returns 400 VALIDATION_ERROR when invalid structuredBrief reference payload is supplied", async () => {
    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: mockProject.id,
        structuredBrief: { title: "A" }, // Invalid/incomplete brief payload
      }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.message).toContain("Invalid structuredBrief payload");
  });

  it("returns 401 UNAUTHORIZED for unauthenticated requests", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error("No session"),
    });

    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 FORBIDDEN for cross-user access attempts and missing projects", async () => {
    // Cross-user: another owner_id owns the project
    mockMaybeSingle.mockResolvedValueOnce({
      data: { ...mockProject, owner_id: "u9999999-9999-4999-a999-999999999999" },
      error: null,
    });

    const crossUserReq = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });
    expect((await POST(crossUserReq)).status).toBe(403);

    // Missing project
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const missingReq = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });
    expect((await POST(missingReq)).status).toBe(403);
  });

  it("returns 500 DATABASE_ERROR on database query failure instead of masking as 403 Forbidden", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "connection refused" },
    });

    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("DATABASE_ERROR");
  });

  it("returns 429 RATE_LIMITED when user exceeds rate limits", async () => {
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValueOnce(false);

    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(429);
    expect(json.error).toBe("RATE_LIMITED");
  });

  it("returns 400 VALIDATION_ERROR if project has non-positive or invalid budget", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        ...mockProject,
        total_amount_minor: 0,
      },
      error: null,
    });

    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.message).toContain("Project budget must be a positive integer");
  });

  it("generates draft in preview mode by default WITHOUT saving to database, consuming structuredBrief when passed", async () => {
    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: mockProject.id,
        structuredBrief: sampleStructuredBrief,
      }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.preview).toBe(true);
    expect(json.data.reconciled).toBe(true);
    expect(json.data.totalAmountMinor).toBe(200000);
    expect(json.data.draft.summary).toBe("Generated draft summary.");

    expect(geminiService.generateAgreementDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredBrief: expect.objectContaining({ title: "Client Web Application" }),
        startDate: "2026-11-01",
        endDate: "2026-12-31",
      }),
      expect.objectContaining({ projectId: mockProject.id, userId: mockUser.id })
    );

    // CRITICAL: saveAgreementDraft must NOT be called in preview mode!
    expect(agreementRouteModule.saveAgreementDraft).not.toHaveBeenCalled();
  });

  it("saves immediately with source AI_ASSISTED only when saveImmediately: true is explicitly provided", async () => {
    vi.mocked(agreementRouteModule.saveAgreementDraft).mockResolvedValueOnce({
      data: { id: "version-123", version_number: 1 },
    });

    const request = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: mockProject.id,
        saveImmediately: true,
      }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.id).toBe("version-123");
    expect(agreementRouteModule.saveAgreementDraft).toHaveBeenCalledWith(
      mockProject.id,
      sampleGeneratedDraft,
      { source: "AI_ASSISTED" }
    );
  });

  it("maps AiConfigurationError, AiRateLimitError, GeminiUnavailableError, and GeminiOutputError properly", async () => {
    vi.spyOn(geminiService, "generateAgreementDraft").mockRejectedValueOnce(
      new AiConfigurationError("Missing API key")
    );
    const req1 = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });
    expect((await POST(req1)).status).toBe(500);

    vi.spyOn(geminiService, "generateAgreementDraft").mockRejectedValueOnce(
      new AiRateLimitError("Rate limited by Gemini")
    );
    const req2 = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });
    expect((await POST(req2)).status).toBe(429);

    vi.spyOn(geminiService, "generateAgreementDraft").mockRejectedValueOnce(
      new geminiService.GeminiUnavailableError("Gemini service is unreachable.")
    );
    const req3 = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });
    expect((await POST(req3)).status).toBe(503);

    vi.spyOn(geminiService, "generateAgreementDraft").mockRejectedValueOnce(
      new geminiService.GeminiOutputError("Milestone amounts do not reconcile.")
    );
    const req4 = new Request("http://localhost/api/ai/generate-agreement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: mockProject.id }),
    });
    expect((await POST(req4)).status).toBe(422);
  });
});
