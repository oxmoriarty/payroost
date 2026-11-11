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

export class OtpSecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtpSecretConfigurationError";
  }
}

const TEST_EPHEMERAL_OTP_SECRET_KEY = Symbol.for("payroost.test.ephemeralOtpHmacSecret");

function getTestEphemeralOtpSecret(): string {
  const globalStore = globalThis as Record<symbol, string | undefined>;
  if (!globalStore[TEST_EPHEMERAL_OTP_SECRET_KEY]) {
    globalStore[TEST_EPHEMERAL_OTP_SECRET_KEY] = randomBytes(32).toString("hex");
  }
  return globalStore[TEST_EPHEMERAL_OTP_SECRET_KEY]!;
}

/**
 * Resolves and validates the server-side HMAC secret for review OTP hashing.
 * - Requires PAYROOST_OTP_SECRET (>= 32 bytes) in production and development.
 * - Rejects whitespace-only, short, or placeholder secrets in all environments.
 * - Uses an ephemeral per-process CSPRNG key only when unconfigured in NODE_ENV="test"
 *   so isolated unit tests remain deterministic without any hardcoded secret fallback.
 */
export function getOtpHmacSecret(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  secretOverride?: string
): string {
  const candidate = secretOverride !== undefined ? secretOverride : env.PAYROOST_OTP_SECRET;

  if (candidate === undefined || candidate === "") {
    if (secretOverride !== undefined) {
      throw new OtpSecretConfigurationError(
        "OTP HMAC secret must contain at least 32 bytes of secret material"
      );
    }
    if (env.NODE_ENV === "test") {
      return getTestEphemeralOtpSecret();
    }
    throw new OtpSecretConfigurationError(
      "PAYROOST_OTP_SECRET must be configured with at least 32 bytes"
    );
  }

  const trimmed = candidate.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") < 32) {
    throw new OtpSecretConfigurationError(
      "PAYROOST_OTP_SECRET must contain at least 32 bytes of secret material"
    );
  }

  if (/do-not-use-in-production|default-otp-secret/i.test(trimmed)) {
    throw new OtpSecretConfigurationError(
      "PAYROOST_OTP_SECRET must not use an insecure placeholder secret"
    );
  }

  return trimmed;
}

export function createOtpCode(): string {
  return randomInt(100000, 1000000).toString();
}

export function hashOtpCode(
  otp: string,
  secretOverride?: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): string {
  const secret = getOtpHmacSecret(env, secretOverride);
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
