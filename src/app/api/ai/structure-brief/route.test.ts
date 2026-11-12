import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import * as briefService from "@/features/briefs/service";
import * as rateLimitModule from "@/lib/security/rate-limit";
import {
  AiConfigurationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import type { StructuredBrief } from "@/features/briefs/schema";

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
const mockSelect = vi.fn(() => ({ eq: mockEq1 }));
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRpc = vi.fn();

const mockFrom = vi.fn(() => ({
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
  delete: mockDelete,
}));

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
  rpc: mockRpc,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

describe("POST /api/ai/structure-brief", () => {
  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  const sampleBrief: StructuredBrief = {
    title: "E-Commerce Clothing Storefront",
    summary: "Build an e-commerce platform for client apparel line.",
    objectives: ["Online sales"],
    functionalRequirements: ["Catalog", "Checkout"],
    nonFunctionalRequirements: ["Responsive"],
    deliverables: ["Storefront application"],
    scopeInclusions: ["Frontend and API"],
    scopeExclusions: ["Inventory photography"],
    assumptions: ["Client provides products"],
    constraints: ["Standard browser compatibility"],
    dependencies: ["Stripe account"],
    timelineExpectations: null,
    risks: ["Asset delivery delays"],
    openQuestions: ["Which payment methods are required?"],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetUser.mockResolvedValue({
      data: { user: mockUser },
      error: null,
    });

    vi.mocked(rateLimitModule.checkRateLimit).mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 15,
      resetAt: Date.now() + 3_600_000,
      status: "allowed",
      isUnavailable: false,
    });

    mockMaybeSingle.mockResolvedValue({
      data: {
        id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        title: "Existing Project",
        client_name: "Acme Corp",
        brief: "Existing project brief description from the database with at least twenty characters.",
      },
      error: null,
    });

    vi.spyOn(briefService, "structureProjectBrief").mockResolvedValue({
      brief: sampleBrief,
      model: "gemini-3.8-flash",
      durationMs: 450,
    });
  });

  it("returns 401 UNAUTHORIZED when user session is missing or invalid", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error("No active session"),
    });

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 429 RATE_LIMITED when user exceeds rate limits", async () => {
    vi.mocked(rateLimitModule.checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      current: 16,
      limit: 15,
      resetAt: Date.now() + 3_600_000,
      status: "rate_limited",
      isUnavailable: false,
    });

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(429);
    expect(json.error).toBe("RATE_LIMITED");
  });

  it("returns 503 RATE_LIMITER_UNAVAILABLE when the rate-limit store fails", async () => {
    vi.mocked(rateLimitModule.checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      current: 0,
      limit: 15,
      resetAt: Date.now() + 60_000,
      status: "service_unavailable",
      isUnavailable: true,
    });

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("RATE_LIMITER_UNAVAILABLE");
    expect(json.message).toMatch(/rate limiting/i);
  });

  it("returns 400 INVALID_JSON when body is malformed", async () => {
    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 VALIDATION_ERROR when neither description nor projectId is provided", async () => {
    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when description is under 10 characters", async () => {
    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Too short" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 403 FORBIDDEN when user does not own the referenced projectId", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        description: "Valid description provided alongside projectId",
      }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 500 DATABASE_ERROR instead of 403 when project ownership query fails", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "permission denied for table projects" },
    });

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        description: "Valid description provided alongside projectId",
      }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("DATABASE_ERROR");
  });

  it("successfully structures brief from submitted natural language description", async () => {
    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Need an e-commerce website for my clothing business with customer checkout.",
      }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.brief.title).toBe("E-Commerce Clothing Storefront");
    expect(json.data.model).toBe("gemini-3.8-flash");
    expect(json.data.durationMs).toBe(450);

    // Verify service was called with proper user ID
    expect(briefService.structureProjectBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Need an e-commerce website for my clothing business with customer checkout.",
        userId: mockUser.id,
      })
    );
  });

  it("pulls project brief from database when description is omitted but projectId is valid", async () => {
    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.brief.title).toBe("E-Commerce Clothing Storefront");
    expect(briefService.structureProjectBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Existing project brief description from the database with at least twenty characters.",
        projectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        context: {
          clientName: "Acme Corp",
          existingTitle: "Existing Project",
        },
      })
    );
  });

  it("maps AiConfigurationError to 500 AI_CONFIG_ERROR with safe actionable message and no secret leakage", async () => {
    vi.spyOn(briefService, "structureProjectBrief").mockRejectedValueOnce(
      new AiConfigurationError("Invalid Gemini configuration: key AIzaSyDUMMY1234567890 rejected", { status: 401 })
    );

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("AI_CONFIG_ERROR");
    expect(json.message).toMatch(/GEMINI_API_KEY/i);
    expect(JSON.stringify(json)).not.toContain("AIza");

    vi.spyOn(briefService, "structureProjectBrief").mockRejectedValueOnce(
      new AiConfigurationError("Gemini model not found", { status: 404 })
    );
    const modelNotFoundReq = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });
    const modelRes = await POST(modelNotFoundReq);
    const modelJson = await modelRes.json();
    expect(modelRes.status).toBe(500);
    expect(modelJson.error).toBe("AI_CONFIG_ERROR");
    expect(modelJson.message).toMatch(/gemini-3\.8-flash/i);
  });

  it("maps AiUnavailableError to 503 AI_UNAVAILABLE and distinguishes timeouts", async () => {
    vi.spyOn(briefService, "structureProjectBrief").mockRejectedValueOnce(
      new AiUnavailableError("Gemini service is unavailable")
    );

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error).toBe("AI_UNAVAILABLE");
    expect(json.message).toMatch(/temporarily unavailable/i);

    vi.spyOn(briefService, "structureProjectBrief").mockRejectedValueOnce(
      new AiUnavailableError("Gemini request timed out", { isTimeout: true })
    );
    const timeoutReq = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });
    const timeoutRes = await POST(timeoutReq);
    const timeoutJson = await timeoutRes.json();
    expect(timeoutRes.status).toBe(503);
    expect(timeoutJson.error).toBe("AI_UNAVAILABLE");
    expect(timeoutJson.message).toMatch(/timed out/i);
  });

  it("maps AiRateLimitError to 429 AI_RATE_LIMITED", async () => {
    vi.spyOn(briefService, "structureProjectBrief").mockRejectedValueOnce(
      new AiRateLimitError("Upstream Gemini rate limit exceeded")
    );

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(429);
    expect(json.error).toBe("AI_RATE_LIMITED");
  });

  it("maps AiOutputValidationError to 422 AI_OUTPUT_INVALID", async () => {
    vi.spyOn(briefService, "structureProjectBrief").mockRejectedValueOnce(
      new AiOutputValidationError("AI output validation failed")
    );

    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Valid project description for testing" }),
    });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(422);
    expect(json.error).toBe("AI_OUTPUT_INVALID");
  });

  it("confirms NO database write operations are performed", async () => {
    const request = new Request("http://localhost/api/ai/structure-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Valid project description to verify persistence isolation.",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    // Verify persistence boundaries: no insert, update, delete, or mutating rpc
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
