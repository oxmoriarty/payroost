import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GET } from "./[token]/route";
import { POST } from "./[token]/otp/route";
import * as emailProvider from "@/lib/email/provider";
import * as rateLimitModule from "@/lib/security/rate-limit";
import { createPortalToken, hashPortalToken } from "@/lib/security/tokens";
import { computePortalOtpHmac } from "@/lib/security/portal-otp";

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: mockRpc,
  })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    rpc: mockRpc,
  })),
}));

function setNodeEnv(env: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = env;
}

describe("Phase 3B.2.4: Public Portal Entry & OTP Challenge Dispatch", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHmacSecret = process.env.PORTAL_OTP_HMAC_SECRET;

  const validRawToken = "valid-test-portal-token-43-chars-long-base64url_";

  beforeEach(() => {
    vi.clearAllMocks();
    emailProvider.emailDeliveryLog.length = 0;
    setNodeEnv(originalNodeEnv);
    process.env.PORTAL_OTP_HMAC_SECRET = "test-hmac-secret-min-32-bytes-long-for-testing!!";
    delete process.env.RESEND_API_KEY;
    delete process.env.TRUST_PROXY;

    // Default mock behavior
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({
          data: { allowed: true, current: 1, limit: 30, resetAt: new Date(Date.now() + 60000).toISOString() },
          error: null,
        });
      }
      if (rpcName === "validate_portal_invitation") {
        return Promise.resolve({
          data: {
            valid: true,
            projectTitle: "Ecommerce Platform Modernization",
            expiresAt: "2026-11-11T12:00:00.000Z",
          },
          error: null,
        });
      }
      if (rpcName === "create_portal_otp_challenge") {
        return Promise.resolve({
          data: {
            challengeId: "c0000000-0000-4000-a000-000000000001",
            clientEmail: "client@verified-domain.com",
            projectTitle: "Ecommerce Platform Modernization",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setNodeEnv(originalNodeEnv);
    process.env.PORTAL_OTP_HMAC_SECRET = originalHmacSecret;
    delete process.env.TRUST_PROXY;
  });

  function createGetRequest(token: string, headers?: Record<string, string>) {
    return new Request(`https://payroost.com/api/public/portal/${token}`, {
      method: "GET",
      headers: {
        "x-forwarded-for": "198.51.100.25",
        ...headers,
      },
    });
  }

  function createPostRequest(token: string, body?: unknown, headers?: Record<string, string>) {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.25",
        ...headers,
      },
    };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return new Request(`https://payroost.com/api/public/portal/${token}/otp`, init);
  }

  function createContext(token: string) {
    return {
      params: Promise.resolve({ token }),
    };
  }

  // ==========================================================================
  // Section A: GET /api/public/portal/[token]
  // ==========================================================================
  describe("GET /api/public/portal/[token]", () => {
    it("1. valid invitation returns safe metadata without client email or internal IDs", async () => {
      const req = createGetRequest(validRawToken);
      const res = await GET(req, createContext(validRawToken));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.valid).toBe(true);
      expect(json.projectTitle).toBe("Ecommerce Platform Modernization");
      expect(json.expiresAt).toBe("2026-11-11T12:00:00.000Z");

      // Verify no sensitive fields are present
      expect(json.clientEmail).toBeUndefined();
      expect(json.tokenHash).toBeUndefined();
      expect(json.token).toBeUndefined();
      expect(json.projectId).toBeUndefined();
      expect(json.otp).toBeUndefined();
    });

    it("2 & 3. raw token is hashed before database access and never sent to RPC", async () => {
      const rawToken = createPortalToken();
      const expectedHash = hashPortalToken(rawToken);

      const req = createGetRequest(rawToken);
      const res = await GET(req, createContext(rawToken));
      expect(res.status).toBe(200);

      const validateCalls = mockRpc.mock.calls.filter((c) => c[0] === "validate_portal_invitation");
      expect(validateCalls).toHaveLength(1);
      const rpcArgs = validateCalls[0][1];

      expect(rpcArgs.p_token_hash).toBe(expectedHash);
      expect(rpcArgs.p_token_hash).not.toBe(rawToken);
    });

    it("4. rejects invalid or malformed token format with 404 INVITATION_NOT_FOUND", async () => {
      const invalidTokens = [
        "short",
        "with spaces in token string",
        "special$char!token",
        "a".repeat(200), // oversized
      ];

      for (const badToken of invalidTokens) {
        const req = createGetRequest(badToken);
        const res = await GET(req, createContext(badToken));
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe("INVITATION_NOT_FOUND");
      }
    });

    it("5, 6, 7 & 8. rejects expired, revoked, consumed, or unverified invitations with generic 404", async () => {
      // Database returns null for expired, revoked, consumed, or unverified token
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 30, resetAt: new Date().toISOString() }, error: null });
        }
        if (rpcName === "validate_portal_invitation") {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createGetRequest(validRawToken);
      const res = await GET(req, createContext(validRawToken));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.error).toBe("INVITATION_NOT_FOUND");
    });

    it("9. invalid invitation responses do not reveal project existence", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 30, resetAt: new Date().toISOString() }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const resA = await GET(createGetRequest("nonexistent-token-11111111111111111"), createContext("nonexistent-token-11111111111111111"));
      const resB = await GET(createGetRequest("expired-token-22222222222222222222"), createContext("expired-token-22222222222222222222"));

      expect(resA.status).toBe(404);
      expect(resB.status).toBe(404);
      expect((await resA.json()).error).toBe("INVITATION_NOT_FOUND");
      expect((await resB.json()).error).toBe("INVITATION_NOT_FOUND");
    });

    it("10. database errors return sanitized 500 response", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 30, resetAt: new Date().toISOString() }, error: null });
        }
        if (rpcName === "validate_portal_invitation") {
          return Promise.resolve({ data: null, error: { message: "Internal deadlock detected" } });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createGetRequest(validRawToken);
      const res = await GET(req, createContext(validRawToken));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("SERVER_ERROR");
    });

    it("11. rate-limit exhaustion returns 429", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
        allowed: false,
        current: 31,
        limit: 30,
        resetAt: Date.now() + 60000,
        status: "rate_limited",
        isUnavailable: false,
      });

      const req = createGetRequest(validRawToken);
      const res = await GET(req, createContext(validRawToken));

      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("RATE_LIMITED");
    });

    it("12. rate-limiter infrastructure failure in production returns 503", async () => {
      setNodeEnv("production");
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: null, error: { message: "Redis/Database rate limit host unreachable" } });
        }
        return Promise.resolve({ data: "ok", error: null });
      });

      const req = createGetRequest(validRawToken);
      const res = await GET(req, createContext(validRawToken));

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
    });

    it("13. response includes Cache-Control: no-store header", async () => {
      const req = createGetRequest(validRawToken);
      const res = await GET(req, createContext(validRawToken));

      expect(res.headers.get("Cache-Control")).toContain("no-store");
    });

    it("14. token rate-limit key is identical across different IP addresses and forged headers", async () => {
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      const reqA = createGetRequest(validRawToken, { "x-forwarded-for": "1.1.1.1, 198.51.100.25" });
      await GET(reqA, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      const reqB = createGetRequest(validRawToken, { "x-forwarded-for": "999.999.999.999" });
      await GET(reqB, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      const reqC = createGetRequest(validRawToken, {
        "x-forwarded-for": "1.1.1.1",
        "x-real-ip": "198.51.100.50",
      });
      await GET(reqC, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      const reqD = createGetRequest(validRawToken, {});
      await GET(reqD, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);
    });

    it("15. with TRUST_PROXY unset or 'false', only the token limiter runs", async () => {
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      delete process.env.TRUST_PROXY;
      const req1 = createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.25" });
      await GET(req1, createContext(validRawToken));
      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      process.env.TRUST_PROXY = "false";
      const req2 = createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.25" });
      await GET(req2, createContext(validRawToken));
      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);
    });

    it("16. with TRUST_PROXY='true' and a valid IP, both independent limiters run", async () => {
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      process.env.TRUST_PROXY = "true";
      const req = createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.25" });
      const res = await GET(req, createContext(validRawToken));

      expect(res.status).toBe(200);
      expect(checkSpy).toHaveBeenCalledTimes(2);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);
      expect(checkSpy.mock.calls[1][0]).toBe("portal-get-ip:198.51.100.25");
    });

    it("17. different IP addresses do not create different token buckets", async () => {
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      process.env.TRUST_PROXY = "true";
      const reqA = createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.1" });
      await GET(reqA, createContext(validRawToken));

      const reqB = createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.2" });
      await GET(reqB, createContext(validRawToken));

      // Token limiter calls (the 1st and 3rd limiter calls) both use the same token key
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);
      expect(checkSpy.mock.calls[2][0]).toBe(`portal-get:${expectedTokenPrefix}`);
      // IP limiter calls (the 2nd and 4th calls) use independent IP keys
      expect(checkSpy.mock.calls[1][0]).toBe("portal-get-ip:198.51.100.1");
      expect(checkSpy.mock.calls[3][0]).toBe("portal-get-ip:198.51.100.2");
    });

    it("18. exhausting the token limit returns 429 even when the IP limit has capacity", async () => {
      process.env.TRUST_PROXY = "true";
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementation((key: string) => {
        if (key === `portal-get:${expectedTokenPrefix}`) {
          return Promise.resolve({
            allowed: false,
            current: 31,
            limit: 30,
            resetAt: Date.now() + 60000,
            status: "rate_limited",
            isUnavailable: false,
          });
        }
        return Promise.resolve({
          allowed: true,
          current: 1,
          limit: 30,
          resetAt: Date.now() + 60000,
          status: "allowed",
          isUnavailable: false,
        });
      });

      const req = createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.25" });
      const res = await GET(req, createContext(validRawToken));

      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("RATE_LIMITED");
    });

    it("19. exhausting the IP limit returns 429 when proxy trust is enabled", async () => {
      process.env.TRUST_PROXY = "true";
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementation((key: string) => {
        if (key === `portal-get:${expectedTokenPrefix}`) {
          return Promise.resolve({
            allowed: true,
            current: 1,
            limit: 30,
            resetAt: Date.now() + 60000,
            status: "allowed",
            isUnavailable: false,
          });
        }
        if (key === "portal-get-ip:198.51.100.25") {
          return Promise.resolve({
            allowed: false,
            current: 31,
            limit: 30,
            resetAt: Date.now() + 60000,
            status: "rate_limited",
            isUnavailable: false,
          });
        }
        return Promise.resolve({
          allowed: true,
          current: 1,
          limit: 30,
          resetAt: Date.now() + 60000,
          status: "allowed",
          isUnavailable: false,
        });
      });

      const req = createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.25" });
      const res = await GET(req, createContext(validRawToken));

      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("RATE_LIMITED");
    });

    it("20. failure of either required database-backed limiter returns 503", async () => {
      process.env.TRUST_PROXY = "true";
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      // Case A: Token limiter DB failure
      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementationOnce(() =>
        Promise.resolve({
          allowed: false,
          current: 31,
          limit: 30,
          resetAt: Date.now() + 60000,
          status: "service_unavailable",
          isUnavailable: true,
        })
      );
      const resA = await GET(createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.25" }), createContext(validRawToken));
      expect(resA.status).toBe(503);
      expect((await resA.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");

      // Case B: IP limiter DB failure
      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementation((key: string) => {
        if (key === `portal-get:${expectedTokenPrefix}`) {
          return Promise.resolve({
            allowed: true,
            current: 1,
            limit: 30,
            resetAt: Date.now() + 60000,
            status: "allowed",
            isUnavailable: false,
          });
        }
        return Promise.resolve({
          allowed: false,
          current: 31,
          limit: 30,
          resetAt: Date.now() + 60000,
          status: "service_unavailable",
          isUnavailable: true,
        });
      });
      const resB = await GET(createGetRequest(validRawToken, { "x-forwarded-for": "198.51.100.25" }), createContext(validRawToken));
      expect(resB.status).toBe(503);
      expect((await resB.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
    });

    it("21. invalid or missing IP information does not prevent the token limiter from running", async () => {
      process.env.TRUST_PROXY = "true";
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);

      const req = createGetRequest(validRawToken, { "x-forwarded-for": "malformed.ip.value" });
      const res = await GET(req, createContext(validRawToken));

      expect(res.status).toBe(200);
      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-get:${expectedTokenPrefix}`);
    });
  });

  // ==========================================================================
  // Section B: POST /api/public/portal/[token]/otp
  // ==========================================================================
  describe("POST /api/public/portal/[token]/otp", () => {
    it("1. valid invitation creates an OTP challenge and dispatches email", async () => {
      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({
        success: true,
        messageId: "mock-otp-msg-123",
      });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.expiresInSeconds).toBe(900);
      expect(json.message).toContain("verification code has been sent");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("2 & 3. generates cryptographically random 6-digit OTP code", async () => {
      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({
        success: true,
        messageId: "mock-otp-msg-123",
      });

      const req = createPostRequest(validRawToken);
      await POST(req, createContext(validRawToken));

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const callArgs = sendSpy.mock.calls[0][0];
      expect(callArgs.otpCode).toHaveLength(6);
      expect(callArgs.otpCode).toMatch(/^\d{6}$/);
    });

    it("4 & 5. generates 64-char hex HMAC using dedicated server-side secret", async () => {
      let capturedHmac = "";
      mockRpc.mockImplementation((rpcName: string, args: Record<string, unknown>) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (rpcName === "create_portal_otp_challenge") {
          capturedHmac = args.p_otp_hmac as string;
          return Promise.resolve({
            data: { challengeId: "c1", clientEmail: "client@test.com", projectTitle: "Project" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({
        success: true,
      });

      const req = createPostRequest(validRawToken);
      await POST(req, createContext(validRawToken));

      expect(capturedHmac).toHaveLength(64);
      expect(capturedHmac).toMatch(/^[a-f0-9]{64}$/);

      // Verify HMAC matches the dispatched OTP code with server secret
      const sentOtp = sendSpy.mock.calls[0][0].otpCode;
      expect(computePortalOtpHmac(sentOtp)).toBe(capturedHmac);
    });

    it("6. RPC receives only the invitation token hash and never the raw token", async () => {
      const rawToken = createPortalToken();
      const expectedHash = hashPortalToken(rawToken);

      let capturedTokenHash = "";
      mockRpc.mockImplementation((rpcName: string, args: Record<string, unknown>) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (rpcName === "create_portal_otp_challenge") {
          capturedTokenHash = args.p_portal_token_hash as string;
          return Promise.resolve({
            data: { challengeId: "c1", clientEmail: "client@test.com", projectTitle: "Project" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({ success: true });

      const req = createPostRequest(rawToken);
      await POST(req, createContext(rawToken));

      expect(capturedTokenHash).toBe(expectedHash);
      expect(capturedTokenHash).not.toBe(rawToken);
    });

    it("7. email recipient comes strictly from database RPC response", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (rpcName === "create_portal_otp_challenge") {
          return Promise.resolve({
            data: {
              challengeId: "c1",
              clientEmail: "strictly-verified-client@acme.org",
              projectTitle: "Acme Web App",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({ success: true });

      const req = createPostRequest(validRawToken);
      await POST(req, createContext(validRawToken));

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          clientEmail: "strictly-verified-client@acme.org",
          projectTitle: "Acme Web App",
        })
      );
    });

    it("8. request-supplied email addresses or unexpected body fields are rejected with 400", async () => {
      // Body attempting to inject recipient email
      const injectedReq = createPostRequest(validRawToken, {
        clientEmail: "attacker@evil.com",
      });
      const res = await POST(injectedReq, createContext(validRawToken));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");

      // Malformed JSON
      const malformedReq = createPostRequest(validRawToken, "{ bad-json");
      const malformedRes = await POST(malformedReq, createContext(validRawToken));
      expect(malformedRes.status).toBe(400);
      expect((await malformedRes.json()).error).toBe("INVALID_JSON");
    });

    it("9 & 10. successful dispatch returns HTTP 200", async () => {
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({ success: true });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    });

    it("11 & 12. OTP and HMAC are never returned in HTTP response", async () => {
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({ success: true });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));
      const json = await res.json();

      expect(json.otp).toBeUndefined();
      expect(json.otpCode).toBeUndefined();
      expect(json.otpHmac).toBeUndefined();
      expect(json.hmac).toBeUndefined();
      expect(json.token).toBeUndefined();
      expect(json.tokenHash).toBeUndefined();
    });

    it("13. email failure returns sanitized HTTP 502 without disclosing OTP", async () => {
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({
        success: false,
        error: "SMTP connection refused",
      });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));
      const json = await res.json();

      expect(res.status).toBe(502);
      expect(json.error).toBe("EMAIL_DELIVERY_FAILED");
      expect(json.otp).toBeUndefined();
    });

    it("14. database challenge creation failure prevents email dispatch", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (rpcName === "create_portal_otp_challenge") {
          return Promise.resolve({ data: null, error: { message: "Portal token is invalid, expired, or revoked" } });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail");

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("INVITATION_NOT_FOUND");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("15. rate-limit exhaustion returns 429", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
        allowed: false,
        current: 6,
        limit: 5,
        resetAt: Date.now() + 60000,
        status: "rate_limited",
        isUnavailable: false,
      });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));

      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("RATE_LIMITED");
    });

    it("16. rate-limiter infrastructure failure in production returns 503", async () => {
      setNodeEnv("production");
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: null, error: { message: "Database rate limit timeout" } });
        }
        return Promise.resolve({ data: "ok", error: null });
      });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
    });

    it("17. invalid invitation does not trigger email dispatch", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail");

      const req = createPostRequest("bad-token-does-not-exist-12345678");
      const res = await POST(req, createContext("bad-token-does-not-exist-12345678"));

      expect(res.status).toBe(404);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("18. expiry is consistent with 15-minute policy (900 seconds)", async () => {
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({ success: true });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));
      const json = await res.json();

      expect(json.expiresInSeconds).toBe(900);

      const challengeCalls = mockRpc.mock.calls.filter((c) => c[0] === "create_portal_otp_challenge");
      const rpcExpiresAt = new Date(challengeCalls[0][1].p_expires_at).getTime();
      const now = Date.now();
      const fifteenMinMs = 15 * 60 * 1000;

      expect(Math.abs(rpcExpiresAt - (now + fifteenMinMs))).toBeLessThan(5000);
    });

    it("19. response includes Cache-Control: no-store header", async () => {
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({ success: true });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));

      expect(res.headers.get("Cache-Control")).toContain("no-store");
    });

    it("20. RPC invocation strictly passes exact three arguments with required types and no surplus", async () => {
      let rpcCallArgs: Record<string, unknown> | null = null;
      mockRpc.mockImplementation((rpcName: string, args: Record<string, unknown>) => {
        if (rpcName === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (rpcName === "create_portal_otp_challenge") {
          rpcCallArgs = args;
          return Promise.resolve({
            data: { challengeId: "c1", clientEmail: "client@test.com", projectTitle: "Project" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({ success: true });

      const req = createPostRequest(validRawToken);
      const res = await POST(req, createContext(validRawToken));
      expect(res.status).toBe(200);

      expect(rpcCallArgs).not.toBeNull();
      const finalArgs = rpcCallArgs as unknown as Record<string, unknown>;
      const keys = Object.keys(finalArgs).sort();
      expect(keys).toEqual(["p_expires_at", "p_otp_hmac", "p_portal_token_hash"]);

      expect(typeof finalArgs.p_portal_token_hash).toBe("string");
      expect(typeof finalArgs.p_otp_hmac).toBe("string");
      expect(typeof finalArgs.p_expires_at).toBe("string");
    });

    it("21. token rate-limit key is identical across different IP addresses and forged headers", async () => {
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValue({ success: true });

      const reqA = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "1.1.1.1, 198.51.100.25" });
      await POST(reqA, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      const reqB = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "999.999.999.999" });
      await POST(reqB, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      const reqC = createPostRequest(validRawToken, undefined, {
        "x-forwarded-for": "1.1.1.1",
        "x-real-ip": "198.51.100.50",
      });
      await POST(reqC, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      const reqD = createPostRequest(validRawToken, undefined, {});
      await POST(reqD, createContext(validRawToken));
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);
    });

    it("22. with TRUST_PROXY unset or 'false', only the token limiter runs", async () => {
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValue({ success: true });

      delete process.env.TRUST_PROXY;
      const req1 = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "198.51.100.25" });
      await POST(req1, createContext(validRawToken));
      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);

      checkSpy.mockClear();

      process.env.TRUST_PROXY = "false";
      const req2 = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "198.51.100.25" });
      await POST(req2, createContext(validRawToken));
      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);
    });

    it("23. with TRUST_PROXY='true' and a valid IP, both independent limiters run", async () => {
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValue({ success: true });

      process.env.TRUST_PROXY = "true";
      const req = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "198.51.100.25" });
      const res = await POST(req, createContext(validRawToken));

      expect(res.status).toBe(200);
      expect(checkSpy).toHaveBeenCalledTimes(2);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);
      expect(checkSpy.mock.calls[1][0]).toBe("portal-otp-ip:198.51.100.25");
    });

    it("24. exhausting the token limit returns 429 even when the IP limit has capacity", async () => {
      process.env.TRUST_PROXY = "true";
      const expectedTokenPrefix = hashPortalToken(validRawToken);
      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail");

      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementation((key: string) => {
        if (key === `portal-otp:${expectedTokenPrefix}`) {
          return Promise.resolve({
            allowed: false,
            current: 6,
            limit: 5,
            resetAt: Date.now() + 60000,
            status: "rate_limited",
            isUnavailable: false,
          });
        }
        return Promise.resolve({
          allowed: true,
          current: 1,
          limit: 5,
          resetAt: Date.now() + 60000,
          status: "allowed",
          isUnavailable: false,
        });
      });

      const req = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "198.51.100.25" });
      const res = await POST(req, createContext(validRawToken));

      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("RATE_LIMITED");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("25. exhausting the IP limit returns 429 when proxy trust is enabled", async () => {
      process.env.TRUST_PROXY = "true";
      const expectedTokenPrefix = hashPortalToken(validRawToken);
      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail");

      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementation((key: string) => {
        if (key === `portal-otp:${expectedTokenPrefix}`) {
          return Promise.resolve({
            allowed: true,
            current: 1,
            limit: 5,
            resetAt: Date.now() + 60000,
            status: "allowed",
            isUnavailable: false,
          });
        }
        if (key === "portal-otp-ip:198.51.100.25") {
          return Promise.resolve({
            allowed: false,
            current: 6,
            limit: 5,
            resetAt: Date.now() + 60000,
            status: "rate_limited",
            isUnavailable: false,
          });
        }
        return Promise.resolve({
          allowed: true,
          current: 1,
          limit: 5,
          resetAt: Date.now() + 60000,
          status: "allowed",
          isUnavailable: false,
        });
      });

      const req = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "198.51.100.25" });
      const res = await POST(req, createContext(validRawToken));

      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("RATE_LIMITED");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("26. failure of either required database-backed limiter returns 503", async () => {
      process.env.TRUST_PROXY = "true";
      const expectedTokenPrefix = hashPortalToken(validRawToken);
      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail");

      // Case A: Token limiter DB failure
      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementationOnce(() =>
        Promise.resolve({
          allowed: false,
          current: 6,
          limit: 5,
          resetAt: Date.now() + 60000,
          status: "service_unavailable",
          isUnavailable: true,
        })
      );
      const resA = await POST(createPostRequest(validRawToken, undefined, { "x-forwarded-for": "198.51.100.25" }), createContext(validRawToken));
      expect(resA.status).toBe(503);
      expect((await resA.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
      expect(sendSpy).not.toHaveBeenCalled();

      // Case B: IP limiter DB failure
      vi.spyOn(rateLimitModule, "checkRateLimit").mockImplementation((key: string) => {
        if (key === `portal-otp:${expectedTokenPrefix}`) {
          return Promise.resolve({
            allowed: true,
            current: 1,
            limit: 5,
            resetAt: Date.now() + 60000,
            status: "allowed",
            isUnavailable: false,
          });
        }
        return Promise.resolve({
          allowed: false,
          current: 6,
          limit: 5,
          resetAt: Date.now() + 60000,
          status: "service_unavailable",
          isUnavailable: true,
        });
      });
      const resB = await POST(createPostRequest(validRawToken, undefined, { "x-forwarded-for": "198.51.100.25" }), createContext(validRawToken));
      expect(resB.status).toBe(503);
      expect((await resB.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("27. invalid or missing IP information does not prevent the token limiter from running", async () => {
      process.env.TRUST_PROXY = "true";
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");
      const expectedTokenPrefix = hashPortalToken(validRawToken);
      vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValue({ success: true });

      const req = createPostRequest(validRawToken, undefined, { "x-forwarded-for": "malformed.ip.value" });
      const res = await POST(req, createContext(validRawToken));

      expect(res.status).toBe(200);
      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-otp:${expectedTokenPrefix}`);
    });
  });

  // ==========================================================================
  // Section C: Static Migration Security Assertions (202611030011)
  // ==========================================================================
  describe("Static Security Assertions: Migration 202611030011", () => {
    const migrationPath = resolve(process.cwd(), "supabase/migrations/202611030011_public_portal_token_validation.sql");
    const migrationSql = readFileSync(migrationPath, "utf-8");

    it("enforces SECURITY DEFINER with empty search_path", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.validate_portal_invitation/i);
      expect(migrationSql).toMatch(/security\s+definer/i);
      expect(migrationSql).toMatch(/set\s+search_path\s*=\s*''/i);
    });

    it("schema-qualifies table references to client_portal_tokens and projects", () => {
      expect(migrationSql).toMatch(/from\s+public\.client_portal_tokens/i);
      expect(migrationSql).toMatch(/from\s+public\.projects/i);
    });

    it("validates revoked_at, consumed_at, expires_at, and client_email_verified_at", () => {
      expect(migrationSql).toMatch(/revoked_at\s+is\s+not\s+null/i);
      expect(migrationSql).toMatch(/consumed_at\s+is\s+not\s+null/i);
      expect(migrationSql).toMatch(/expires_at\s*<=\s*now\(\)/i);
      expect(migrationSql).toMatch(/client_email_verified_at\s+is\s+null/i);
    });

    it("returns null for invalid tokens and jsonb with safe metadata for valid tokens", () => {
      expect(migrationSql).toMatch(/return\s+null;/i);
      expect(migrationSql).toMatch(/jsonb_build_object\s*\(\s*'valid',\s*true/i);
      expect(migrationSql).toMatch(/'projectTitle',\s*v_project\.title/i);
      expect(migrationSql).toMatch(/'expiresAt',\s*v_token\.expires_at/i);
    });

    it("revokes all permissions from public and grants execute strictly to anon, authenticated", () => {
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.validate_portal_invitation\(text\)\s+from\s+public;/i);
      expect(migrationSql).toMatch(/grant\s+execute\s+on\s+function\s+public\.validate_portal_invitation\(text\)\s+to\s+anon,\s+authenticated;/i);
    });

    it("does not mutate tables (contains no insert, update, delete, or for update clauses)", () => {
      expect(migrationSql).not.toMatch(/\binsert\s+into\b/i);
      expect(migrationSql).not.toMatch(/\bupdate\s+public\b/i);
      expect(migrationSql).not.toMatch(/\bdelete\s+from\b/i);
      expect(migrationSql).not.toMatch(/\bfor\s+update\b/i);
    });
  });

  // ==========================================================================
  // Section D: Static Security Assertions: Database RPC Contract & Challenge Lifecycle (202611030005)
  // ==========================================================================
  describe("Static Security Assertions: Database RPC Contract & Challenge Lifecycle (Migration 202611030005)", () => {
    const migrationPath = resolve(process.cwd(), "supabase/migrations/202611030005_payment_foundation_and_ledger.sql");
    const migrationSql = readFileSync(migrationPath, "utf-8");

    it("defines create_portal_otp_challenge with exact 3 parameters", () => {
      expect(migrationSql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.create_portal_otp_challenge\s*\(\s*p_portal_token_hash\s+text,\s*p_otp_hmac\s+text,\s*p_expires_at\s+timestamptz\s*\)/i
      );
      expect(migrationSql).toMatch(/returns\s+jsonb\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i);
    });

    it("grants create_portal_otp_challenge strictly to anon, authenticated with public revoked", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_portal_otp_challenge\(text,\s*text,\s*timestamptz\)\s+from\s+public;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.create_portal_otp_challenge\(text,\s*text,\s*timestamptz\)\s+to\s+anon,\s+authenticated;/i
      );
    });

    it("invalidates prior unconsumed challenges for the token upon creating a new challenge (challenge replacement)", () => {
      // Replaces prior active challenges by setting consumed_at = now()
      expect(migrationSql).toMatch(
        /update\s+public\.client_portal_otp_challenges\s+set\s+consumed_at\s*=\s*now\(\)\s+where\s+portal_token_id\s*=\s*v_token\.id\s+and\s+consumed_at\s+is\s+null;/i
      );
    });

    it("binds new challenge row to project_id, portal_token_id, verified client_email, and expiration", () => {
      expect(migrationSql).toMatch(/insert\s+into\s+public\.client_portal_otp_challenges\s*\(\s*project_id,\s*portal_token_id,\s*client_email,\s*otp_hmac,\s*expires_at\s*\)/i);
    });

    it("enforces 5-attempt limit and increments attempts persistently in consume_portal_otp_and_create_session", () => {
      expect(migrationSql).toMatch(/if\s+v_challenge\.attempts\s*>=\s*5\s+then\s+return\s+jsonb_build_object\('status',\s*'EXHAUSTED'/i);
      expect(migrationSql).toMatch(/update\s+public\.client_portal_otp_challenges\s+set\s+attempts\s*=\s*attempts\s*\+\s*1/i);
    });

    it("commits attempt count on HMAC mismatch rather than rolling back", () => {
      expect(migrationSql).toMatch(/if\s+v_challenge\.otp_hmac\s*<>\s*p_otp_hmac\s+then/i);
      expect(migrationSql).toMatch(/return\s+jsonb_build_object\('status',\s*'INVALID_OTP'/i);
    });

    it("strictly checks challenge expiry before OTP verification", () => {
      expect(migrationSql).toMatch(/if\s+v_challenge\.expires_at\s*<=\s*now\(\)\s+then\s+return\s+jsonb_build_object\('status',\s*'EXPIRED'\);/i);
    });

    it("enforces 64-char OTP HMAC check constraint in schema definition", () => {
      expect(migrationSql).toMatch(/otp_hmac\s+text\s+not\s+null\s+check\s*\(\s*char_length\(otp_hmac\)\s*=\s*64\s*\)/i);
    });

    it("atomically consumes both challenge and portal token on verification success", () => {
      expect(migrationSql).toMatch(
        /update\s+public\.client_portal_otp_challenges\s+set\s+consumed_at\s*=\s*now\(\)\s+where\s+id\s*=\s*v_challenge\.id;/i
      );
      expect(migrationSql).toMatch(
        /update\s+public\.client_portal_tokens\s+set\s+consumed_at\s*=\s*now\(\)\s+where\s+id\s*=\s*v_challenge\.portal_token_id;/i
      );
    });
  });
});
