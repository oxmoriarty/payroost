import { describe, it, expect } from "vitest";
import {
  isProxyTrustEnabled,
  getClientIp,
  getPortalTokenRateLimitKey,
  getPortalIpRateLimitKey,
  getReviewTokenRateLimitKey,
  getReviewIpRateLimitKey,
} from "./client-ip";

describe("client-ip: Client IP Trust Hardening & Proxy Verification", () => {
  function makeRequest(headers: Record<string, string>): Request {
    return new Request("https://payroost.com/test", { headers });
  }

  const sampleTokenHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  describe("isProxyTrustEnabled", () => {
    it("returns false by default (unset or empty environment)", () => {
      expect(isProxyTrustEnabled({})).toBe(false);
      expect(isProxyTrustEnabled({ TRUST_PROXY: undefined })).toBe(false);
      expect(isProxyTrustEnabled({ TRUST_PROXY: "" })).toBe(false);
    });

    it("returns false in production when TRUST_PROXY is not explicitly 'true'", () => {
      expect(isProxyTrustEnabled({ NODE_ENV: "production" })).toBe(false);
      expect(isProxyTrustEnabled({ NODE_ENV: "production", TRUST_PROXY: "false" })).toBe(false);
      expect(isProxyTrustEnabled({ NODE_ENV: "production", TRUST_PROXY: "1" })).toBe(false);
      expect(isProxyTrustEnabled({ NODE_ENV: "production", TRUST_PROXY: "yes" })).toBe(false);
    });

    it("returns true only when TRUST_PROXY is strictly 'true'", () => {
      expect(isProxyTrustEnabled({ TRUST_PROXY: "true" })).toBe(true);
      expect(isProxyTrustEnabled({ NODE_ENV: "production", TRUST_PROXY: "true" })).toBe(true);
    });
  });

  describe("getClientIp: Proxy Trust Enforcement", () => {
    it("1. ignores proxy headers by default and returns null", () => {
      const req = makeRequest({
        "x-forwarded-for": "198.51.100.25",
        "x-real-ip": "198.51.100.50",
      });
      // Default environment without TRUST_PROXY="true"
      expect(getClientIp(req, {})).toBeNull();
    });

    it("returns null when TRUST_PROXY is explicitly 'false'", () => {
      const req = makeRequest({ "x-forwarded-for": "198.51.100.25" });
      expect(getClientIp(req, { TRUST_PROXY: "false" })).toBeNull();
    });

    it("extracts a valid single IPv4 address when proxy trust is explicitly enabled", () => {
      const req = makeRequest({ "x-forwarded-for": "198.51.100.25" });
      expect(getClientIp(req, { TRUST_PROXY: "true" })).toBe("198.51.100.25");
    });

    it("extracts a valid IPv6 address when proxy trust is explicitly enabled", () => {
      const req = makeRequest({ "x-forwarded-for": "2001:db8:85a3::8a2e:370:7334" });
      expect(getClientIp(req, { TRUST_PROXY: "true" })).toBe("2001:db8:85a3::8a2e:370:7334");
    });

    it("gives x-real-ip precedence over x-forwarded-for when proxy trust is enabled", () => {
      const req = makeRequest({
        "x-forwarded-for": "1.1.1.1, 10.0.0.1",
        "x-real-ip": "198.51.100.50",
      });
      expect(getClientIp(req, { TRUST_PROXY: "true" })).toBe("198.51.100.50");
    });

    it("extracts rightmost proxy-appended address from multi-hop x-forwarded-for when proxy trust is enabled", () => {
      const req = makeRequest({
        "x-forwarded-for": "1.1.1.1, 10.0.0.1, 203.0.113.195",
      });
      expect(getClientIp(req, { TRUST_PROXY: "true" })).toBe("203.0.113.195");
    });

    it("skips trailing invalid tokens to find the nearest valid proxy address", () => {
      const req = makeRequest({
        "x-forwarded-for": "1.1.1.1, 198.51.100.25, invalid-trailing-entry",
      });
      expect(getClientIp(req, { TRUST_PROXY: "true" })).toBe("198.51.100.25");
    });

    it("rejects malformed IPv4 octets (e.g. 999.999.999.999) and returns null", () => {
      const req = makeRequest({ "x-forwarded-for": "999.999.999.999" });
      expect(getClientIp(req, { TRUST_PROXY: "true" })).toBeNull();
    });

    it("rejects non-numeric or injection formats (e.g. 1.2.3.4.5, dots, or SQL syntax)", () => {
      expect(getClientIp(makeRequest({ "x-forwarded-for": "1.2.3.4.5" }), { TRUST_PROXY: "true" })).toBeNull();
      expect(getClientIp(makeRequest({ "x-forwarded-for": "....::::" }), { TRUST_PROXY: "true" })).toBeNull();
      expect(getClientIp(makeRequest({ "x-forwarded-for": "127.0.0.1; DROP TABLE" }), { TRUST_PROXY: "true" })).toBeNull();
    });

    it("returns null when no proxy headers are present even if trust is enabled", () => {
      const req = makeRequest({});
      expect(getClientIp(req, { TRUST_PROXY: "true" })).toBeNull();
    });
  });

  describe("getPortalTokenRateLimitKey: Independent Primary Token Identity", () => {
    it("1. token rate-limit key never contains an IP address and uses full 64-char tokenHash", () => {
      const keyGet = getPortalTokenRateLimitKey("portal-get", sampleTokenHash);
      const keyOtp = getPortalTokenRateLimitKey("portal-otp", sampleTokenHash);
      const keySession = getPortalTokenRateLimitKey("portal-session", sampleTokenHash);
      const keyIntent = getPortalTokenRateLimitKey("portal-payment-intent", sampleTokenHash);

      expect(keyGet).toBe(`portal-get:${sampleTokenHash}`);
      expect(keyOtp).toBe(`portal-otp:${sampleTokenHash}`);
      expect(keySession).toBe(`portal-session:${sampleTokenHash}`);
      expect(keyIntent).toBe(`portal-payment-intent:${sampleTokenHash}`);
      expect(keyGet).not.toContain("198.51");
      expect(keyGet).not.toContain("unknown");
    });

    it("2. token rate-limit key is strictly independent of any request or IP header", () => {
      // Regardless of what caller passes, the token key is determined solely by the token hash
      const key1 = getPortalTokenRateLimitKey("portal-get", sampleTokenHash);
      const key2 = getPortalTokenRateLimitKey("portal-get", sampleTokenHash);
      expect(key1).toBe(key2);
    });
  });

  describe("getPortalIpRateLimitKey: Independent Secondary IP Identity", () => {
    it("1. IP rate-limit key uses dedicated prefix and never combines with token hash", () => {
      const keyGet = getPortalIpRateLimitKey("portal-get", "198.51.100.25");
      const keyOtp = getPortalIpRateLimitKey("portal-otp", "198.51.100.25");
      const keyIntent = getPortalIpRateLimitKey("portal-payment-intent", "198.51.100.25");

      expect(keyGet).toBe("portal-get-ip:198.51.100.25");
      expect(keyOtp).toBe("portal-otp-ip:198.51.100.25");
      expect(keyIntent).toBe("portal-payment-intent-ip:198.51.100.25");
      expect(keyGet).not.toContain(sampleTokenHash);
    });
  });

  describe("getReviewTokenRateLimitKey & getReviewIpRateLimitKey", () => {
    it("separates primary token hash identity from optional IP key", () => {
      expect(getReviewTokenRateLimitKey("review-read", sampleTokenHash)).toBe(
        `review-read:${sampleTokenHash}`
      );
      expect(getReviewTokenRateLimitKey("review-write", sampleTokenHash)).toBe(
        `review-write:${sampleTokenHash}`
      );
      expect(getReviewTokenRateLimitKey("review-otp", sampleTokenHash)).toBe(
        `review-otp:${sampleTokenHash}`
      );
      expect(getReviewIpRateLimitKey("review-write", "203.0.113.5")).toBe(
        "review-write-ip:203.0.113.5"
      );
    });
  });
});
