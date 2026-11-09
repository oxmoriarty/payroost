import "server-only";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSessionToken,
  hashSessionToken,
  createCsrfSecret,
  validateCsrfToken,
} from "@/lib/security/tokens";

/**
 * Production and development cookie names.
 * In production, the __Host- prefix guarantees:
 * - Must be served over HTTPS (Secure)
 * - Must have Path=/
 * - Must NOT specify a Domain attribute
 */
export const PORTAL_SESSION_COOKIE_NAME_PROD = "__Host-payroost_client_session";
export const PORTAL_SESSION_COOKIE_NAME_DEV = "payroost_client_session";

/**
 * Maximum session cookie age in seconds: 12 hours (43,200 seconds).
 * Aligns with the database absolute lifetime for client portal sessions.
 */
export const PORTAL_SESSION_MAX_AGE_SECONDS = 43200;

export interface PortalSessionCredentials {
  rawSessionToken: string;
  sessionTokenHash: string;
  csrfSecret: string;
}

export interface PortalSessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly maxAge: number;
  readonly domain?: undefined;
}

/**
 * Generates fresh cryptographically secure client portal session credentials.
 * - rawSessionToken: Provided to browser in HttpOnly cookie.
 * - sessionTokenHash: SHA-256 hex digest for database storage and verification.
 * - csrfSecret: Hex secret for database storage and future CSRF mutation protection.
 *
 * NOTE: Raw session tokens, hashes, and CSRF secrets must never be logged.
 */
export function generatePortalSessionCredentials(): PortalSessionCredentials {
  const rawSessionToken = createSessionToken();
  const sessionTokenHash = hashSessionToken(rawSessionToken);
  const csrfSecret = createCsrfSecret();

  return {
    rawSessionToken,
    sessionTokenHash,
    csrfSecret,
  };
}

/**
 * Returns the environment-appropriate cookie name.
 * In production: "__Host-payroost_client_session"
 * In non-production (e.g. local dev / test): "payroost_client_session"
 */
export function getPortalSessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? PORTAL_SESSION_COOKIE_NAME_PROD
    : PORTAL_SESSION_COOKIE_NAME_DEV;
}

/**
 * Returns the immutable security options for the client portal session cookie.
 * Security attributes are frozen to prevent caller-supplied or accidental overrides.
 * Domain is explicitly undefined to satisfy RFC 6265bis __Host- cookie constraints.
 */
export function getPortalSessionCookieOptions(): PortalSessionCookieOptions {
  const isProd = process.env.NODE_ENV === "production";
  return Object.freeze({
    httpOnly: true as const,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/" as const,
    maxAge: PORTAL_SESSION_MAX_AGE_SECONDS,
    domain: undefined,
  });
}

/**
 * Sets the raw session token in the client's HttpOnly cookie.
 * Uses Next.js asynchronous cookies() API.
 * Disallows caller-supplied overrides of security settings.
 */
export async function setPortalSessionCookie(rawSessionToken: string): Promise<void> {
  if (!rawSessionToken || typeof rawSessionToken !== "string") {
    throw new Error("Invalid session token");
  }

  const cookieStore = await cookies();
  cookieStore.set(
    getPortalSessionCookieName(),
    rawSessionToken,
    getPortalSessionCookieOptions()
  );
}

/**
 * Reads the raw session token from incoming cookies.
 * Returns null if the cookie is missing or empty. Does not throw on missing cookie.
 */
export async function getPortalSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(getPortalSessionCookieName());
  return cookie?.value ? cookie.value : null;
}

/**
 * Clears the portal session cookie immediately by expiring it (maxAge: 0).
 * Matches the exact cookie name, path, and security settings required by RFC 6265bis.
 */
export async function clearPortalSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  const options = getPortalSessionCookieOptions();
  cookieStore.set(getPortalSessionCookieName(), "", {
    ...options,
    maxAge: 0,
  });
}

export interface AuthenticatePortalSessionOptions {
  /**
   * Optional client-submitted CSRF token (typically extracted from the 'x-csrf-token' header).
   * When requireCsrf is true or this token is provided, it must match the session's database CSRF secret.
   */
  csrfToken?: string | null;

  /**
   * Whether to require CSRF token validation. Defaults to false (for read-only GET requests).
   * Must be set to true for mutating requests (POST, PUT, PATCH, DELETE).
   */
  requireCsrf?: boolean;

  /**
   * Optional expected project ID (e.g. resolved from the invitation token in the URL).
   * If provided, asserts that the authenticated session strictly belongs to this project.
   */
  expectedProjectId?: string;

  /**
   * Optional pre-instantiated Supabase client (primarily for dependency injection in testing).
   */
  supabaseClient?: SupabaseClient;
}

export type PortalSessionAuthFailure =
  | {
      success: false;
      status: 401;
      error: "UNAUTHORIZED" | "SESSION_EXPIRED" | "SESSION_IDLE_TIMEOUT" | "AUTHENTICATION_FAILED";
      reason?: string;
    }
  | {
      success: false;
      status: 403;
      error: "INVALID_CSRF_TOKEN" | "FORBIDDEN";
      reason?: string;
    }
  | {
      success: false;
      status: 500 | 503;
      error: "SERVER_ERROR" | "DATABASE_UNAVAILABLE";
      reason?: string;
    };

export interface AuthenticatedPortalSession {
  success: true;
  sessionId: string;
  sessionTokenHash: string;
  projectId: string;
  clientEmail: string;
  csrfSecret: string;
}

