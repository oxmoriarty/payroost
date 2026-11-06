import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POST, DELETE } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import { hashPortalToken, hashSessionToken } from "@/lib/security/tokens";
import { computePortalOtpHmac } from "@/lib/security/portal-otp";

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: mockRpc,
  })),
}));

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

function setNodeEnv(env: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = env;
}

describe("Phase 3B.2.5: Public Portal OTP Verification & Session Establishment", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHmacSecret = process.env.PORTAL_OTP_HMAC_SECRET;

  const validToken = "valid-test-portal-token-43-chars-long-base64url_";
  const validChallengeId = "c0000000-0000-4000-a000-000000000001";
  const validOtp = "123456";

  beforeEach(() => {
    vi.clearAllMocks();
    setNodeEnv(originalNodeEnv);
    process.env.PORTAL_OTP_HMAC_SECRET = "test-hmac-secret-min-32-bytes-long-for-testing!!";
    delete process.env.TRUST_PROXY;

    // Default mock behaviors
    mockCookieStore.get.mockReturnValue(undefined);
    mockCookieStore.set.mockReturnValue(undefined);

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({
          data: { allowed: true, current: 1, limit: 5, resetAt: new Date(Date.now() + 60000).toISOString() },
          error: null,
        });
      }
      if (rpcName === "verify_portal_otp_and_create_session") {
        return Promise.resolve({
          data: {
            status: "SUCCESS",
            sessionId: "s0000000-0000-4000-a000-000000000001",
          },
          error: null,
        });
      }
      if (rpcName === "revoke_portal_session_v2") {
        return Promise.resolve({
          data: { success: true, revoked: true },
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
    return new Request(`https://payroost.com/api/public/portal/${token}/session`, init);
  }

  function createDeleteRequest(token: string, headers?: Record<string, string>) {
    return new Request(`https://payroost.com/api/public/portal/${token}/session`, {
      method: "DELETE",
      headers: {
        "x-forwarded-for": "198.51.100.25",
        ...headers,
      },
    });
  }

  function createContext(token: string) {
    return { params: Promise.resolve({ token }) };
  }

  // ==========================================================================
  // Section A: Static Database Migration & Security Assertions
  // ==========================================================================
  describe("Database Migration 202611030012: Security & RPC Contract Assertions", () => {
    const migrationPath = resolve(
      process.cwd(),
      "supabase/migrations/202611030012_portal_session_verification_hardening.sql"
    );
    const sql = readFileSync(migrationPath, "utf-8");

    it("1. revokes obsolete consume_portal_otp_and_create_session from public, anon, and authenticated", () => {
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.consume_portal_otp_and_create_session\s*\([^)]*\)\s+from\s+public,\s*anon,\s*authenticated/i
      );
    });

    it("2. defines verify_portal_otp_and_create_session as SECURITY DEFINER with empty search_path", () => {
      expect(sql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.verify_portal_otp_and_create_session\s*\(/i
      );
      expect(sql).toMatch(/security\s+definer/i);
      expect(sql).toMatch(/set\s+search_path\s*=\s*''/i);
    });

    it("3. requires invitation token hash parameter to cryptographically bind challenge to URL token", () => {
      expect(sql).toMatch(/p_portal_token_hash\s+text/i);
      expect(sql).toMatch(/p_challenge_id\s+uuid/i);
      expect(sql).toMatch(/p_otp_hmac\s+text/i);
      expect(sql).toMatch(/p_session_token_hash\s+text/i);
      expect(sql).toMatch(/p_csrf_secret\s+text/i);
    });

    it("4. acquires row-level locks on invitation token and challenge (FOR UPDATE)", () => {
      expect(sql).toMatch(/from\s+public\.client_portal_tokens[\s\S]*?for\s+update/i);
      expect(sql).toMatch(/from\s+public\.client_portal_otp_challenges[\s\S]*?for\s+update/i);
    });

    it("5. verifies challenge is relationally bound to invitation token (portal_token_id and project_id)", () => {
      expect(sql).toMatch(/v_challenge\.portal_token_id\s*<>\s*v_token\.id/i);
      expect(sql).toMatch(/v_challenge\.project_id\s*<>\s*v_token\.project_id/i);
    });

    it("6. checks challenge lifecycle: consumed_at, expires_at, and attempt ceiling", () => {
      expect(sql).toMatch(/v_challenge\.consumed_at\s+is\s+not\s+null/i);
      expect(sql).toMatch(/v_challenge\.expires_at\s*<=\s*now\(\)/i);
      expect(sql).toMatch(/v_challenge\.attempts\s*>=\s*5/i);
    });

    it("7. atomically increments attempts and commits counter on HMAC mismatch", () => {
      expect(sql).toMatch(/update\s+public\.client_portal_otp_challenges\s+set\s+attempts\s*=\s*attempts\s*\+\s*1/i);
      expect(sql).toMatch(/returning\s+attempts\s+into\s+v_new_attempts/i);
    });

    it("8. atomically marks both challenge and token consumed on successful verification", () => {
      expect(sql).toMatch(/update\s+public\.client_portal_otp_challenges\s+set\s+consumed_at\s*=\s*now\(\)/i);
      expect(sql).toMatch(/update\s+public\.client_portal_tokens\s+set\s+consumed_at\s*=\s*now\(\)/i);
    });

    it("9. inserts new session into public.client_portal_sessions with CSRF secret and bound duration", () => {
      expect(sql).toMatch(/insert\s+into\s+public\.client_portal_sessions/i);
      expect(sql).toMatch(/p_session_token_hash/i);
      expect(sql).toMatch(/p_csrf_secret/i);
    });

    it("10. grants verify_portal_otp_and_create_session to anon, authenticated, and service_role", () => {
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.verify_portal_otp_and_create_session\s*\([^)]*\)\s+from\s+public/i
      );
      expect(sql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.verify_portal_otp_and_create_session\s*\([^)]*\)\s+to\s+anon,\s*authenticated/i
      );
    });

    it("11. defines revoke_portal_session_v2 enforcing project binding from invitation token hash", () => {
      expect(sql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.revoke_portal_session_v2\s*\(/i
      );
      expect(sql).toMatch(/p_portal_token_hash\s+text/i);
      expect(sql).toMatch(/p_session_token_hash\s+text/i);
      expect(sql).toMatch(/project_id\s*=\s*v_project_id/i);
    });
  });

  // ==========================================================================
  // Section B: POST /api/public/portal/[token]/session (Verification Route)
  // ==========================================================================
  describe("POST /api/public/portal/[token]/session", () => {
    it("1. successful OTP verification creates session, sets HttpOnly cookie, and returns CSRF secret", async () => {
      let passedArgs: Record<string, unknown> = {};
      mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          passedArgs = args;
          return Promise.resolve({
            data: { status: "SUCCESS", sessionId: "session-uuid-1234" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(typeof json.csrfToken).toBe("string");
      expect(json.csrfToken).toHaveLength(64);
      expect(res.headers.get("Cache-Control")).toContain("no-store");

      // Verify RPC received correct parameters
      expect(passedArgs.p_portal_token_hash).toBe(hashPortalToken(validToken));
      expect(passedArgs.p_challenge_id).toBe(validChallengeId);
      expect(passedArgs.p_otp_hmac).toBe(computePortalOtpHmac(validOtp));
      expect(typeof passedArgs.p_session_token_hash).toBe("string");
      expect(passedArgs.p_session_token_hash).toHaveLength(64);
      expect(passedArgs.p_csrf_secret).toBe(json.csrfToken);
      expect(passedArgs.p_session_duration).toBe("12 hours");

      // Verify HttpOnly cookie was set
      expect(mockCookieStore.set).toHaveBeenCalledTimes(1);
      const [cookieName, cookieValue, cookieOptions] = mockCookieStore.set.mock.calls[0];
      expect(cookieName).toBe("payroost_client_session"); // non-prod name
      expect(typeof cookieValue).toBe("string");
      expect(cookieValue).toHaveLength(43); // rawSessionToken
      expect(cookieOptions.httpOnly).toBe(true);
      expect(cookieOptions.sameSite).toBe("lax");
      expect(cookieOptions.path).toBe("/");
      expect(cookieOptions.maxAge).toBe(43200);

      // Verify rawSessionToken is NEVER exposed in the JSON response
      expect(JSON.stringify(json)).not.toContain(cookieValue);
      expect(JSON.stringify(json)).not.toContain(validOtp);
    });

    it("2. incorrect OTP returns 401 with remaining attempts and does NOT set cookie", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({
            data: { status: "INVALID_OTP", remainingAttempts: 3, attempts: 2 },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: "999999",
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe("INVALID_OTP");
      expect(json.remainingAttempts).toBe(3);
      expect(mockCookieStore.set).not.toHaveBeenCalled();
      expect(res.headers.get("Cache-Control")).toContain("no-store");
    });

    it("3. exhausted challenge returns 401 OTP_EXHAUSTED with remainingAttempts 0 and no cookie", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({
            data: { status: "OTP_EXHAUSTED", remainingAttempts: 0, attempts: 5 },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: "999999",
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe("OTP_EXHAUSTED");
      expect(json.remainingAttempts).toBe(0);
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("4. expired challenge returns 401 OTP_EXPIRED and no cookie", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({
            data: { status: "OTP_EXPIRED" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe("OTP_EXPIRED");
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("5. challenge already consumed returns 401 CHALLENGE_ALREADY_CONSUMED and no cookie", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({
            data: { status: "CHALLENGE_ALREADY_CONSUMED" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe("CHALLENGE_ALREADY_CONSUMED");
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("6. challenge dissociated from invitation returns sanitized 404 INVITATION_NOT_FOUND", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({
            data: { status: "CHALLENGE_NOT_FOUND" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.error).toBe("INVITATION_NOT_FOUND");
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("7. invalid/expired/revoked invitation returns 404 INVITATION_NOT_FOUND", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({
            data: { status: "INVITATION_NOT_FOUND" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.error).toBe("INVITATION_NOT_FOUND");
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("8. client email changed/unverified returns 401 AUTHENTICATION_FAILED", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({
            data: { status: "CLIENT_EMAIL_CHANGED" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });

      const res = await POST(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe("AUTHENTICATION_FAILED");
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("9. rejects malformed URL token with 404", async () => {
      const invalidToken = "short";
      const req = createPostRequest(invalidToken, { challengeId: validChallengeId, otp: validOtp });
      const res = await POST(req, createContext(invalidToken));

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("INVITATION_NOT_FOUND");
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("10. rejects empty or non-JSON body with 400", async () => {
      const req1 = createPostRequest(validToken, "");
      const res1 = await POST(req1, createContext(validToken));
      expect(res1.status).toBe(400);

      const req2 = createPostRequest(validToken, "not-json");
      const res2 = await POST(req2, createContext(validToken));
      expect(res2.status).toBe(400);
      expect((await res2.json()).error).toBe("INVALID_JSON");
    });

    it("11. rejects invalid challengeId format with 400", async () => {
      const req = createPostRequest(validToken, {
        challengeId: "not-a-uuid",
        otp: validOtp,
      });
      const res = await POST(req, createContext(validToken));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
    });

    it("12. rejects invalid OTP formats (not 6 numeric digits) with 400", async () => {
      for (const badOtp of ["12345", "1234567", "abcdef", "12345a", ""]) {
        const req = createPostRequest(validToken, {
          challengeId: validChallengeId,
          otp: badOtp,
        });
        const res = await POST(req, createContext(validToken));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("VALIDATION_ERROR");
      }
    });

    it("13. rejects extra caller-supplied parameters with 400", async () => {
      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
        injectedRole: "admin",
      });
      const res = await POST(req, createContext(validToken));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
    });

    it("14. database RPC failure returns 500 SERVER_ERROR and does not set cookie", async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === "consume_rate_limit") {
          return Promise.resolve({ data: { allowed: true, current: 1, limit: 5, resetAt: new Date().toISOString() }, error: null });
        }
        if (name === "verify_portal_otp_and_create_session") {
          return Promise.resolve({ data: null, error: { message: "connection timeout" } });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });
      const res = await POST(req, createContext(validToken));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("SERVER_ERROR");
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("15. token rate-limit exhaustion returns 429", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
        allowed: false,
        current: 6,
        limit: 5,
        resetAt: Date.now() + 60000,
        status: "rate_limited",
        isUnavailable: false,
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });
      const res = await POST(req, createContext(validToken));
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("RATE_LIMITED");
      expect(mockCookieStore.set).not.toHaveBeenCalled();
    });

    it("16. token rate-limiter infrastructure failure returns 503", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
        allowed: false,
        current: 6,
        limit: 5,
        resetAt: Date.now() + 60000,
        status: "service_unavailable",
        isUnavailable: true,
      });

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      });
      const res = await POST(req, createContext(validToken));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("RATE_LIMITER_UNAVAILABLE");
    });

    it("17. with TRUST_PROXY='true' and valid IP, independent IP rate limit runs", async () => {
      process.env.TRUST_PROXY = "true";
      const checkSpy = vi.spyOn(rateLimitModule, "checkRateLimit");

      const req = createPostRequest(validToken, {
        challengeId: validChallengeId,
        otp: validOtp,
      }, { "x-forwarded-for": "198.51.100.25" });

      const res = await POST(req, createContext(validToken));
      expect(res.status).toBe(200);

      expect(checkSpy).toHaveBeenCalledTimes(2);
      const expectedTokenPrefix = hashPortalToken(validToken);
      expect(checkSpy.mock.calls[0][0]).toBe(`portal-session:${expectedTokenPrefix}`);
      expect(checkSpy.mock.calls[1][0]).toBe("portal-session-ip:198.51.100.25");
    });
  });

  // ==========================================================================
  // Section C: DELETE /api/public/portal/[token]/session (Logout Route)
  // ==========================================================================
  describe("DELETE /api/public/portal/[token]/session", () => {
    const rawSessionToken = "valid-raw-session-token-43-chars-base64url__";

    it("1. valid active session is revoked and cookie is cleared", async () => {
      mockCookieStore.get.mockReturnValue({ value: rawSessionToken });

      let passedArgs: Record<string, unknown> = {};
      mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
        if (name === "revoke_portal_session_v2") {
          passedArgs = args;
          return Promise.resolve({ data: { success: true, revoked: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createDeleteRequest(validToken);
      const res = await DELETE(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(res.headers.get("Cache-Control")).toContain("no-store");

      // Verify RPC was invoked with hashes, never raw tokens
      expect(passedArgs.p_portal_token_hash).toBe(hashPortalToken(validToken));
      expect(passedArgs.p_session_token_hash).toBe(hashSessionToken(rawSessionToken));

      // Verify cookie was cleared (maxAge: 0)
      expect(mockCookieStore.set).toHaveBeenCalledTimes(1);
      const [cookieName, cookieValue, cookieOptions] = mockCookieStore.set.mock.calls[0];
      expect(cookieName).toBe("payroost_client_session");
      expect(cookieValue).toBe("");
      expect(cookieOptions.maxAge).toBe(0);

      // Verify rawSessionToken is NEVER exposed in the JSON response
      expect(JSON.stringify(json)).not.toContain(rawSessionToken);
    });

    it("2. missing session cookie returns 200 and clears cookie safely (idempotent)", async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      const req = createDeleteRequest(validToken);
      const res = await DELETE(req, createContext(validToken));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockCookieStore.set).toHaveBeenCalledTimes(1);
      expect(mockCookieStore.set.mock.calls[0][2].maxAge).toBe(0);
    });

    it("3. database RPC failure returns 500 SERVER_ERROR without false success", async () => {
      mockCookieStore.get.mockReturnValue({ value: rawSessionToken });
      mockRpc.mockImplementation((name: string) => {
        if (name === "revoke_portal_session_v2") {
          return Promise.resolve({ data: null, error: { message: "database offline" } });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createDeleteRequest(validToken);
      const res = await DELETE(req, createContext(validToken));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("SERVER_ERROR");
    });

    it("4. rejects malformed URL token with 404", async () => {
      const invalidToken = "short";
      const req = createDeleteRequest(invalidToken);
      const res = await DELETE(req, createContext(invalidToken));

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("INVITATION_NOT_FOUND");
    });

    it("5. repeated logout calls are safe and idempotent", async () => {
      mockCookieStore.get.mockReturnValue({ value: rawSessionToken });

      const req1 = createDeleteRequest(validToken);
      const res1 = await DELETE(req1, createContext(validToken));
      expect(res1.status).toBe(200);

      // Second logout with no active cookie
      mockCookieStore.get.mockReturnValue(undefined);
      const req2 = createDeleteRequest(validToken);
      const res2 = await DELETE(req2, createContext(validToken));
      expect(res2.status).toBe(200);
    });
  });
});
