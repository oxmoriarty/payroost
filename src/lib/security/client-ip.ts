import "server-only";
import { isIP } from "node:net";

export type EnvRecord = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Returns whether proxy trust is explicitly enabled in environment configuration.
 *
 * Security Invariant:
 * - Proxy trust is DISABLED by default across all environments (including production).
 * - Only the exact string value "true" enables proxy trust.
 * - Do not assume hosting environments sanitize headers without an explicit deployment configuration.
 */
export function isProxyTrustEnabled(env: EnvRecord = process.env): boolean {
  return env.TRUST_PROXY === "true";
}

/**
 * Extracts and sanitizes the client IP address from incoming HTTP requests ONLY
 * when proxy trust is explicitly configured.
 *
 * Security Architecture & Deployment Assumptions:
 * 1. Default Untrusted Posture:
 *    - Unless `TRUST_PROXY="true"` is explicitly configured, all proxy headers (`X-Real-IP`,
 *      `X-Forwarded-For`, etc.) are treated as untrusted client input and IGNORED.
 *    - Returns `null` when proxy trust is disabled or when no trustworthy IP is found.
 * 2. Explicitly Trusted Proxy Contract:
 *    - When `TRUST_PROXY="true"` is configured, the deployment assumes that an upstream
 *      reverse proxy or load balancer is under operational control and configured to overwrite
 *      or sanitize client-supplied forwarding headers.
 *    - `X-Real-IP`: Takes precedence when present and valid.
 *    - `X-Forwarded-For`: Inspected from right to left (last entry appended by the nearest trusted proxy).
 * 3. Strict RFC Validation:
 *    - All candidates are strictly validated via Node.js `isIP()` (ensuring RFC-compliant IPv4 or IPv6).
 *    - Malformed values, invalid octets (e.g. 999.999.999.999), or injection attempts are discarded.
 */
export function getClientIp(
  request: Request,
  env: EnvRecord = process.env
): string | null {
  if (!isProxyTrustEnabled(env)) {
    return null;
  }

  // 1. Check X-Real-IP first (overwritten by trusted edge reverse proxy)
  const realIpHeader = request.headers.get("x-real-ip")?.trim();
  if (realIpHeader && isIP(realIpHeader) !== 0) {
    return realIpHeader.slice(0, 45);
  }

  // 2. Check X-Forwarded-For: inspect from right to left (last entry is appended by the nearest proxy)
  const forwardedHeader = request.headers.get("x-forwarded-for");
  if (forwardedHeader) {
    const parts = forwardedHeader.split(",").map((p) => p.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = parts[i];
      if (candidate && isIP(candidate) !== 0) {
        return candidate.slice(0, 45);
      }
    }
  }

  return null;
}

export type PortalRateLimitPrefix =
  | "portal-get"
  | "portal-otp"
  | "portal-session"
  | "portal-payment-intent"
  | "portal-payment-order"
  | "portal-payment-capture";

/**
 * Derives the mandatory, primary token-based rate-limit key.
 *
 * Invariant: Never contains an IP address. Rotating or spoofing IP headers
 * does not create a new token bucket. Uses the full 64-character SHA-256 token hash.
 */
export function getPortalTokenRateLimitKey(
  prefix: PortalRateLimitPrefix,
  tokenHash: string
): string {
  return `${prefix}:${tokenHash}`;
}

/**
 * Derives the optional, secondary IP-based rate-limit key.
 *
 * Invariant: Never combined with the token hash. Only used when proxy trust
 * is explicitly enabled and a valid IP is extracted.
 */
export function getPortalIpRateLimitKey(
  prefix: PortalRateLimitPrefix,
  ip: string
): string {
  return `${prefix}-ip:${ip}`;
}
