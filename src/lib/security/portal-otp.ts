import "server-only";
import { createHmac, randomInt } from "node:crypto";

export class PortalOtpHmacConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalOtpHmacConfigurationError";
  }
}

/**
 * Returns the validated server-side secret used to generate portal OTP HMACs.
 * - In production: PORTAL_OTP_HMAC_SECRET is strictly required and must contain at least 32 bytes.
 * - In non-production: falls back to a development secret if unconfigured.
 */
export function getPortalOtpHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  const isProduction = env.NODE_ENV === "production";
  const secret = env.PORTAL_OTP_HMAC_SECRET?.trim();

  if (!secret) {
    if (isProduction) {
      throw new PortalOtpHmacConfigurationError(
        "Production requires PORTAL_OTP_HMAC_SECRET to be configured with at least 32 bytes"
      );
    }
    return "dev-portal-otp-hmac-secret-min-32-bytes-for-local-testing-only!";
  }

  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new PortalOtpHmacConfigurationError(
      "PORTAL_OTP_HMAC_SECRET must contain at least 32 bytes of cryptographic secret material"
    );
  }

  return secret;
}

/**
 * Generates a 6-digit cryptographically secure numerical OTP code.
 */
export function generatePortalOtpCode(): string {
  return randomInt(100000, 1000000).toString();
}

/**
 * Computes the SHA-256 HMAC of a 6-digit OTP code using the dedicated PORTAL_OTP_HMAC_SECRET.
 * Output is a 64-character lowercase hex string matching Postgres char_length(otp_hmac) = 64.
 */
export function computePortalOtpHmac(
  otp: string,
  secretOverride?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!/^\d{6}$/.test(otp)) {
    throw new Error("Invalid OTP code: must be exactly 6 digits");
  }

  const secret = secretOverride || getPortalOtpHmacSecret(env);
  return createHmac("sha256", secret).update(otp, "utf8").digest("hex");
}
