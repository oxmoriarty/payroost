import "server-only";

import { cookies } from "next/headers";
import { createCsrfSecret, validateCsrfToken } from "@/lib/security/tokens";
import { getCanonicalAppUrl } from "@/lib/security/app-url";

export const OPERATOR_CSRF_COOKIE_NAME_PROD = "__Host-payroost_operator_csrf";
export const OPERATOR_CSRF_COOKIE_NAME_DEV = "payroost_operator_csrf";
export const OPERATOR_CSRF_MAX_AGE_SECONDS = 43200; // 12 hours

export function getOperatorCsrfCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? OPERATOR_CSRF_COOKIE_NAME_PROD
    : OPERATOR_CSRF_COOKIE_NAME_DEV;
}

export function generateOperatorCsrfSecret(): string {
  return createCsrfSecret();
}

/**
 * Returns cookie options for setting the operator CSRF cookie.
 * In production: Secure, SameSite=Lax, Path=/, no domain (for __Host- prefix).
 * Note: httpOnly is false so the client-side browser runtime can read it
 * and attach it to the `x-csrf-token` header for mutating API requests (double-submit pattern).
 */
export function getOperatorCsrfCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: false,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/" as const,
    maxAge: OPERATOR_CSRF_MAX_AGE_SECONDS,
  };
}

export interface OperatorCsrfValidationResult {
  valid: boolean;
  error?: "MISSING_HEADER" | "MISSING_COOKIE" | "CSRF_MISMATCH" | "CROSS_ORIGIN_FORBIDDEN";
}

/**
 * Validates the operator CSRF token on mutating requests.
 * Uses timingSafeEqual double-submit token comparison and validates request origin.
 */
export async function validateOperatorCsrf(
  request: Request
): Promise<OperatorCsrfValidationResult> {
  const submittedHeader = request.headers.get("x-csrf-token");
  if (!submittedHeader || typeof submittedHeader !== "string" || submittedHeader.trim().length === 0) {
    return { valid: false, error: "MISSING_HEADER" };
  }

  // Extract cookie from next/headers or request header
  let cookieSecret: string | undefined;
  try {
    const cookieStore = await cookies();
    cookieSecret = cookieStore.get(getOperatorCsrfCookieName())?.value;
  } catch {
    // Fallback to manual parsing from request headers if outside Next.js cookies context
    const cookieHeader = request.headers.get("cookie") || "";
    const cookieName = getOperatorCsrfCookieName();
    const match = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`));
    if (match) {
      cookieSecret = match.slice(cookieName.length + 1);
    }
  }

  if (!cookieSecret || typeof cookieSecret !== "string" || cookieSecret.trim().length === 0) {
    return { valid: false, error: "MISSING_COOKIE" };
  }

  const isValid = validateCsrfToken(submittedHeader.trim(), cookieSecret.trim());
  if (!isValid) {
    return { valid: false, error: "CSRF_MISMATCH" };
  }

  // Cross-origin check: Verify Origin / Referer against canonical base URL or request Host
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const canonicalAppUrl = getCanonicalAppUrl();
      const canonicalOrigin = new URL(canonicalAppUrl).origin;
      const requestOrigin = new URL(origin).origin;
      if (canonicalOrigin !== requestOrigin) {
        // Also check if matches host header in dev
        const host = request.headers.get("host");
        if (!host || requestOrigin !== `http://${host}` && requestOrigin !== `https://${host}`) {
          return { valid: false, error: "CROSS_ORIGIN_FORBIDDEN" };
        }
      }
    } catch {
      return { valid: false, error: "CROSS_ORIGIN_FORBIDDEN" };
    }
  }

  return { valid: true };
}
