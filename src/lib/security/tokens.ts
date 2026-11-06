import "server-only";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const CSRF_TOKEN_REGEX = /^[0-9a-f]{64}$/i;

export function createReviewToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashReviewToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createOtpCode(): string {
  return randomInt(100000, 1000000).toString();
}

export function hashOtpCode(otp: string, secretOverride?: string): string {
  const secret = secretOverride || process.env.PAYROOST_OTP_SECRET || "payroost-default-otp-secret-key-do-not-use-in-production";
  return createHmac("sha256", secret).update(otp, "utf8").digest("hex");
}

export function createPortalToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPortalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createCsrfSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Timing-safe validation of a client-submitted CSRF token against the expected CSRF secret.
 *
 * Security Invariants:
 * - Rejects missing, undefined, null, non-string, or empty tokens.
 * - Strictly validates 64-character hexadecimal format.
 * - Uses crypto.timingSafeEqual with equal-length buffers to prevent timing side-channel attacks.
 * - Never logs or exposes either token in error messages or logs.
 */
export function validateCsrfToken(
  submittedToken: string | null | undefined,
  expectedSecret: string | null | undefined
): boolean {
  if (
    !submittedToken ||
    typeof submittedToken !== "string" ||
    !expectedSecret ||
    typeof expectedSecret !== "string"
  ) {
    return false;
  }

  // Strictly enforce 64-character hexadecimal format
  if (
    submittedToken.length !== 64 ||
    expectedSecret.length !== 64 ||
    !CSRF_TOKEN_REGEX.test(submittedToken) ||
    !CSRF_TOKEN_REGEX.test(expectedSecret)
  ) {
    return false;
  }

  const bufSubmitted = Buffer.from(submittedToken.toLowerCase(), "utf8");
  const bufExpected = Buffer.from(expectedSecret.toLowerCase(), "utf8");

  if (bufSubmitted.length !== bufExpected.length) {
    return false;
  }

  return timingSafeEqual(bufSubmitted, bufExpected);
}
