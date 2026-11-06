import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  generatePortalOtpCode,
  computePortalOtpHmac,
  getPortalOtpHmacSecret,
  PortalOtpHmacConfigurationError,
} from "./portal-otp";

function setNodeEnv(env: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = env;
}

describe("Phase 3B.2.4: Portal OTP Security Utilities (portal-otp.ts)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecret = process.env.PORTAL_OTP_HMAC_SECRET;

  beforeEach(() => {
    setNodeEnv(originalNodeEnv);
    process.env.PORTAL_OTP_HMAC_SECRET = "test-hmac-secret-min-32-bytes-long-for-testing!!";
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    process.env.PORTAL_OTP_HMAC_SECRET = originalSecret;
  });

  it("generates a cryptographically random 6-digit OTP code", () => {
    const otp = generatePortalOtpCode();
    expect(otp).toHaveLength(6);
    expect(otp).toMatch(/^\d{6}$/);

    const intVal = parseInt(otp, 10);
    expect(intVal).toBeGreaterThanOrEqual(100000);
    expect(intVal).toBeLessThan(1000000);
  });

  it("produces distinct OTP codes across repeated invocations", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      codes.add(generatePortalOtpCode());
    }
    // High entropy verification: at least 45 unique codes in 50 generations
    expect(codes.size).toBeGreaterThan(45);
  });

  it("computes a 64-character SHA-256 HMAC digest in hex", () => {
    const otp = "123456";
    const hmac = computePortalOtpHmac(otp);
    expect(hmac).toHaveLength(64);
    expect(hmac).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deterministically computes identical HMAC for identical input and secret", () => {
    const otp = "654321";
    const secret = "fixed-test-secret-with-at-least-32-bytes-of-data!";
    const hmac1 = computePortalOtpHmac(otp, secret);
    const hmac2 = computePortalOtpHmac(otp, secret);
    expect(hmac1).toBe(hmac2);
  });

  it("produces different HMACs for different secrets or different OTPs", () => {
    const hmacA = computePortalOtpHmac("111111", "secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const hmacB = computePortalOtpHmac("111111", "secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const hmacC = computePortalOtpHmac("222222", "secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(hmacA).not.toBe(hmacB);
    expect(hmacA).not.toBe(hmacC);
  });

  it("rejects non-6-digit OTP codes", () => {
    expect(() => computePortalOtpHmac("12345")).toThrow(/exactly 6 digits/);
    expect(() => computePortalOtpHmac("1234567")).toThrow(/exactly 6 digits/);
    expect(() => computePortalOtpHmac("abcdef")).toThrow(/exactly 6 digits/);
    expect(() => computePortalOtpHmac("")).toThrow(/exactly 6 digits/);
  });

  it("production strictly requires PORTAL_OTP_HMAC_SECRET with at least 32 bytes", () => {
    setNodeEnv("production");
    delete process.env.PORTAL_OTP_HMAC_SECRET;

    expect(() => getPortalOtpHmacSecret()).toThrow(PortalOtpHmacConfigurationError);
    expect(() => getPortalOtpHmacSecret()).toThrow(/Production requires PORTAL_OTP_HMAC_SECRET/);

    // Short secret (< 32 bytes) rejected in production
    process.env.PORTAL_OTP_HMAC_SECRET = "short-secret-only-24-bytes";
    expect(() => getPortalOtpHmacSecret()).toThrow(PortalOtpHmacConfigurationError);
    expect(() => getPortalOtpHmacSecret()).toThrow(/at least 32 bytes/);

    // Valid secret (>= 32 bytes) accepted in production
    process.env.PORTAL_OTP_HMAC_SECRET = "production-cryptographic-secret-key-with-sufficient-length-32+";
    expect(getPortalOtpHmacSecret()).toBe(process.env.PORTAL_OTP_HMAC_SECRET);
  });

  it("development falls back to development secret when unconfigured", () => {
    setNodeEnv("development");
    delete process.env.PORTAL_OTP_HMAC_SECRET;

    const secret = getPortalOtpHmacSecret();
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });
});
