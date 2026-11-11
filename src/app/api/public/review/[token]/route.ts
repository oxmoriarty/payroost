import { NextResponse } from "next/server";
import { z } from "zod";
import { syncApprovedAgreementMilestones } from "@/features/milestones/sync";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { hashReviewToken, hashOtpCode } from "@/lib/security/tokens";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";

const decisionSchema = z.object({
  action: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  note: z.string().trim().max(10000).optional().default(""),
  actorLabel: z.string().trim().max(140).optional(),
  otpCode: z.string().trim().regex(/^\d{6}$/, "Must be a 6-digit OTP code"),
});

function requestKey(request: Request, token: string) { return `${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}:${hashReviewToken(token).slice(0, 16)}`; }

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!(await allowRequest(`review-read:${requestKey(request, token)}`, 30, 60_000))) return apiError("RATE_LIMITED", 429);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_public_review", { p_token_hash: hashReviewToken(token) });
  if (error || !data || (data as unknown[]).length !== 1) return apiError("REVIEW_UNAVAILABLE", 404);
  return NextResponse.json({ data: (data as unknown[])[0] });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!(await allowRequest(`review-write:${requestKey(request, token)}`, 6, 60_000))) return apiError("RATE_LIMITED", 429);
  let body: unknown;
  try { body = await request.json(); } catch { return apiError("INVALID_JSON"); }
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR");
  const supabase = await createClient();
  const otpHmac = hashOtpCode(parsed.data.otpCode);
  const tokenHash = hashReviewToken(token);
  const { data, error } = await supabase.rpc("submit_public_review_with_otp", {
    p_token_hash: tokenHash,
    p_action: parsed.data.action,
    p_note: parsed.data.note,
    p_otp_hmac: otpHmac,
  });
  if (error) return apiError("REVIEW_UNAVAILABLE", 409);

  if (data === "APPROVED") {
    try {
      const serviceClient = createServiceClient();
      const { data: reviewLink } = await serviceClient
        .from("review_links")
        .select("project_id")
        .eq("token_hash", tokenHash)
        .maybeSingle();

      const projectId = (reviewLink as { project_id?: string } | null)?.project_id;
      if (projectId) {
        await syncApprovedAgreementMilestones({
          supabase: serviceClient,
          projectId,
          actorLabel: "Client OTP Approval",
        });
      }
    } catch {
      // Non-fatal fallback: workspace / portal load also runs idempotent catch-up sync
    }
  }

  return NextResponse.json({ status: data });
}
