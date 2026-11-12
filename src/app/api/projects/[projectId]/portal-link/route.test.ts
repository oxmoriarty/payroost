import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { POST, PORTAL_TOKEN_EXPIRY_DAYS } from "./route";
import * as emailProvider from "@/lib/email/provider";
import * as rateLimitModule from "@/lib/security/rate-limit";
import { hashPortalToken } from "@/lib/security/tokens";

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

const mockSupabase = {
  auth: { getUser: mockGetUser },
  rpc: mockRpc,
  from: mockFrom,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

function setNodeEnv(env: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = env;
}

describe("Phase 3B.2.3 & 3B.2.3.1: Owner Portal-Link Issuance (POST /api/projects/[projectId]/portal-link)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAppUrl = process.env.PAYROOST_APP_URL;
  const originalNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  let testCounter = 0;
  function getUniqueProjectId() {
    testCounter++;
    const hex = testCounter.toString(16).padStart(12, "0");
    return `a0000000-0000-4000-a000-${hex}`;
  }

  const validUser = { id: "u0000000-0000-4000-a000-000000000001", email: "owner@payroost.dev" };

  beforeEach(() => {
    vi.clearAllMocks();
    emailProvider.emailDeliveryLog.length = 0;
    setNodeEnv(originalNodeEnv);
    process.env.PAYROOST_APP_URL = "https://app.payroost.com";
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    // Default mock behavior: Authenticated owner with successful RPC and valid project
    mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({
          data: { allowed: true, current: 1, limit: 10, resetAt: new Date(Date.now() + 60000).toISOString() },
          error: null,
        });
      }
      if (rpcName === "create_client_portal_token") {
        return Promise.resolve({
          data: "t0000000-0000-4000-a000-000000000001",
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    mockMaybeSingle.mockImplementation(() =>
      Promise.resolve({
        data: {
          id: getUniqueProjectId(),
          title: "Brand Redesign & Checkout Portal",
          client_name: "Acme Corp",
          client_email: "verified-client@acme.com",
        },
        error: null,
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setNodeEnv(originalNodeEnv);
    process.env.PAYROOST_APP_URL = originalAppUrl;
    process.env.NEXT_PUBLIC_APP_URL = originalNextPublicAppUrl;
  });

  function createRequest(projectId: string, body?: unknown, headers?: Record<string, string>) {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return new Request(`https://payroost.com/api/projects/${projectId}/portal-link`, init);
  }

  function createContext(projectId: string) {
    return {
      params: Promise.resolve({ projectId }),
    };
  }

  // ==========================================================================
  // 1. Authentication requirement (401)
  // ==========================================================================
  it("1. rejects unauthenticated requests with HTTP 401", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("No session") });

    const projectId = getUniqueProjectId();
    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 2. Project UUID validation (400)
  // ==========================================================================
  it("2. rejects invalid project UUID with HTTP 400", async () => {
    const invalidId = "not-a-valid-uuid";
    const req = createRequest(invalidId);
    const res = await POST(req, createContext(invalidId));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_PROJECT_ID");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Request body validation (400)
  // ==========================================================================
  it("rejects malicious or unexpected request payload with HTTP 400", async () => {
    const projectId = getUniqueProjectId();

    // Malformed JSON
    const malformedReq = createRequest(projectId, "{ invalid-json-body");
    const malformedRes = await POST(malformedReq, createContext(projectId));
    expect(malformedRes.status).toBe(400);
    expect((await malformedRes.json()).error).toBe("INVALID_JSON");

    // Unexpected caller parameters (trying to inject email or token)
    const injectedReq = createRequest(projectId, {
      clientEmail: "attacker@evil.com",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const injectedRes = await POST(injectedReq, createContext(projectId));
    expect(injectedRes.status).toBe(400);
    expect((await injectedRes.json()).error).toBe("VALIDATION_ERROR");
  });

  // ==========================================================================
  // 3 & 4. Authenticated request invokes create_client_portal_token RPC
  // ==========================================================================
  it("3 & 4. invokes create_client_portal_token RPC with authenticated client, returning 403 on authorization failure without exposing project existence", async () => {
    const projectIdA = getUniqueProjectId();
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({ data: { allowed: true, current: 1, limit: 10, resetAt: new Date().toISOString() }, error: null });
      }
      if (rpcName === "create_client_portal_token") {
        return Promise.resolve({ data: null, error: { message: "Project not found" } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const notFoundReq = createRequest(projectIdA);
    const notFoundRes = await POST(notFoundReq, createContext(projectIdA));
    expect(notFoundRes.status).toBe(403);
    expect((await notFoundRes.json()).error).toBe("NOT_FOUND_OR_FORBIDDEN");

    const projectIdB = getUniqueProjectId();
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({ data: { allowed: true, current: 1, limit: 10, resetAt: new Date().toISOString() }, error: null });
      }
      if (rpcName === "create_client_portal_token") {
        return Promise.resolve({ data: null, error: { message: "Forbidden: Only the project owner can issue portal tokens" } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const forbiddenReq = createRequest(projectIdB);
    const forbiddenRes = await POST(forbiddenReq, createContext(projectIdB));
    expect(forbiddenRes.status).toBe(403);
    expect((await forbiddenRes.json()).error).toBe("NOT_FOUND_OR_FORBIDDEN");
  });

  // ==========================================================================
  // Client email unverified check (409)
  // ==========================================================================
  it("rejects unverified client email with HTTP 409", async () => {
    const projectId = getUniqueProjectId();
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({ data: { allowed: true, current: 1, limit: 10, resetAt: new Date().toISOString() }, error: null });
      }
      if (rpcName === "create_client_portal_token") {
        return Promise.resolve({ data: null, error: { message: "Client email must be verified before issuing portal token" } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CLIENT_EMAIL_NOT_VERIFIED");
  });

  // ==========================================================================
  // 5 & 6. Raw token is hashed before RPC; raw token not included in RPC arguments
  // ==========================================================================
  it("5 & 6. hashes raw token before calling RPC and passes only the 64-char SHA-256 hash", async () => {
    const projectId = getUniqueProjectId();
    const sendSpy = vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "mock-msg-id",
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(200);

    // Filter calls for create_client_portal_token
    const portalTokenCalls = mockRpc.mock.calls.filter((call) => call[0] === "create_client_portal_token");
    expect(portalTokenCalls).toHaveLength(1);

    const rpcArgs = portalTokenCalls[0][1];
    expect(rpcArgs.p_project_id).toBe(projectId);

    // Verify token hash in RPC call is 64 hex characters
    expect(rpcArgs.p_token_hash).toMatch(/^[a-f0-9]{64}$/);

    // Verify raw token was generated and passed to email link, and its hash matches RPC arg
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const emailParams = sendSpy.mock.calls[0][0];
    const emailUrl = new URL(emailParams.portalUrl);
    const rawTokenFromEmail = emailUrl.pathname.split("/").pop()!;

    expect(rawTokenFromEmail).toHaveLength(43); // 32 bytes base64url
    expect(hashPortalToken(rawTokenFromEmail)).toBe(rpcArgs.p_token_hash);

    // Ensure raw token was NEVER sent to RPC
    expect(rpcArgs.p_token_hash).not.toBe(rawTokenFromEmail);
  });

  // ==========================================================================
  // 7. Invitation email is sent to verified database email, not caller input
  // ==========================================================================
  it("7. sends invitation email strictly to verified database email", async () => {
    const projectId = getUniqueProjectId();
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: projectId,
        title: "Database Project Title",
        client_name: "Trusted Client",
        client_email: "verified-in-db@client.com",
      },
      error: null,
    });

    const sendSpy = vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "mock-msg-id",
    });

    const req = createRequest(projectId);
    await POST(req, createContext(projectId));

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clientEmail: "verified-in-db@client.com",
        clientName: "Trusted Client",
        projectTitle: "Database Project Title",
      })
    );
  });

  // ==========================================================================
  // 8 & 9. Raw token is in email link but absent from HTTP response
  // ==========================================================================
  it("8 & 9. includes raw token in email link while strictly omitting it from the HTTP response", async () => {
    const projectId = getUniqueProjectId();
    const sendSpy = vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "mock-msg-id",
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.expiresAt).toBeDefined();

    // Raw token and portal URL MUST NOT be returned in JSON response
    expect(json.rawToken).toBeUndefined();
    expect(json.token).toBeUndefined();
    expect(json.portalUrl).toBeUndefined();
    expect(json.url).toBeUndefined();
    expect(json.tokenHash).toBeUndefined();

    // Verify token was present in the email link
    const emailParams = sendSpy.mock.calls[0][0];
    expect(emailParams.portalUrl).toContain("/portal/");
  });

  // ==========================================================================
  // 10 & 11. Email dispatch failure returns sanitized HTTP 502 with no secrets leaked
  // ==========================================================================
  it("10 & 11. returns sanitized HTTP 502 on email dispatch failure without leaking token material", async () => {
    const projectId = getUniqueProjectId();
    vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: false,
      error: "Upstream SMTP connection refused",
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toBe("EMAIL_DELIVERY_FAILED");
    expect(json.rawToken).toBeUndefined();
    expect(json.portalUrl).toBeUndefined();
    expect(json.token).toBeUndefined();
  });

  // ==========================================================================
  // 12. Application URL comes from trusted server configuration, not request headers
  // ==========================================================================
  it("12. constructs portal URL using trusted server environment and ignores untrusted Host/Forwarded headers", async () => {
    const projectId = getUniqueProjectId();
    process.env.PAYROOST_APP_URL = "https://secure.payroost.agency";

    const sendSpy = vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "mock-msg-id",
    });

    // Request carries spoofed Host and X-Forwarded-Host headers
    const req = createRequest(projectId, undefined, {
      Host: "evil-phishing-host.com",
      "X-Forwarded-Host": "attacker-controlled.net",
      Origin: "https://evil.org",
    });

    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(200);

    const emailParams = sendSpy.mock.calls[0][0];
    expect(emailParams.portalUrl.startsWith("https://secure.payroost.agency/portal/")).toBe(true);
    expect(emailParams.portalUrl).not.toContain("evil-phishing-host.com");
    expect(emailParams.portalUrl).not.toContain("attacker-controlled.net");
    expect(emailParams.portalUrl).not.toContain("evil.org");
  });

  // ==========================================================================
  // Phase 3B.2.3.1: Application URL Hardening & Failure Preventions
  // ==========================================================================
  it("rejects missing application URL in production with HTTP 503 and prevents token creation/email", async () => {
    const projectId = getUniqueProjectId();
    setNodeEnv("production");
    delete process.env.PAYROOST_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const sendSpy = vi.spyOn(emailProvider, "sendPortalInvitationEmail");

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).toBe("CONFIGURATION_UNAVAILABLE");

    // Token creation and email dispatch must NOT have occurred
    const portalTokenCalls = mockRpc.mock.calls.filter((call) => call[0] === "create_client_portal_token");
    expect(portalTokenCalls).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS application URL in production with HTTP 503", async () => {
    const projectId = getUniqueProjectId();
    setNodeEnv("production");
    process.env.PAYROOST_APP_URL = "http://insecure.payroost.com";

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("CONFIGURATION_UNAVAILABLE");
  });

  it("rejects localhost or loopback URL in production with HTTP 503", async () => {
    const projectId = getUniqueProjectId();
    setNodeEnv("production");
    process.env.PAYROOST_APP_URL = "https://localhost:3000";

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("CONFIGURATION_UNAVAILABLE");
  });

  it("rejects URLs with credentials, query parameters, or hash in production with HTTP 503", async () => {
    const projectId = getUniqueProjectId();
    setNodeEnv("production");

    // Credentials
    process.env.PAYROOST_APP_URL = "https://user:pass@app.payroost.com";
    let res = await POST(createRequest(projectId), createContext(projectId));
    expect(res.status).toBe(503);

    // Query parameters
    process.env.PAYROOST_APP_URL = "https://app.payroost.com?foo=bar";
    res = await POST(createRequest(projectId), createContext(projectId));
    expect(res.status).toBe(503);

    // Hash fragment
    process.env.PAYROOST_APP_URL = "https://app.payroost.com#section";
    res = await POST(createRequest(projectId), createContext(projectId));
    expect(res.status).toBe(503);
  });

  it("development falls back to http://localhost:3000 when unconfigured", async () => {
    const projectId = getUniqueProjectId();
    setNodeEnv("development");
    delete process.env.PAYROOST_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const sendSpy = vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "mock-msg-id",
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(200);

    const emailParams = sendSpy.mock.calls[0][0];
    expect(emailParams.portalUrl.startsWith("http://localhost:3000/portal/")).toBe(true);
  });

  // ==========================================================================
  // 13. Token expiry is finite and consistent between database and email (7 days)
  // ==========================================================================
  it("13. sets a finite 7-day token expiry consistent between the database RPC and email", async () => {
    const projectId = getUniqueProjectId();
    const sendSpy = vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "mock-msg-id",
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(200);

    const portalTokenCalls = mockRpc.mock.calls.filter((call) => call[0] === "create_client_portal_token");
    const rpcArgs = portalTokenCalls[0][1];
    const rpcExpiresAt = new Date(rpcArgs.p_expires_at).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    // Within 5 seconds tolerance of 7 days
    expect(Math.abs(rpcExpiresAt - (now + sevenDaysMs))).toBeLessThan(5000);

    // Email params specify 7 days
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresInDays: PORTAL_TOKEN_EXPIRY_DAYS,
      })
    );
  });

  // ==========================================================================
  // 14. Rate limiting rejects excessive issuance requests (429)
  // ==========================================================================
  it("14. rate limits excessive issuance requests returning HTTP 429", async () => {
    const projectId = getUniqueProjectId();
    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
      allowed: false,
      current: 6,
      limit: 5,
      resetAt: Date.now() + 60000,
      status: "rate_limited",
      isUnavailable: false,
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toBe("RATE_LIMITED");
  });

  // ==========================================================================
  // 15. Production rate-limit failure fails closed with HTTP 503
  // ==========================================================================
  it("15. returns HTTP 503 when the rate limiter infrastructure fails in production", async () => {
    const projectId = getUniqueProjectId();
    setNodeEnv("production");

    // Supabase rate-limit RPC returns database failure
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({ data: null, error: { message: "Database rate limit connection timeout" } });
      }
      return Promise.resolve({ data: "t123", error: null });
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).toBe("RATE_LIMITER_UNAVAILABLE");

    // Token creation and email dispatch must NOT have occurred
    const portalTokenCalls = mockRpc.mock.calls.filter((call) => call[0] === "create_client_portal_token");
    expect(portalTokenCalls).toHaveLength(0);
  });

  // ==========================================================================
  // 16. Successful execution returns expected HTTP success response
  // ==========================================================================
  it("16. returns HTTP 200 with success status and expiration timestamp", async () => {
    const projectId = getUniqueProjectId();
    vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "smtp-msg-12345",
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(typeof json.expiresAt).toBe("string");
    expect(new Date(json.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  // ==========================================================================
  // 17. Portal invite activity event omits freelancer email PII from actor_label
  // ==========================================================================
  it("17. records portal.invited activity with generic actor_label without persisting freelancer email", async () => {
    const projectId = getUniqueProjectId();
    const insertedActivities: Array<Record<string, unknown>> = [];
    mockFrom.mockImplementation((table?: string) => {
      if (table === "activity_events") {
        return {
          select: mockSelect,
          insert: vi.fn((payload: Record<string, unknown>) => {
            insertedActivities.push(payload);
            return Promise.resolve({ error: null });
          }),
        } as unknown as { select: typeof mockSelect };
      }
      return { select: mockSelect };
    });

    vi.spyOn(emailProvider, "sendPortalInvitationEmail").mockResolvedValueOnce({
      success: true,
      messageId: "smtp-msg-privacy-1",
    });

    const req = createRequest(projectId);
    const res = await POST(req, createContext(projectId));
    expect(res.status).toBe(200);

    expect(insertedActivities).toHaveLength(1);
    expect(insertedActivities[0]?.event_type).toBe("portal.invited");
    expect(insertedActivities[0]?.actor_label).toBe("Freelancer");
    expect(JSON.stringify(insertedActivities[0])).not.toContain(validUser.email);
  });
});
