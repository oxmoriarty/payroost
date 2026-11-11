import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiError } from "@/lib/http";
import { getClientIp } from "@/lib/security/client-ip";
import { authenticatePortalSession } from "@/lib/security/portal-session";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { hashPortalToken } from "@/lib/security/tokens";
import { createServiceClient } from "@/lib/supabase/service";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export type AuthenticatedPortalRequest =
  | {
      ok: true;
      serviceClient: SupabaseClient;
      projectId: string;
      clientEmail: string;
      tokenHash: string;
    }
  | {
      ok: false;
      response: NextResponse;
    };

/**
 * Authenticates and rate-limits a Client Portal mutating or AI-analysis request using
 * the canonical token + HttpOnly portal session + CSRF + project-binding pipeline.
 */
export async function authenticatePortalRequest(params: {
  request: Request;
  rawToken: string;
  rateLimitPrefix: "portal-scope-analyze" | "portal-change-request" | "portal-assistant";
  limit: number;
  windowMs: number;
}): Promise<AuthenticatedPortalRequest> {
  const { request, rawToken, rateLimitPrefix, limit, windowMs } = params;

  if (!rawToken || !TOKEN_REGEX.test(rawToken)) {
    return {
      ok: false,
      response: apiError("INVITATION_NOT_FOUND", 404, NO_STORE),
    };
  }

  const tokenHash = hashPortalToken(rawToken);

  // Primary token-hash rate limit (never includes IP)
  const tokenLimit = await checkRateLimit(`${rateLimitPrefix}:${tokenHash}`, limit, windowMs, {
    failClosedInProduction: true,
  });

  if (!tokenLimit.allowed) {
    if (tokenLimit.status === "service_unavailable") {
      return {
        ok: false,
        response: apiError("RATE_LIMITER_UNAVAILABLE", 503, NO_STORE),
      };
    }
    return {
      ok: false,
      response: apiError("RATE_LIMITED", 429, NO_STORE),
    };
  }

  // Optional secondary IP limit only when proxy trust is explicitly enabled
  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimit = await checkRateLimit(`${rateLimitPrefix}-ip:${clientIp}`, limit, windowMs, {
      failClosedInProduction: true,
    });
    if (!ipLimit.allowed) {
      if (ipLimit.status === "service_unavailable") {
        return {
          ok: false,
          response: apiError("RATE_LIMITER_UNAVAILABLE", 503, NO_STORE),
        };
      }
      return {
        ok: false,
        response: apiError("RATE_LIMITED", 429, NO_STORE),
      };
    }
  }

  const csrfToken = request.headers.get("x-csrf-token");
  if (!csrfToken) {
    return {
      ok: false,
      response: apiError("INVALID_CSRF_TOKEN", 403, NO_STORE),
    };
  }

  let serviceClient: SupabaseClient;
  try {
    serviceClient = createServiceClient();
  } catch {
    return {
      ok: false,
      response: apiError("CONFIGURATION_ERROR", 500, NO_STORE),
    };
  }

  const { data: portalToken, error: tokenError } = await serviceClient
    .from("client_portal_tokens")
    .select("project_id, revoked_at, consumed_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError) {
    return {
      ok: false,
      response: apiError("DATABASE_UNAVAILABLE", 503, NO_STORE),
    };
  }

  const tokenRow = portalToken as {
    project_id: string;
    revoked_at: string | null;
    consumed_at: string | null;
    expires_at: string;
  } | null;

  if (
    !tokenRow ||
    tokenRow.revoked_at !== null ||
    tokenRow.consumed_at !== null ||
    new Date(tokenRow.expires_at) <= new Date()
  ) {
    return {
      ok: false,
      response: apiError("INVITATION_NOT_FOUND", 404, NO_STORE),
    };
  }

  const sessionAuth = await authenticatePortalSession({
    csrfToken,
    requireCsrf: true,
    expectedProjectId: tokenRow.project_id,
    supabaseClient: serviceClient,
  });

  if (!sessionAuth.success) {
    return {
      ok: false,
      response: apiError(sessionAuth.error, sessionAuth.status, NO_STORE),
    };
  }

  return {
    ok: true,
    serviceClient,
    projectId: tokenRow.project_id,
    clientEmail: sessionAuth.clientEmail,
    tokenHash,
  };
}
