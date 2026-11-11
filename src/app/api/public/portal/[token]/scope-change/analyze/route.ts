import { NextResponse } from "next/server";
import { runScopeChangePreviewAnalysis } from "@/features/scope-changes/persistence";
import { authenticatePortalRequest } from "@/features/scope-changes/portal-auth";
import { portalAnalyzeScopeChangeRequestSchema } from "@/features/scope-changes/schema";
import { apiError } from "@/lib/http";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;

  const portalAuth = await authenticatePortalRequest({
    request,
    rawToken: token,
    rateLimitPrefix: "portal-scope-analyze",
    limit: 8,
    windowMs: 900_000,
  });

  if (!portalAuth.ok) {
    return portalAuth.response;
  }

  let bodyRaw: unknown;
  try {
    const bodyText = await request.text();
    if (!bodyText || bodyText.trim().length === 0) {
      return apiError("VALIDATION_ERROR", 400, NO_STORE);
    }
    bodyRaw = JSON.parse(bodyText);
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = portalAnalyzeScopeChangeRequestSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid scope-change analysis request.",
        issues: parsed.error.issues,
      },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    return await runScopeChangePreviewAnalysis({
      supabase: portalAuth.serviceClient,
      projectId: portalAuth.projectId,
      requestedAgreementVersionId: parsed.data.agreementVersionId,
      requestText: parsed.data.requestText,
      requesterRole: "CLIENT",
      userId: portalAuth.clientEmail,
    });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
