import "server-only";
import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";

type InMemoryBucket = { count: number; resetAt: number };
const inMemoryBuckets = new Map<string, InMemoryBucket>();

export function _resetInMemoryRateLimits(): void {
  inMemoryBuckets.clear();
}

function hashKeyForPrivacy(rawKey: string): string {
  // Scoped prefix + SHA-256 digest so sensitive identifiers (IP, email) are never stored in plaintext
  const prefix = rawKey.split(":")[0] || "rl";
  const digest = createHash("sha256").update(rawKey, "utf8").digest("hex").slice(0, 32);
  return `${prefix}:${digest}`;
}

export type RateLimitStatus = "allowed" | "rate_limited" | "service_unavailable";

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  resetAt: number;
  status: RateLimitStatus;
  isUnavailable?: boolean;
}

export interface RateLimitOptions {
  failClosedInProduction?: boolean;
}

export async function allowRequest(
  key: string,
  limit = 10,
  windowMs = 60_000,
  options?: RateLimitOptions
): Promise<boolean> {
  const result = await checkRateLimit(key, limit, windowMs, options);
  return result.allowed;
}

export async function checkRateLimit(
  key: string,
  limit = 10,
  windowMs = 60_000,
  options?: RateLimitOptions
): Promise<RateLimitResult> {
  const bucketKey = hashKeyForPrivacy(key);
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const isProduction = process.env.NODE_ENV === "production";
  const shouldFailClosed = options?.failClosedInProduction ?? isProduction;

  let dbFailed = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("consume_rate_limit", {
      p_key: bucketKey,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    if (!error && data && typeof data === "object") {
      const res = data as { allowed: boolean; current: number; limit: number; resetAt: string };
      const allowed = Boolean(res.allowed);
      return {
        allowed,
        current: Number(res.current),
        limit: Number(res.limit),
        resetAt: new Date(res.resetAt).getTime(),
        status: allowed ? "allowed" : "rate_limited",
        isUnavailable: false,
      };
    }

    if (error) {
      dbFailed = true;
    }
  } catch {
    dbFailed = true;
  }

  // In production (or when fail-closed is explicitly enforced), do not fall back to in-memory if DB failed
  if (dbFailed && (isProduction || shouldFailClosed)) {
    return {
      allowed: false,
      current: limit + 1,
      limit,
      resetAt: Date.now() + windowMs,
      status: "service_unavailable",
      isUnavailable: true,
    };
  }

  // Resilient in-memory fallback for development and isolated unit test environments
  const now = Date.now();
  const existing = inMemoryBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    inMemoryBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      current: 1,
      limit,
      resetAt: now + windowMs,
      status: "allowed",
      isUnavailable: false,
    };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    current: existing.count,
    limit,
    resetAt: existing.resetAt,
    status: allowed ? "allowed" : "rate_limited",
    isUnavailable: false,
  };
}
