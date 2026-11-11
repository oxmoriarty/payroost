import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { _resetInMemoryRateLimits } from "@/lib/security/rate-limit";
import { hashVerificationToken } from "@/lib/security/tokens";

const mockRpc = vi.fn();
const mockSupabase = {
  rpc: mockRpc,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

describe("POST /api/public/verify-client-email rate limiting hardening", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxy = process.env.TRUST_PROXY;
  const validToken = "client-email-verification-token-1234567890";

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInMemoryRateLimits();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.TRUST_PROXY = "false";

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        // Defer to in-memory bucket in isolated unit tests
        return Promise.resolve({ data: null, error: null });
      }
      if (rpcName === "verify_client_email") {
        return Promise.resolve({
          data: { verified: true, projectId: "proj-1" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }

    if (originalTrustProxy === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = originalTrustProxy;
    }
    _resetInMemoryRateLimits();
  });

  function makeReq(options?: {
    token?: string;
    rawBody?: string;
    headers?: Record<string, string>;
  }) {
    return new Request("https://payroost.com/api/public/verify-client-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: options?.rawBody ?? JSON.stringify({ token: options?.token ?? validToken }),
    });
  }

  it("preserves validation errors and successful email verification response contract", async () => {
    const badJsonRes = await POST(makeReq({ rawBody: "{broken" }));
    expect(badJsonRes.status).toBe(400);
    expect(badJsonRes.headers.get("Cache-Control")).toBe("no-store");
    expect((await badJsonRes.json()).error).toBe("INVALID_JSON");

    const shortTokenRes = await POST(makeReq({ token: "short" }));
    expect(shortTokenRes.status).toBe(400);
    expect((await shortTokenRes.json()).error).toBe("VALIDATION_ERROR");

    const okRes = await POST(makeReq());
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("Cache-Control")).toBe("no-store");
    expect(await okRes.json()).toEqual({
      success: true,
      data: { verified: true, projectId: "proj-1" },
    });
    expect(mockRpc).toHaveBeenCalledWith("verify_client_email", {
      p_token_hash: hashVerificationToken(validToken),
    });

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "Invalid token" } });
    });
    const failedVerifyRes = await POST(makeReq({ token: `${validToken}-other` }));
    expect(failedVerifyRes.status).toBe(400);
    expect((await failedVerifyRes.json()).error).toBe("VERIFICATION_FAILED");
  });

  it("ignores rotating X-Forwarded-For headers when TRUST_PROXY is false and enforces the 10/min token limit", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        makeReq({
          headers: { "x-forwarded-for": `198.51.100.${i + 1}` },
        })
      );
      expect(res.status).toBe(200);
    }

    // Spoofing a fresh IP cannot bypass the token rate limit
    const res11 = await POST(
      makeReq({
        headers: { "x-forwarded-for": "203.0.113.250" },
      })
    );
    expect(res11.status).toBe(429);
    expect(res11.headers.get("Cache-Control")).toBe("no-store");
    expect((await res11.json()).error).toBe("RATE_LIMITED");
  });

  it("enforces IP rate limit across distinct tokens using rightmost trusted proxy IP when TRUST_PROXY=true", async () => {
    process.env.TRUST_PROXY = "true";

    // Even when rotating both token and leftmost spoofed IP, the rightmost trusted hop IP hits 10/min limit
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        makeReq({
          token: `${validToken}-distinct-${i}`,
          headers: {
            "x-forwarded-for": `10.0.0.${i + 1}, 198.51.100.77`,
          },
        })
      );
      expect(res.status).toBe(200);
    }

    const res11 = await POST(
      makeReq({
        token: `${validToken}-distinct-blocked`,
        headers: {
          "x-forwarded-for": "172.16.0.99, 198.51.100.77",
        },
      })
    );
    expect(res11.status).toBe(429);
    expect(res11.headers.get("Cache-Control")).toBe("no-store");
    expect((await res11.json()).error).toBe("RATE_LIMITED");
    const verifyCalls = mockRpc.mock.calls.filter(([name]) => name === "verify_client_email");
    expect(verifyCalls).toHaveLength(10);
  });

  it("enforces IP rate limit using trusted X-Real-IP when TRUST_PROXY=true", async () => {
    process.env.TRUST_PROXY = "true";

    for (let i = 0; i < 10; i++) {
      const res = await POST(
        makeReq({
          token: `${validToken}-xreal-${i}`,
          headers: {
            "x-real-ip": "203.0.113.42",
          },
        })
      );
      expect(res.status).toBe(200);
    }

    const res11 = await POST(
      makeReq({
        token: `${validToken}-xreal-blocked`,
        headers: {
          "x-real-ip": "203.0.113.42",
        },
      })
    );
    expect(res11.status).toBe(429);
    expect((await res11.json()).error).toBe("RATE_LIMITED");
  });

  it("fails closed in production with 503 RATE_LIMITER_UNAVAILABLE when rate-limit backend fails", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({ data: null, error: { message: "DB connection lost" } });
      }
      return Promise.resolve({ data: { verified: true }, error: null });
    });

    const res = await POST(makeReq());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
    expect(mockRpc).not.toHaveBeenCalledWith("verify_client_email", expect.anything());
  });
});
