import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hashPortalToken, hashSessionToken } from "@/lib/security/tokens";
import { computePortalOtpHmac } from "@/lib/security/portal-otp";
import {
  generatePortalSessionCredentials,
  setPortalSessionCookie,
  getPortalSessionToken,
  clearPortalSessionCookie,
} from "@/lib/security/portal-session";
import { checkRateLimit } from "@/lib/security/rate-limit";
import {
  getClientIp,
  getPortalTokenRateLimitKey,
  getPortalIpRateLimitKey,
} from "@/lib/security/client-ip";
import { apiError } from "@/lib/http";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OTP_REGEX = /^\d{6}$/;

interface OtpVerificationPayload {
  challengeId: string;
  otp: string;
}

/**
 * POST /api/public/portal/[token]/session
 *
 * Verifies the 6-digit numerical OTP challenge against the invitation token.
 * On success, issues a secure HttpOnly session cookie and returns the CSRF secret.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;

  // 1. Validate invitation token format
  if (!token || !TOKEN_REGEX.test(token)) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 2. Strict request body validation
  let payload: OtpVerificationPayload;
  try {
    const bodyText = await request.text();
    if (!bodyText || bodyText.trim().length === 0) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    const rawJson = JSON.parse(bodyText);
    if (typeof rawJson !== "object" || rawJson === null || Array.isArray(rawJson)) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    // Strict parameter check: only allow challengeId and otp
    const keys = Object.keys(rawJson);
    const allowedKeys = new Set(["challengeId", "otp"]);
    if (keys.length !== 2 || !keys.every((k) => allowedKeys.has(k))) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    const { challengeId, otp } = rawJson as Record<string, unknown>;
    if (
      typeof challengeId !== "string" ||
      !UUID_REGEX.test(challengeId) ||
      typeof otp !== "string" ||
      !OTP_REGEX.test(otp)
    ) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    payload = { challengeId, otp };
  } catch {
    return apiError("INVALID_JSON", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 3. Rate limiting (Mandatory token limit + optional IP limit)
  const tokenHash = hashPortalToken(token);

  // Mandatory primary limit: Token-based rate limiting (always enforced, never contains IP)
  const tokenLimitKey = getPortalTokenRateLimitKey("portal-session", tokenHash);
  const tokenLimit = await checkRateLimit(tokenLimitKey, 5, 900_000, {
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

  // Optional secondary limit: IP-based rate limiting (only when TRUST_PROXY="true" and valid IP extracted)
  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimitKey = getPortalIpRateLimitKey("portal-session", clientIp);
    const ipLimit = await checkRateLimit(ipLimitKey, 5, 900_000, {
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

  // 4. Compute cryptographic credentials
  let otpHmac: string;
  try {
    otpHmac = computePortalOtpHmac(payload.otp);
  } catch {
    return apiError("SERVER_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  const credentials = generatePortalSessionCredentials();

  // 5. Invoke database verification RPC
  const supabase = await createClient();
  const { data, error: rpcError } = await supabase.rpc(
    "verify_portal_otp_and_create_session",
    {
      p_portal_token_hash: tokenHash,
      p_challenge_id: payload.challengeId,
      p_otp_hmac: otpHmac,
      p_session_token_hash: credentials.sessionTokenHash,
      p_csrf_secret: credentials.csrfSecret,
      p_session_duration: "12 hours",
    }
  );

  if (rpcError || !data || typeof data !== "object") {
    return apiError("SERVER_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  const result = data as {
    status?: string;
    sessionId?: string;
    attempts?: number;
    remainingAttempts?: number;
  };

  // 6. Handle verification outcomes
  switch (result.status) {
    case "SUCCESS": {
      // Set the session cookie only on database confirmation
      await setPortalSessionCookie(credentials.rawSessionToken);

      return NextResponse.json(
        {
          success: true,
          csrfToken: credentials.csrfSecret,
        },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    case "INVALID_OTP": {
      return NextResponse.json(
        {
          error: "INVALID_OTP",
          remainingAttempts: result.remainingAttempts ?? 0,
        },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    case "OTP_EXHAUSTED": {
      return NextResponse.json(
        {
          error: "OTP_EXHAUSTED",
          remainingAttempts: 0,
        },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    case "OTP_EXPIRED": {
      return apiError("OTP_EXPIRED", 401, {
        "Cache-Control": "no-store",
      });
    }

    case "CHALLENGE_ALREADY_CONSUMED": {
      return apiError("CHALLENGE_ALREADY_CONSUMED", 401, {
        "Cache-Control": "no-store",
      });
    }

    case "INVITATION_NOT_FOUND":
    case "CHALLENGE_NOT_FOUND": {
      // Uniform sanitized 404 prevents enumeration of tokens or challenge associations
      return apiError("INVITATION_NOT_FOUND", 404, {
        "Cache-Control": "no-store",
      });
    }

    case "CLIENT_EMAIL_CHANGED": {
      return apiError("AUTHENTICATION_FAILED", 401, {
        "Cache-Control": "no-store",
      });
    }

    default: {
      return apiError("AUTHENTICATION_FAILED", 401, {
        "Cache-Control": "no-store",
      });
    }
  }
}

/**
 * DELETE /api/public/portal/[token]/session
 *
 * Terminates the client portal session.
 * Revokes the session in the database if bound to the token's project, and clears the session cookie.
 * Always idempotent with Cache-Control: no-store.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;

  // 1. Validate invitation token format
  if (!token || !TOKEN_REGEX.test(token)) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 2. Read raw session token from HttpOnly cookie
  const rawSessionToken = await getPortalSessionToken();

  // If no session cookie is present, clear cookie safely and return 200 (idempotent)
  if (!rawSessionToken) {
    await clearPortalSessionCookie();
    return NextResponse.json(
      { success: true },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  // 3. Hash session token and invitation token
  const tokenHash = hashPortalToken(token);
  const sessionTokenHash = hashSessionToken(rawSessionToken);

  // 4. Revoke session in database
  const supabase = await createClient();
  const { error: rpcError } = await supabase.rpc("revoke_portal_session_v2", {
    p_portal_token_hash: tokenHash,
    p_session_token_hash: sessionTokenHash,
  });

  if (rpcError) {
    return apiError("SERVER_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 5. Clear cookie upon successful revocation
  await clearPortalSessionCookie();

  return NextResponse.json(
    { success: true },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
