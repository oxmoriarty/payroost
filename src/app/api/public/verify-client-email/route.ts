import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { hashVerificationToken } from "@/lib/security/tokens";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";

const verifySchema = z.object({
  token: z.string().min(10).max(200),
});

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export async function POST(request: Request) {
  const ip = requestIp(request);
  if (!(await allowRequest(`verify-client-email:${ip}`, 10, 60_000))) {
    return apiError("RATE_LIMITED", 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON");
  }

  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR");
  }

  const supabase = await createClient();
  const tokenHash = hashVerificationToken(parsed.data.token);

  const { data, error } = await supabase.rpc("verify_client_email", {
    p_token_hash: tokenHash,
  });

  if (error || !data) {
    return apiError("VERIFICATION_FAILED", 400);
  }

  return NextResponse.json({
    success: true,
    data,
  });
}
