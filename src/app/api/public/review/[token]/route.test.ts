import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GET, POST } from "./route";
import { POST as OTP_POST } from "./otp/route";
import { _resetInMemoryRateLimits } from "@/lib/security/rate-limit";

const mockRpc = vi.fn();
const mockSupabase = {
  rpc: mockRpc,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(),
    rpc: vi.fn(),
  })),
}));

vi.mock("@/features/milestones/sync", () => ({
  syncApprovedAgreementMilestones: vi.fn(),
}));

vi.mock("@/features/notifications/service", () => ({
  syncNotificationsFromActivityEvents: vi.fn(),
}));

vi.mock("@/lib/email/provider", () => ({
  sendReviewOtpEmail: vi.fn(async () => ({ success: true, messageId: "msg-1" })),
}));

describe("Public review link & OTP rate limiting and secret hardening", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxy = process.env.TRUST_PROXY;
  const originalOtpSecret = process.env.PAYROOST_OTP_SECRET;

  const validToken = "public-review-token-security-test-123456";
  const validOtpSecret = "test-review-otp-hmac-secret-at-least-32-bytes!";

  beforeEach(() => {
    vi.clearAllMocks();
    _resetInMemoryRateLimits();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.TRUST_PROXY = "false";
    process.env.PAYROOST_OTP_SECRET = validOtpSecret;

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        // Defer to in-memory bucket inside isolated unit tests
        return Promise.resolve({ data: null, error: null });
      }
      if (rpcName === "get_public_review") {
        return Promise.resolve({ data: [{ projectId: "p-1" }], error: null });
      }
      if (rpcName === "request_review_otp") {
        return Promise.resolve({
          data: { clientEmail: "client@acme.example", projectTitle: "Acme Project" },
          error: null,
        });
      }
      if (rpcName === "submit_public_review_with_otp") {
        return Promise.resolve({
          data: { decisionStatus: "REQUEST_CHANGES", projectId: "p-1" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
    if (originalOtpSecret === undefined) delete process.env.PAYROOST_OTP_SECRET;
    else process.env.PAYROOST_OTP_SECRET = originalOtpSecret;
    _resetInMemoryRateLimits();
  });

  function makeContext(token = validToken) {
    return { params: Promise.resolve({ token }) };
  }

  it("prevents rotating X-Forwarded-For spoofing from bypassing POST decision rate limits when TRUST_PROXY is false", async () => {
    for (let i = 0; i < 6; i++) {
      const req = new Request(`https://payroost.com/api/public/review/${validToken}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({ action: "REQUEST_CHANGES", note: "Revise", otpCode: "123456" }),
      });
      const res = await POST(req, makeContext());
      expect(res.status).not.toBe(429);
    }

    const spoofedSeventh = new Request(`https://payroost.com/api/public/review/${validToken}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.99",
      },
      body: JSON.stringify({ action: "REQUEST_CHANGES", note: "Revise", otpCode: "123456" }),
    });
    const res = await POST(spoofedSeventh, makeContext());
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error).toBe("RATE_LIMITED");
  });

  it("prevents rotating X-Forwarded-For spoofing from bypassing GET read rate limits when TRUST_PROXY is false", async () => {
    for (let i = 0; i < 30; i++) {
      const req = new Request(`https://payroost.com/api/public/review/${validToken}`, {
        method: "GET",
        headers: { "x-forwarded-for": `198.51.100.${(i % 200) + 1}` },
      });
      const res = await GET(req, makeContext());
      expect(res.status).toBe(200);
    }

    const req31 = new Request(`https://payroost.com/api/public/review/${validToken}`, {
      method: "GET",
      headers: { "x-forwarded-for": "203.0.113.250" },
    });
    const res31 = await GET(req31, makeContext());
    expect(res31.status).toBe(429);
    expect((await res31.json()).error).toBe("RATE_LIMITED");
  });

  it("enforces secondary IP limit by rightmost trusted proxy hop when TRUST_PROXY=true", async () => {
    process.env.TRUST_PROXY = "true";

    // Different review tokens from the same rightmost proxy IP share the IP limit (6 writes / 60s)
    for (let i = 0; i < 6; i++) {
      const token = `${validToken}-${i}`;
      const req = new Request(`https://payroost.com/api/public/review/${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Leftmost spoofed IP varies, rightmost proxy IP stays fixed
          "x-forwarded-for": `10.0.0.${i + 1}, 198.51.100.77`,
        },
        body: JSON.stringify({ action: "REQUEST_CHANGES", note: "Note", otpCode: "123456" }),
      });
      const res = await POST(req, makeContext(token));
      expect(res.status).not.toBe(429);
    }

    const blockedToken = `${validToken}-blocked`;
    const blockedReq = new Request(`https://payroost.com/api/public/review/${blockedToken}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "172.16.0.55, 198.51.100.77",
      },
      body: JSON.stringify({ action: "REQUEST_CHANGES", note: "Note", otpCode: "123456" }),
    });
    const blockedRes = await POST(blockedReq, makeContext(blockedToken));
    expect(blockedRes.status).toBe(429);
    expect((await blockedRes.json()).error).toBe("RATE_LIMITED");
  });

  it("fails closed with 503 RATE_LIMITER_UNAVAILABLE in production when rate-limit RPC fails", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({ data: null, error: { message: "DB unavailable" } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const getRes = await GET(
      new Request(`https://payroost.com/api/public/review/${validToken}`),
      makeContext()
    );
    expect(getRes.status).toBe(503);
    expect(getRes.headers.get("Cache-Control")).toBe("no-store");
    expect((await getRes.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");

    const postRes = await POST(
      new Request(`https://payroost.com/api/public/review/${validToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "REQUEST_CHANGES", note: "Note", otpCode: "123456" }),
      }),
      makeContext()
    );
    expect(postRes.status).toBe(503);
    expect((await postRes.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");

    const otpRes = await OTP_POST(
      new Request(`https://payroost.com/api/public/review/${validToken}/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVE" }),
      }),
      makeContext()
    );
    expect(otpRes.status).toBe(503);
    expect((await otpRes.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
  });

  it("enforces OTP request rate limit regardless of X-Forwarded-For spoofing and fails closed if PAYROOST_OTP_SECRET is missing in production", async () => {
    // 5 OTP requests allowed across rotating XFF, 6th blocked with 429
    for (let i = 0; i < 5; i++) {
      const req = new Request(`https://payroost.com/api/public/review/${validToken}/otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": `203.0.113.${i + 1}`,
        },
        body: JSON.stringify({ action: "APPROVE" }),
      });
      const res = await OTP_POST(req, makeContext());
      expect(res.status).toBe(200);
    }

    const sixthOtp = await OTP_POST(
      new Request(`https://payroost.com/api/public/review/${validToken}/otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "198.51.100.200",
        },
        body: JSON.stringify({ action: "APPROVE" }),
      }),
      makeContext()
    );
    expect(sixthOtp.status).toBe(429);

    // Now test production fail-closed when PAYROOST_OTP_SECRET is missing
    _resetInMemoryRateLimits();
    mockRpc.mockClear();
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.PAYROOST_OTP_SECRET;
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({
          data: { allowed: true, current: 1, limit: 10, resetAt: new Date(Date.now() + 60000).toISOString() },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const otpMissingSecretRes = await OTP_POST(
      new Request(`https://payroost.com/api/public/review/${validToken}-new/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVE" }),
      }),
      makeContext(`${validToken}-new`)
    );
    expect(otpMissingSecretRes.status).toBe(503);
    expect((await otpMissingSecretRes.json()).error).toBe("CONFIGURATION_UNAVAILABLE");

    const postMissingSecretRes = await POST(
      new Request(`https://payroost.com/api/public/review/${validToken}-new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVE", otpCode: "123456" }),
      }),
      makeContext(`${validToken}-new`)
    );
    expect(postMissingSecretRes.status).toBe(503);
    expect((await postMissingSecretRes.json()).error).toBe("CONFIGURATION_UNAVAILABLE");
    expect(mockRpc).not.toHaveBeenCalledWith("request_review_otp", expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith("submit_public_review_with_otp", expect.anything());
  });
});
