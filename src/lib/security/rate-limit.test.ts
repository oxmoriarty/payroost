import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { allowRequest, checkRateLimit, _resetInMemoryRateLimits } from "@/lib/security/rate-limit";

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: mockRpc,
  })),
}));

function setNodeEnv(env: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = env;
}

describe("Phase 3B.2.3.1: Rate Limiter Semantics & Failure Modes", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInMemoryRateLimits();
    setNodeEnv(originalNodeEnv);
    // Default: RPC throws so non-production falls back to in-memory
    mockRpc.mockRejectedValue(new Error("Supabase offline in test"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetInMemoryRateLimits();
    setNodeEnv(originalNodeEnv);
  });

  // ==========================================================================
  // Existing caller compatibility (allowRequest returns boolean)
  // ==========================================================================
  it("permits requests within the defined threshold and returns boolean for existing callers", async () => {
    const key = `test-user-${Date.now()}`;
    expect(await allowRequest(key, 3, 10_000)).toBe(true);
    expect(await allowRequest(key, 3, 10_000)).toBe(true);
    expect(await allowRequest(key, 3, 10_000)).toBe(true);
  });

  it("blocks requests that exceed the limit within window", async () => {
    const key = `test-blocked-${Date.now()}`;
    expect(await allowRequest(key, 2, 10_000)).toBe(true);
    expect(await allowRequest(key, 2, 10_000)).toBe(true);
    expect(await allowRequest(key, 2, 10_000)).toBe(false);
  });

  it("handles distinct keys independently", async () => {
    const keyA = `user-a-${Date.now()}`;
    const keyB = `user-b-${Date.now()}`;
    expect(await allowRequest(keyA, 1, 10_000)).toBe(true);
    expect(await allowRequest(keyA, 1, 10_000)).toBe(false);
    expect(await allowRequest(keyB, 1, 10_000)).toBe(true);
  });

  // ==========================================================================
  // Typed status: Limit exhaustion vs Service Unavailable
  // ==========================================================================
  it("distinguishes actual rate-limit exhaustion with status 'rate_limited'", async () => {
    // Database returns valid limit exhaustion
    mockRpc.mockResolvedValueOnce({
      data: { allowed: false, current: 6, limit: 5, resetAt: new Date(Date.now() + 60000).toISOString() },
      error: null,
    });

    const result = await checkRateLimit("user-exhausted", 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.status).toBe("rate_limited");
    expect(result.isUnavailable).toBe(false);
    expect(result.current).toBe(6);
  });

  it("distinguishes database infrastructure failure in production with status 'service_unavailable'", async () => {
    setNodeEnv("production");

    // Database RPC returns error
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "connection to server at 'db.supabase.co' failed" },
    });

    const result = await checkRateLimit("user-prod-db-fail", 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.status).toBe("service_unavailable");
    expect(result.isUnavailable).toBe(true);
  });

  it("fails closed when database RPC throws an exception in production", async () => {
    setNodeEnv("production");

    mockRpc.mockRejectedValueOnce(new Error("Fatal network timeout"));

    const result = await checkRateLimit("user-prod-db-throw", 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.status).toBe("service_unavailable");
    expect(result.isUnavailable).toBe(true);
  });

  it("production never falls back to in-memory accounting after a database failure", async () => {
    setNodeEnv("production");

    // Simulate database failure for first call
    mockRpc.mockRejectedValueOnce(new Error("DB down"));
    const firstAttempt = await checkRateLimit("user-fail-closed-test", 5, 60_000);
    expect(firstAttempt.allowed).toBe(false);
    expect(firstAttempt.status).toBe("service_unavailable");

    // Second call also fails database
    mockRpc.mockRejectedValueOnce(new Error("DB down"));
    const secondAttempt = await checkRateLimit("user-fail-closed-test", 5, 60_000);
    expect(secondAttempt.allowed).toBe(false);
    expect(secondAttempt.status).toBe("service_unavailable");

    // If it had fallen back to in-memory, the count would have been 1 and allowed: true.
    // Asserting allowed: false confirms in-memory fallback is NEVER used in production.
  });

  it("development/test falls back to in-memory limiter when database is offline", async () => {
    setNodeEnv("development");
    mockRpc.mockRejectedValue(new Error("DB offline"));

    const res1 = await checkRateLimit("dev-user", 2, 10_000);
    expect(res1.allowed).toBe(true);
    expect(res1.status).toBe("allowed");

    const res2 = await checkRateLimit("dev-user", 2, 10_000);
    expect(res2.allowed).toBe(true);
    expect(res2.status).toBe("allowed");

    const res3 = await checkRateLimit("dev-user", 2, 10_000);
    expect(res3.allowed).toBe(false);
    expect(res3.status).toBe("rate_limited");
  });
});
