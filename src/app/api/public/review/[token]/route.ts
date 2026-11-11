import { NextResponse } from "next/server";
import { z } from "zod";
import { syncApprovedAgreementMilestones } from "@/features/milestones/sync";
import { syncNotificationsFromActivityEvents } from "@/features/notifications/service";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { hashReviewToken, hashOtpCode } from "@/lib/security/tokens";
import { enforcePublicReviewRateLimit } from "@/lib/security/review-rate-limit";
import { apiError } from "@/lib/http";

const decisionSchema = z.object({
  action: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  note: z.string().trim().max(10000).optional().default(""),
  actorLabel: z.string().trim().max(140).optional(),
  otpCode: z.string().trim().regex(/^\d{6}$/, "Must be a 6-digit OTP code"),
});

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const tokenHash = hashReviewToken(token);
  const rateLimitError = await enforcePublicReviewRateLimit(
    request,
    "review-read",
    tokenHash,
    30,
    60_000
  );
  if (rateLimitError) return rateLimitError;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_public_review", { p_token_hash: tokenHash });
  if (error || !data || (data as unknown[]).length !== 1) return apiError("REVIEW_UNAVAILABLE", 404);
  return NextResponse.json({ data: (data as unknown[])[0] });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const tokenHash = hashReviewToken(token);
  const rateLimitError = await enforcePublicReviewRateLimit(
    request,
    "review-write",
    tokenHash,
    6,
    60_000
  );
  if (rateLimitError) return rateLimitError;
  let body: unknown;
  try { body = await request.json(); } catch { return apiError("INVALID_JSON"); }
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR");
  let otpHmac: string;
  try {
    otpHmac = hashOtpCode(parsed.data.otpCode);
  } catch {
    return apiError("CONFIGURATION_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_public_review_with_otp", {
    p_token_hash: tokenHash,
    p_action: parsed.data.action,
    p_note: parsed.data.note,
    p_otp_hmac: otpHmac,
  });
  if (error) return apiError("REVIEW_UNAVAILABLE", 409);

  if (data === "APPROVED" || data === "CHANGES_REQUESTED") {
    try {
      const serviceClient = createServiceClient();
      const { data: reviewLink } = await serviceClient
        .from("review_links")
        .select("project_id, agreement_version_id")
        .eq("token_hash", tokenHash)
        .maybeSingle();

      const typedLink = reviewLink as {
        project_id?: string;
        agreement_version_id?: string;
      } | null;
      const projectId = typedLink?.project_id;
      if (projectId) {
        if (data === "APPROVED") {
          await syncApprovedAgreementMilestones({
            supabase: serviceClient,
            projectId,
            actorLabel: "Client OTP Approval",
          });

          if (typedLink?.agreement_version_id) {
            const { data: openRequests } = await serviceClient
              .from("change_requests")
              .select("id, agreement_version_id")
              .eq("project_id", projectId)
              .eq("status", "OPEN")
              .not("ai_analysis", "is", null)
              .neq("agreement_version_id", typedLink.agreement_version_id);

            for (const reqRow of (openRequests ?? []) as Array<{
              id: string;
              agreement_version_id: string;
            }>) {
              const { data: existingStale } = await serviceClient
                .from("activity_events")
                .select("id")
                .eq("project_id", projectId)
                .eq("event_type", "change_request.analysis_stale")
                .contains("metadata", {
                  changeRequestId: reqRow.id,
                  agreementVersionId: typedLink.agreement_version_id,
                })
                .limit(1);

              if (!existingStale || existingStale.length === 0) {
                await serviceClient.from("activity_events").insert({
                  project_id: projectId,
                  actor_label: "System",
                  event_type: "change_request.analysis_stale",
                  summary:
                    "Earlier AI scope-change analysis predates the newly approved agreement version",
                  metadata: {
                    changeRequestId: reqRow.id,
                    previousAgreementVersionId: reqRow.agreement_version_id,
                    agreementVersionId: typedLink.agreement_version_id,
                    stale: true,
                  },
                });
              }
            }
          }
        }

        await syncNotificationsFromActivityEvents({
          projectId,
          limit: 20,
          serviceClient,
        });
      }
    } catch {
      // Non-fatal fallback: workspace / portal load also runs idempotent catch-up sync
    }
  }

  return NextResponse.json({ status: data });
}
