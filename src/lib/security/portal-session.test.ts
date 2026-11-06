import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashSessionToken } from "@/lib/security/tokens";
import {
  PORTAL_SESSION_COOKIE_NAME_PROD,
  PORTAL_SESSION_COOKIE_NAME_DEV,
  PORTAL_SESSION_MAX_AGE_SECONDS,
  generatePortalSessionCredentials,
  getPortalSessionCookieName,
  getPortalSessionCookieOptions,
  setPortalSessionCookie,
  getPortalSessionToken,
  clearPortalSessionCookie,
} from "./portal-session";

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

describe("Phase 3B.2.2: Portal Session Utilities", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    setNodeEnv(originalNodeEnv);
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  // ==========================================================================
  // Server-only boundary enforcement
  // ==========================================================================
  it("enforces server-only boundary in src/lib/security/portal-session.ts", () => {
    const filePath = resolve(process.cwd(), "src/lib/security/portal-session.ts");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toMatch(/^import\s+["']server-only["'];/m);
  });

  // ==========================================================================
  // 1. Session credential generation returns raw token, hash and CSRF secret
  // ==========================================================================
  it("1. generates high-entropy credentials: rawSessionToken, sessionTokenHash, and csrfSecret", () => {
    const credentials = generatePortalSessionCredentials();

    expect(typeof credentials.rawSessionToken).toBe("string");
    expect(credentials.rawSessionToken).toHaveLength(43); // 32 bytes base64url
    expect(credentials.rawSessionToken).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(typeof credentials.sessionTokenHash).toBe("string");
    expect(credentials.sessionTokenHash).toHaveLength(64); // SHA-256 hex
    expect(credentials.sessionTokenHash).toMatch(/^[a-f0-9]{64}$/);

    expect(typeof credentials.csrfSecret).toBe("string");
    expect(credentials.csrfSecret).toHaveLength(64); // 32 bytes hex
    expect(credentials.csrfSecret).toMatch(/^[a-f0-9]{64}$/);
  });

  // ==========================================================================
  // 2. Session hash is derived correctly from the raw token
  // ==========================================================================
  it("2. derives sessionTokenHash correctly using SHA-256 from rawSessionToken", () => {
    const credentials = generatePortalSessionCredentials();
    const expectedHash = hashSessionToken(credentials.rawSessionToken);

    expect(credentials.sessionTokenHash).toBe(expectedHash);
  });

  // ==========================================================================
  // 3. Repeated credential generation produces distinct credentials
  // ==========================================================================
  it("3. produces unique tokens, hashes, and CSRF secrets on successive invocations", () => {
    const credA = generatePortalSessionCredentials();
    const credB = generatePortalSessionCredentials();

    expect(credA.rawSessionToken).not.toBe(credB.rawSessionToken);
    expect(credA.sessionTokenHash).not.toBe(credB.sessionTokenHash);
    expect(credA.csrfSecret).not.toBe(credB.csrfSecret);
  });

  // ==========================================================================
  // 4. Production cookie name is correct (__Host- prefix)
  // ==========================================================================
  it("4. selects __Host-payroost_client_session as cookie name in production", () => {
    setNodeEnv("production");
    expect(getPortalSessionCookieName()).toBe(PORTAL_SESSION_COOKIE_NAME_PROD);
    expect(getPortalSessionCookieName()).toBe("__Host-payroost_client_session");
  });

  // ==========================================================================
  // 5. Development cookie name is correct
  // ==========================================================================
  it("5. selects payroost_client_session as cookie name in development and test environments", () => {
    setNodeEnv("development");
    expect(getPortalSessionCookieName()).toBe(PORTAL_SESSION_COOKIE_NAME_DEV);
    expect(getPortalSessionCookieName()).toBe("payroost_client_session");

    setNodeEnv("test");
    expect(getPortalSessionCookieName()).toBe(PORTAL_SESSION_COOKIE_NAME_DEV);
  });

  // ==========================================================================
  // 6. Production cookie options include HttpOnly, Secure, SameSite Lax, Path /, Max-Age 43200
  // ==========================================================================
  it("6. produces production cookie options with HttpOnly, Secure, SameSite Lax, Path /, and Max-Age 43200", () => {
    setNodeEnv("production");
    const options = getPortalSessionCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(PORTAL_SESSION_MAX_AGE_SECONDS);
    expect(options.maxAge).toBe(43200);
  });

  // ==========================================================================
  // 7. Development cookie options preserve required attributes while setting Secure to false
  // ==========================================================================
  it("7. produces development cookie options preserving security flags but setting Secure to false", () => {
    setNodeEnv("development");
    const options = getPortalSessionCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(false);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(PORTAL_SESSION_MAX_AGE_SECONDS);
  });

  // ==========================================================================
  // 8. No Domain attribute is set (required for RFC 6265bis __Host- cookies)
  // ==========================================================================
  it("8. leaves domain undefined to satisfy RFC 6265bis __Host- cookie specification", () => {
    setNodeEnv("production");
    const prodOptions = getPortalSessionCookieOptions();
    expect(prodOptions.domain).toBeUndefined();
    expect("domain" in prodOptions && prodOptions.domain !== undefined).toBe(false);

    setNodeEnv("development");
    const devOptions = getPortalSessionCookieOptions();
    expect(devOptions.domain).toBeUndefined();
  });

  // ==========================================================================
  // 9. Cookie reading returns token when present
  // ==========================================================================
  it("9. returns raw session token when cookie is present", async () => {
    setNodeEnv("production");
    const mockToken = "valid-mock-raw-session-token-xyz123";
    mockCookieStore.get.mockReturnValueOnce({
      name: PORTAL_SESSION_COOKIE_NAME_PROD,
      value: mockToken,
    });

    const token = await getPortalSessionToken();
    expect(token).toBe(mockToken);
    expect(mockCookieStore.get).toHaveBeenCalledWith(PORTAL_SESSION_COOKIE_NAME_PROD);
  });

  // ==========================================================================
  // 10. Cookie reading returns null when absent or empty
  // ==========================================================================
  it("10. returns null safely when cookie is absent or value is empty", async () => {
    mockCookieStore.get.mockReturnValueOnce(undefined);
    const missingResult = await getPortalSessionToken();
    expect(missingResult).toBeNull();

    mockCookieStore.get.mockReturnValueOnce({
      name: PORTAL_SESSION_COOKIE_NAME_DEV,
      value: "",
    });
    const emptyResult = await getPortalSessionToken();
    expect(emptyResult).toBeNull();
  });

  // ==========================================================================
  // 11. Cookie clearing expires cookie using correct name and attributes
  // ==========================================================================
  it("11. clears cookie by expiring immediately (maxAge: 0) with correct name, path, and security flags", async () => {
    setNodeEnv("production");
    await clearPortalSessionCookie();

    expect(mockCookieStore.set).toHaveBeenCalledTimes(1);
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      PORTAL_SESSION_COOKIE_NAME_PROD,
      "",
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      })
    );

    mockCookieStore.set.mockClear();
    setNodeEnv("development");
    await clearPortalSessionCookie();

    expect(mockCookieStore.set).toHaveBeenCalledWith(
      PORTAL_SESSION_COOKIE_NAME_DEV,
      "",
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      })
    );
  });

  // ==========================================================================
  // 12. Caller input cannot override security-critical cookie settings
  // ==========================================================================
  it("12. prevents caller input or runtime manipulation from overriding security-critical cookie settings", async () => {
    const options = getPortalSessionCookieOptions();
    expect(Object.isFrozen(options)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating readonly property
      options.secure = false;
    }).toThrow();

    expect(() => {
      // @ts-expect-error mutating readonly property
      options.httpOnly = false;
    }).toThrow();

    // setPortalSessionCookie disallows caller option injection
    setNodeEnv("production");
    // @ts-expect-error passing extraneous malicious parameters
    await setPortalSessionCookie("safe-token-value", { httpOnly: false, secure: false, path: "/evil" });

    expect(mockCookieStore.set).toHaveBeenCalledWith(
      PORTAL_SESSION_COOKIE_NAME_PROD,
      "safe-token-value",
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: PORTAL_SESSION_MAX_AGE_SECONDS,
      })
    );
  });

  // ==========================================================================
  // 13. Input validation: Rejects invalid or empty tokens when setting cookie
  // ==========================================================================
  it("13. rejects invalid or empty session tokens when setting cookie", async () => {
    await expect(setPortalSessionCookie("")).rejects.toThrow("Invalid session token");

    // @ts-expect-error testing null input
    await expect(setPortalSessionCookie(null)).rejects.toThrow("Invalid session token");

    // @ts-expect-error testing undefined input
    await expect(setPortalSessionCookie(undefined)).rejects.toThrow("Invalid session token");
  });
});
