import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { POST } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";

const mockRequireProjectOwner = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/features/projects/authorization", () => ({
  requireProjectOwner: (...args: unknown[]) => mockRequireProjectOwner(...args),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  allowRequest: vi.fn(),
}));

describe("POST /api/projects/[projectId]/review-link", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAppUrl = process.env.PAYROOST_APP_URL;
  const originalNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  const projectId = "a0000000-0000-4000-a000-000000000001";

  beforeEach(() => {
    vi.clearAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.PAYROOST_APP_URL = "https://app.payroost.com///";
    delete process.env.NEXT_PUBLIC_APP_URL;

    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(true);
    mockRpc.mockResolvedValue({ data: "rl-1", error: null });
    mockRequireProjectOwner.mockResolvedValue({
      supabase: { rpc: mockRpc },
      project: {
        id: projectId,
        client_email_verified_at: "2026-11-10T10:00:00.000Z",
      },
    });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    if (originalAppUrl === undefined) delete process.env.PAYROOST_APP_URL;
    else process.env.PAYROOST_APP_URL = originalAppUrl;
    if (originalNextPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalNextPublicAppUrl;
  });

  it("ignores request.url origin and constructs reviewUrl strictly from canonical app URL", async () => {
    const req = new Request(`https://untrusted-origin.example/api/projects/${projectId}/review-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresInDays: 7 }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewUrl).toMatch(/^https:\/\/app\.payroost\.com\/review\/[A-Za-z0-9_-]{43}$/);
    expect(body.reviewUrl).not.toContain("untrusted-origin.example");
  });

  it("fails closed with 503 CONFIGURATION_UNAVAILABLE in production when canonical app URL is missing", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.PAYROOST_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const req = new Request(`https://app.payroost.com/api/projects/${projectId}/review-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresInDays: 7 }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectId }) });
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error).toBe("CONFIGURATION_UNAVAILABLE");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("fails closed with 503 CONFIGURATION_UNAVAILABLE in production when canonical app URL uses HTTP", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.PAYROOST_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "http://app.payroost.com";

    const req = new Request(`https://app.payroost.com/api/projects/${projectId}/review-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresInDays: 7 }),
    });
    const res = await POST(req, { params: Promise.resolve({ projectId }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("CONFIGURATION_UNAVAILABLE");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
