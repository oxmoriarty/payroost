import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { hashVerificationToken } from "@/lib/security/tokens";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/client-ip";
import { apiError } from "@/lib/http";

const verifySchema = z.object({
  token: z.string().min(10).max(200),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
  }

  const tokenHash = hashVerificationToken(parsed.data.token);

  const tokenLimit = await checkRateLimit(`verify-client-email:${tokenHash}`, 10, 60_000, {
    failClosedInProduction: true,
  });
  if (!tokenLimit.allowed) {
    if (tokenLimit.status === "service_unavailable") {
      return apiError("RATE_LIMITER_UNAVAILABLE", 503, NO_STORE);
    }
    return apiError("RATE_LIMITED", 429, NO_STORE);
  }

  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimit = await checkRateLimit(`verify-client-email-ip:${clientIp}`, 10, 60_000, {
      failClosedInProduction: true,
    });
    if (!ipLimit.allowed) {
      if (ipLimit.status === "service_unavailable") {
        return apiError("RATE_LIMITER_UNAVAILABLE", 503, NO_STORE);
      }
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("verify_client_email", {
    p_token_hash: tokenHash,
  });

  if (error || !data) {
    return apiError("VERIFICATION_FAILED", 400, NO_STORE);
  }

  return NextResponse.json(
    {
      success: true,
      data,
    },
    { headers: NO_STORE }
  );
}
