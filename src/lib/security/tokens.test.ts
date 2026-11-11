import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createReviewToken,
  hashReviewToken,
  createPortalToken,
  hashPortalToken,
  createSessionToken,
  hashSessionToken,
  createCsrfSecret,
  validateCsrfToken,
  createOtpCode,
  hashOtpCode,
  getOtpHmacSecret,
  OtpSecretConfigurationError,
} from "@/lib/security/tokens";

describe("Review and Portal token security", () => {
  it("generates a high-entropy base64url review token of 43 characters (32 random bytes)", () => {
    const token = createReviewToken();
    expect(typeof token).toBe("string");
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces unique tokens on successive calls", () => {
    const tokenA = createReviewToken();
    const tokenB = createReviewToken();
    expect(tokenA).not.toBe(tokenB);
  });

  it("produces a 64-character SHA-256 hex digest for storage", () => {
    const token = createReviewToken();
    const hash = hashReviewToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("consistently hashes the identical token to the identical digest", () => {
    const token = "fixed-test-token-value-for-deterministic-test";
    const hash1 = hashReviewToken(token);
    const hash2 = hashReviewToken(token);
    expect(hash1).toBe(hash2);
  });

  it("generates portal tokens and session tokens with 64-char SHA-256 hashes", () => {
    const portalToken = createPortalToken();
    expect(portalToken).toHaveLength(43);
    const portalHash = hashPortalToken(portalToken);
    expect(portalHash).toMatch(/^[a-f0-9]{64}$/);

    const sessionToken = createSessionToken();
    expect(sessionToken).toHaveLength(43);
    const sessionHash = hashSessionToken(sessionToken);
    expect(sessionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates 64-character hex CSRF secrets", () => {
    const csrfSecret = createCsrfSecret();
    expect(csrfSecret).toHaveLength(64);
    expect(csrfSecret).toMatch(/^[a-f0-9]{64}$/);
  });

  describe("validateCsrfToken: Timing-Safe CSRF Validation", () => {
    const validSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    it("returns true for matching 64-character hex tokens", () => {
      expect(validateCsrfToken(validSecret, validSecret)).toBe(true);
    });

    it("supports case-insensitive matching for hex tokens", () => {
      const upperCaseToken = validSecret.toUpperCase();
      expect(validateCsrfToken(upperCaseToken, validSecret)).toBe(true);
      expect(validateCsrfToken(validSecret, upperCaseToken)).toBe(true);
    });

    it("returns false for mismatched tokens of equal length", () => {
      const differentSecret = "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1";
      expect(validateCsrfToken(differentSecret, validSecret)).toBe(false);
    });

    it("returns false when submitted token is missing, null, or undefined", () => {
      expect(validateCsrfToken(null, validSecret)).toBe(false);
      expect(validateCsrfToken(undefined, validSecret)).toBe(false);
      expect(validateCsrfToken("", validSecret)).toBe(false);
    });

    it("returns false when expected secret is missing, null, or undefined", () => {
      expect(validateCsrfToken(validSecret, null)).toBe(false);
      expect(validateCsrfToken(validSecret, undefined)).toBe(false);
      expect(validateCsrfToken(validSecret, "")).toBe(false);
    });

    it("returns false when tokens have unequal lengths", () => {
      expect(validateCsrfToken(validSecret.slice(0, 63), validSecret)).toBe(false);
      expect(validateCsrfToken(validSecret + "0", validSecret)).toBe(false);
    });

    it("returns false for non-hex characters", () => {
      const nonHexToken = validSecret.slice(0, 63) + "z";
      expect(validateCsrfToken(nonHexToken, validSecret)).toBe(false);
      expect(validateCsrfToken(validSecret, nonHexToken)).toBe(false);
    });
  });

  describe("hashOtpCode and getOtpHmacSecret configuration security", () => {
    const configuredSecret = "configured-prod-otp-secret-with-at-least-32-bytes!";

    it("generates 6-digit numeric OTP codes", () => {
      const otp = createOtpCode();
      expect(otp).toMatch(/^\d{6}$/);
    });

    it("preserves exact SHA-256 HMAC behavior when valid PAYROOST_OTP_SECRET is configured", () => {
      const expected = createHmac("sha256", configuredSecret).update("482910", "utf8").digest("hex");
      expect(
        hashOtpCode("482910", undefined, {
          NODE_ENV: "production",
          PAYROOST_OTP_SECRET: configuredSecret,
        })
      ).toBe(expected);
    });

    it("preserves exact SHA-256 HMAC behavior with valid explicit secretOverride", () => {
      const override = "explicit-override-otp-secret-minimum-32-bytes-key";
      const expected = createHmac("sha256", override).update("123456", "utf8").digest("hex");
      expect(hashOtpCode("123456", override, { NODE_ENV: "production" })).toBe(expected);
    });

    it("fails closed in production when PAYROOST_OTP_SECRET is missing or blank", () => {
      expect(() => getOtpHmacSecret({ NODE_ENV: "production" })).toThrow(OtpSecretConfigurationError);
      expect(() => getOtpHmacSecret({ NODE_ENV: "production", PAYROOST_OTP_SECRET: "" })).toThrow(
        OtpSecretConfigurationError
      );
      expect(() =>
        hashOtpCode("123456", undefined, { NODE_ENV: "production", PAYROOST_OTP_SECRET: "   " })
      ).toThrow(OtpSecretConfigurationError);
    });

    it("fails closed in development when PAYROOST_OTP_SECRET is missing", () => {
      expect(() => getOtpHmacSecret({ NODE_ENV: "development" })).toThrow(OtpSecretConfigurationError);
      expect(() =>
        hashOtpCode("123456", undefined, { NODE_ENV: "development" })
      ).toThrow(OtpSecretConfigurationError);
    });

    it("rejects short, placeholder, or invalid PAYROOST_OTP_SECRET without exposing the secret in errors", () => {
      const shortSecret = "too-short-secret-123";
      let capturedError: unknown;
      try {
        hashOtpCode("123456", undefined, {
          NODE_ENV: "production",
          PAYROOST_OTP_SECRET: shortSecret,
        });
      } catch (err) {
        capturedError = err;
      }
      expect(capturedError).toBeInstanceOf(OtpSecretConfigurationError);
      expect((capturedError as Error).message).not.toContain(shortSecret);

      const placeholderSecret = "some-company-default-otp-secret-do-not-use-in-production";
      expect(() =>
        hashOtpCode("123456", undefined, {
          NODE_ENV: "production",
          PAYROOST_OTP_SECRET: placeholderSecret,
        })
      ).toThrow(OtpSecretConfigurationError);

      expect(() =>
        hashOtpCode("123456", undefined, {
          NODE_ENV: "test",
          PAYROOST_OTP_SECRET: "short-test-secret",
        })
      ).toThrow(OtpSecretConfigurationError);
    });

    it("keeps unconfigured NODE_ENV=test deterministic via an ephemeral key without using a hardcoded secret", () => {
      const a = hashOtpCode("654321", undefined, { NODE_ENV: "test" });
      const b = hashOtpCode("654321", undefined, { NODE_ENV: "test" });
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
      const removedLegacyHash = createHmac(
        "sha256",
        ["payroost", "default", "otp", "secret", "key", "do", "not", "use", "in", "production"].join("-")
      )
        .update("654321", "utf8")
        .digest("hex");
      expect(a).not.toBe(removedLegacyHash);
    });
  });
});