export type PortalSessionAuthResult = AuthenticatedPortalSession | PortalSessionAuthFailure;

/**
 * Reusable server-side portal session authentication and authorization helper.
 *
 * Security Invariants:
 * 1. Reads raw session token exclusively from the HttpOnly cookie.
 * 2. Validates token format before hashing (43-char base64url).
 * 3. Hashes token with SHA-256 before invoking validate_portal_session.
 * 4. Strictly verifies database response: active, unexpired, unrevoked, un-idle.
 * 5. Enforces verified client email binding from the database.
 * 6. Enforces expected project ID binding when provided (prevents cross-project session confusion).
 * 7. Enforces timing-safe CSRF validation for state-changing requests.
 * 8. Distinguishes database infrastructure failures (503/500) from authentication failures (401).
 * 9. Never returns or exposes the raw session token or session token hash.
 */
export async function authenticatePortalSession(
  options: AuthenticatePortalSessionOptions = {}
): Promise<PortalSessionAuthResult> {
  // 1. Read raw token from HttpOnly cookie
  const rawToken = await getPortalSessionToken();
  if (!rawToken || typeof rawToken !== "string") {
    return {
      success: false,
      status: 401,
      error: "UNAUTHORIZED",
      reason: "MISSING_SESSION_COOKIE",
    };
  }

  // 2. Validate token format (32 bytes base64url = exactly 43 chars)
  if (rawToken.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
    return {
      success: false,
      status: 401,
      error: "UNAUTHORIZED",
      reason: "MALFORMED_SESSION_TOKEN",
    };
  }

  // 3. Hash session token with SHA-256
  const sessionTokenHash = hashSessionToken(rawToken);

  // 4. Invoke validate_portal_session RPC
  let data: unknown;
  let rpcError: { message?: string } | null = null;
  try {
    const supabase = options.supabaseClient ?? (await createClient());
    const response = await supabase.rpc("validate_portal_session", {
      p_session_token_hash: sessionTokenHash,
    });
    data = response.data;
    rpcError = response.error;
  } catch (err) {
    return {
      success: false,
      status: 503,
      error: "DATABASE_UNAVAILABLE",
      reason: err instanceof Error ? err.message : "Database connection failed",
    };
  }

  if (rpcError) {
    return {
      success: false,
      status: 503,
      error: "DATABASE_UNAVAILABLE",
      reason: rpcError.message ?? "RPC execution failed",
    };
  }

  if (!data || typeof data !== "object") {
    return {
      success: false,
      status: 500,
      error: "SERVER_ERROR",
      reason: "INVALID_DATABASE_RESPONSE",
    };
  }

  const validation = data as {
    valid?: boolean;
    reason?: string;
    sessionId?: string;
    projectId?: string;
    clientEmail?: string;
    csrfSecret?: string;
  };

  // 5. Evaluate session validity and timeout reasons
  if (validation.valid !== true) {
    switch (validation.reason) {
      case "ABSOLUTE_EXPIRY":
        return {
          success: false,
          status: 401,
          error: "SESSION_EXPIRED",
          reason: "ABSOLUTE_EXPIRY",
        };
      case "IDLE_TIMEOUT":
        return {
          success: false,
          status: 401,
          error: "SESSION_IDLE_TIMEOUT",
          reason: "IDLE_TIMEOUT",
        };
      case "CLIENT_EMAIL_CHANGED":
        return {
          success: false,
          status: 401,
          error: "AUTHENTICATION_FAILED",
          reason: "CLIENT_EMAIL_CHANGED",
        };
      case "REVOKED_OR_NOT_FOUND":
      default:
        return {
          success: false,
          status: 401,
          error: "UNAUTHORIZED",
          reason: validation.reason ?? "REVOKED_OR_NOT_FOUND",
        };
    }
  }

  // 6. Strictly validate required database metadata
  if (
    typeof validation.sessionId !== "string" ||
    typeof validation.projectId !== "string" ||
    typeof validation.clientEmail !== "string" ||
    typeof validation.csrfSecret !== "string" ||
    validation.sessionId.length === 0 ||
    validation.projectId.length === 0 ||
    validation.clientEmail.length === 0 ||
    validation.csrfSecret.length === 0
  ) {
    return {
      success: false,
      status: 500,
      error: "SERVER_ERROR",
      reason: "MALFORMED_SESSION_METADATA",
    };
  }

  // 7. Contextual project binding verification
  if (options.expectedProjectId) {
    if (validation.projectId !== options.expectedProjectId) {
      return {
        success: false,
        status: 403,
        error: "FORBIDDEN",
        reason: "PROJECT_MISMATCH",
      };
    }
  }

  // 8. Timing-safe CSRF validation
  if (options.requireCsrf || options.csrfToken !== undefined) {
    const isCsrfValid = validateCsrfToken(options.csrfToken, validation.csrfSecret);
    if (!isCsrfValid) {
      return {
        success: false,
        status: 403,
        error: "INVALID_CSRF_TOKEN",
        reason: "CSRF_MISMATCH",
      };
    }
  }

  // 9. Return typed authenticated session context
  return {
    success: true,
    sessionId: validation.sessionId,
    sessionTokenHash,
    projectId: validation.projectId,
    clientEmail: validation.clientEmail,
    csrfSecret: validation.csrfSecret,
  };
}
