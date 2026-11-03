import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectOwner } from "@/features/projects/authorization";
import { createReviewToken, hashReviewToken } from "@/lib/security/tokens";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";

const requestSchema = z.object({ expiresInDays: z.number().int().min(1).max(30).optional() });

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  if (!(await allowRequest(`review-link-create:${projectId}`, 10, 60_000))) {
    return apiError("RATE_LIMITED", 429);
  }
  let input: unknown = {};
  try { input = await request.json(); } catch { return apiError("INVALID_JSON"); }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return apiError("VALIDATION_ERROR");
  try {
    const { supabase, project } = await requireProjectOwner(projectId);
    if (!project.client_email_verified_at) {
      return apiError("CLIENT_EMAIL_NOT_VERIFIED", 409);
    }
    const token = createReviewToken();
    const expiresAt = new Date(Date.now() + (parsed.data.expiresInDays ?? 14) * 86_400_000).toISOString();
    const { data: linkId, error: rpcError } = await supabase.rpc("create_project_review_link", {
      p_project_id: project.id,
      p_token_hash: hashReviewToken(token),
      p_expires_at: expiresAt,
    });
    if (rpcError || !linkId) {
      return apiError("REVIEW_LINK_CREATE_FAILED", 500);
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || new URL(request.url).origin;
    return NextResponse.json({ reviewUrl: `${appUrl}/review/${token}`, expiresAt });
  } catch { return apiError("FORBIDDEN", 403); }
}
