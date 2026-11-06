import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hashPortalToken } from "@/lib/security/tokens";
import { checkRateLimit } from "@/lib/security/rate-limit";
import {
  getClientIp,
  getPortalTokenRateLimitKey,
  getPortalIpRateLimitKey,
} from "@/lib/security/client-ip";
import { apiError } from "@/lib/http";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;

  // 1. Validate token format (reject malformed or oversized tokens)
  if (!token || !TOKEN_REGEX.test(token)) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 2. Hash raw token immediately (raw token never sent to database)
  const tokenHash = hashPortalToken(token);

  // 3. Mandatory primary limit: Token-based rate limiting (always enforced, never contains IP)
  const tokenLimitKey = getPortalTokenRateLimitKey("portal-get", tokenHash);
  const tokenLimit = await checkRateLimit(tokenLimitKey, 30, 900_000, {
    failClosedInProduction: true,
  });

  if (!tokenLimit.allowed) {
    if (tokenLimit.status === "service_unavailable") {
      return apiError("RATE_LIMITER_UNAVAILABLE", 503, {
        "Cache-Control": "no-store",
      });
    }
    return apiError("RATE_LIMITED", 429, {
      "Cache-Control": "no-store",
    });
  }

  // 4. Optional secondary limit: IP-based rate limiting (only when TRUST_PROXY="true" and valid IP extracted)
  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimitKey = getPortalIpRateLimitKey("portal-get", clientIp);
    const ipLimit = await checkRateLimit(ipLimitKey, 30, 900_000, {
      failClosedInProduction: true,
    });

    if (!ipLimit.allowed) {
      if (ipLimit.status === "service_unavailable") {
        return apiError("RATE_LIMITER_UNAVAILABLE", 503, {
          "Cache-Control": "no-store",
        });
      }
      return apiError("RATE_LIMITED", 429, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 4. Query database via read-only SECURITY DEFINER RPC
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("validate_portal_invitation", {
    p_token_hash: tokenHash,
  });

  if (error) {
    // Database error: sanitized 500 response
    return apiError("SERVER_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 5. Invariant: Return consistent 404 for missing, expired, revoked, consumed, or unverified invitations
  if (!data || typeof data !== "object" || !("valid" in data)) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  const invitation = data as { valid: boolean; projectTitle: string; expiresAt: string };

  // 6. Return minimal metadata required for portal entry page
  return NextResponse.json(
    {
      valid: true,
      projectTitle: invitation.projectTitle,
      expiresAt: invitation.expiresAt,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
