import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  authenticatePortalSession,
  PORTAL_SESSION_COOKIE_NAME_DEV,
  AuthenticatePortalSessionOptions,
} from "./portal-session";
import { hashSessionToken } from "./tokens";

const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

describe("Portal Session Authentication Helper: authenticatePortalSession", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const validRawToken = "valid-test-portal-session-token-43-chars___";
  const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const validProjectId = "p0000000-0000-4000-a000-000000000001";
  const validSessionId = "s0000000-0000-4000-a000-000000000001";
  const validClientEmail = "client@acme-corp.com";

  let mockRpc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;

    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === PORTAL_SESSION_COOKIE_NAME_DEV) {
        return { value: validRawToken };
      }
      return undefined;
    });

    mockRpc = vi.fn().mockImplementation((name: string) => {
      if (name === "validate_portal_session") {
        return Promise.resolve({
          data: {
            valid: true,
            sessionId: validSessionId,
            projectId: validProjectId,
            clientEmail: validClientEmail,
            csrfSecret: validCsrfSecret,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  function createMockSupabaseClient() {
    return { rpc: mockRpc } as unknown as NonNullable<AuthenticatePortalSessionOptions["supabaseClient"]>;
  }

  // ==========================================================================
  // 1. Successful Authentication & Session Extraction
  // ==========================================================================
  it("1. successfully authenticates a valid session and returns typed metadata", async () => {
    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.sessionId).toBe(validSessionId);
      expect(result.projectId).toBe(validProjectId);
      expect(result.clientEmail).toBe(validClientEmail);
      expect(result.csrfSecret).toBe(validCsrfSecret);

      // Verify raw token is never exposed, but derived sessionTokenHash is securely provided
      expect(result).not.toHaveProperty("rawSessionToken");
      expect(result.sessionTokenHash).toBe(hashSessionToken(validRawToken));
    }

    expect(mockRpc).toHaveBeenCalledWith("validate_portal_session", {
      p_session_token_hash: hashSessionToken(validRawToken),
    });
  });

  // ==========================================================================
  // 2. Cookie & Token Format Validation
  // ==========================================================================
  it("2. returns 401 UNAUTHORIZED when session cookie is missing", async () => {
    mockCookieStore.get.mockReturnValue(undefined);

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("UNAUTHORIZED");
      expect(result.reason).toBe("MISSING_SESSION_COOKIE");
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("3. returns 401 UNAUTHORIZED when session token is malformed (not 43 chars)", async () => {
    mockCookieStore.get.mockReturnValue({ value: "short-token" });

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("UNAUTHORIZED");
      expect(result.reason).toBe("MALFORMED_SESSION_TOKEN");
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 3. Database Session Expiration & Invalidation Reasons
  // ==========================================================================
  it("4. returns 401 SESSION_EXPIRED on absolute 12-hour timeout", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { valid: false, reason: "ABSOLUTE_EXPIRY" },
      error: null,
    });

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("SESSION_EXPIRED");
    }
  });

  it("5. returns 401 SESSION_IDLE_TIMEOUT on 60-minute idle timeout", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { valid: false, reason: "IDLE_TIMEOUT" },
      error: null,
    });

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("SESSION_IDLE_TIMEOUT");
    }
  });

  it("6. returns 401 AUTHENTICATION_FAILED if client email changed or unverified", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { valid: false, reason: "CLIENT_EMAIL_CHANGED" },
      error: null,
    });

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("AUTHENTICATION_FAILED");
    }
  });

  it("7. returns 401 UNAUTHORIZED on revoked or missing session", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { valid: false, reason: "REVOKED_OR_NOT_FOUND" },
      error: null,
    });

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("UNAUTHORIZED");
    }
  });

  // ==========================================================================
  // 4. Infrastructure Failures & Malformed Metadata
  // ==========================================================================
  it("8. returns 503 DATABASE_UNAVAILABLE when database RPC encounters infrastructure error", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "connection to server at 'db.supabase.co' failed: timeout" },
    });

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(503);
      expect(result.error).toBe("DATABASE_UNAVAILABLE");
    }
  });

  it("9. returns 500 SERVER_ERROR when database returns missing or malformed metadata", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { valid: true, sessionId: "", projectId: validProjectId },
      error: null,
    });

    const result = await authenticatePortalSession({
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("SERVER_ERROR");
    }
  });

  // ==========================================================================
  // 5. Contextual Project Binding Verification
  // ==========================================================================
  it("10. succeeds when session project matches expectedProjectId", async () => {
    const result = await authenticatePortalSession({
      expectedProjectId: validProjectId,
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(true);
  });

  it("11. returns 403 FORBIDDEN when session project does not match expectedProjectId", async () => {
    const differentProjectId = "p9999999-9999-4999-a999-999999999999";
    const result = await authenticatePortalSession({
      expectedProjectId: differentProjectId,
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(403);
      expect(result.error).toBe("FORBIDDEN");
      expect(result.reason).toBe("PROJECT_MISMATCH");
    }
  });

  // ==========================================================================
  // 6. Timing-Safe CSRF Token Validation
  // ==========================================================================
  it("12. succeeds for mutating requests when valid matching CSRF token is provided", async () => {
    const result = await authenticatePortalSession({
      requireCsrf: true,
      csrfToken: validCsrfSecret,
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(true);
  });

  it("13. returns 403 INVALID_CSRF_TOKEN when CSRF is required but missing or null", async () => {
    const result = await authenticatePortalSession({
      requireCsrf: true,
      csrfToken: null,
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(403);
      expect(result.error).toBe("INVALID_CSRF_TOKEN");
    }
  });

  it("14. returns 403 INVALID_CSRF_TOKEN when CSRF token is mismatched or malformed", async () => {
    const mismatchedCsrf = "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const result = await authenticatePortalSession({
      requireCsrf: true,
      csrfToken: mismatchedCsrf,
      supabaseClient: createMockSupabaseClient(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(403);
      expect(result.error).toBe("INVALID_CSRF_TOKEN");
    }
  });
});
