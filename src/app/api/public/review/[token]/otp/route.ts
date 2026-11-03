import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { hashReviewToken, createOtpCode, hashOtpCode } from "@/lib/security/tokens";
import { allowRequest } from "@/lib/security/rate-limit";
import { sendReviewOtpEmail } from "@/lib/email/provider";
import { maskEmail } from "@/lib/utils";
import { apiError } from "@/lib/http";

const otpRequestSchema = z.object({
  action: z.enum(["APPROVE", "REQUEST_CHANGES"]),
});

function requestKey(request: Request, token: string) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  return `${ip}:${hashReviewToken(token).slice(0, 16)}`;
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  if (!(await allowRequest(`otp-req:${requestKey(request, token)}`, 5, 900_000))) {
    return apiError("RATE_LIMITED", 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON");
  }

  const parsed = otpRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR");
  }

  const supabase = await createClient();
  const tokenHash = hashReviewToken(token);
  const otpCode = createOtpCode();
  const otpHmac = hashOtpCode(otpCode);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  const { data, error } = await supabase.rpc("request_review_otp", {
    p_token_hash: tokenHash,
    p_action: parsed.data.action,
    p_otp_hmac: otpHmac,
    p_expires_at: expiresAt,
  });

  if (error || !data) {
    return apiError("REVIEW_UNAVAILABLE", 400);
  }

  const challengeInfo = data as { clientEmail: string; projectTitle: string };

  // Dispatch OTP email to the verified client email address
  const delivery = await sendReviewOtpEmail({
    clientEmail: challengeInfo.clientEmail,
    projectTitle: challengeInfo.projectTitle,
    action: parsed.data.action,
    otpCode,
  });

  if (!delivery.success) {
    return NextResponse.json({
      success: false,
      deliveryWarning: delivery.error,
      maskedEmail: maskEmail(challengeInfo.clientEmail),
      expiresInSeconds: 900,
    }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    maskedEmail: maskEmail(challengeInfo.clientEmail),
    expiresInSeconds: 900,
  });
}
