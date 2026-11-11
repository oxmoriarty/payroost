import "server-only";
import type { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { checkRateLimit } from "@/lib/security/rate-limit";
import {
  getClientIp,
  getReviewIpRateLimitKey,
  getReviewTokenRateLimitKey,
  type ReviewRateLimitPrefix,
} from "@/lib/security/client-ip";

/**
 * Enforces primary token-hash rate limiting and secondary trusted-proxy IP
 * rate limiting for public review routes, failing closed in production when the
 * rate-limit backend is unavailable.
 */
export async function enforcePublicReviewRateLimit(
  request: Request,
  prefix: ReviewRateLimitPrefix,
  tokenHash: string,
  limit: number,
  windowMs: number
): Promise<NextResponse | null> {
  const keys = [getReviewTokenRateLimitKey(prefix, tokenHash)];
  const clientIp = getClientIp(request);
  if (clientIp) {
    keys.push(getReviewIpRateLimitKey(prefix, clientIp));
  }

  for (const key of keys) {
    const result = await checkRateLimit(key, limit, windowMs, {
      failClosedInProduction: true,
    });

    if (!result.allowed) {
      if (result.status === "service_unavailable") {
        return apiError("RATE_LIMITER_UNAVAILABLE", 503, {
          "Cache-Control": "no-store",
        });
      }
      return apiError("RATE_LIMITED", 429, {
        "Cache-Control": "no-store",
      });
    }
  }

  return null;
}
