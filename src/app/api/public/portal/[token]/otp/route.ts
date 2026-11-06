import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { hashPortalToken } from "@/lib/security/tokens";
import {
  generatePortalOtpCode,
  computePortalOtpHmac,
} from "@/lib/security/portal-otp";
import { checkRateLimit } from "@/lib/security/rate-limit";
import {
  getClientIp,
  getPortalTokenRateLimitKey,
  getPortalIpRateLimitKey,
} from "@/lib/security/client-ip";
import { sendPortalOtpEmail } from "@/lib/email/provider";
import { apiError } from "@/lib/http";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;

export async function POST(
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

  // 2. Reject unexpected or malicious caller input
  const bodyText = await request.text();
  if (bodyText.trim().length > 0) {
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return apiError("INVALID_JSON", 400, {
        "Cache-Control": "no-store",
      });
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    // Do not accept arbitrary client email, OTP, expiresAt, or project ID from request body
    const keys = Object.keys(json);
    if (keys.length > 0) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 3. Hash raw invitation token immediately
  const tokenHash = hashPortalToken(token);

  // 4. Rate limiting: Mandatory primary token limit (5 req / 15 min), optional secondary IP limit
  const tokenLimitKey = getPortalTokenRateLimitKey("portal-otp", tokenHash);
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

  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimitKey = getPortalIpRateLimitKey("portal-otp", clientIp);
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

  // 5. Generate cryptographically secure 6-digit OTP and HMAC
  let otpCode: string;
  let otpHmac: string;
  try {
    otpCode = generatePortalOtpCode();
    otpHmac = computePortalOtpHmac(otpCode);
  } catch {
    return apiError("CONFIGURATION_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  // 6. Invoke database RPC create_portal_otp_challenge via privileged service client
  // RPC verifies token validity, replaces prior active challenges, and returns client email + title
  const supabase = createServiceClient();
  const { data, error: rpcError } = await supabase.rpc(
    "create_portal_otp_challenge",
    {
      p_portal_token_hash: tokenHash,
      p_otp_hmac: otpHmac,
      p_expires_at: expiresAt,
    }
  );

  if (rpcError || !data || typeof data !== "object") {
    // Sanitized 404: token is invalid, expired, revoked, consumed, or unverified
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  const challengeInfo = data as {
    challengeId: string;
    clientEmail: string;
    projectTitle: string;
  };

  // 7. Dispatch portal OTP email to the verified client email from database
  const delivery = await sendPortalOtpEmail({
    clientEmail: challengeInfo.clientEmail,
    projectTitle: challengeInfo.projectTitle,
    otpCode,
    expiresInMinutes: 15,
  });

  if (!delivery.success) {
    return apiError("EMAIL_DELIVERY_FAILED", 502, {
      "Cache-Control": "no-store",
    });
  }

  // 8. Success response: Never include OTP or HMAC in HTTP response
  return NextResponse.json(
    {
      success: true,
      challengeId: challengeInfo.challengeId,
      message: "A verification code has been sent to the verified client email.",
      expiresInSeconds: 900,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
