import { NextResponse } from "next/server";
import { runScopeChangePreviewAnalysis } from "@/features/scope-changes/persistence";
import { analyzeScopeChangeRequestSchema } from "@/features/scope-changes/schema";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  let bodyRaw: unknown;
  try {
    bodyRaw = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = analyzeScopeChangeRequestSchema.safeParse(bodyRaw);
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
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401, NO_STORE);
    }

    if (!(await allowRequest(`ai:scope-change:${user.id}`, 8, 60_000))) {
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }

    return await runScopeChangePreviewAnalysis({
      supabase,
      projectId: parsed.data.projectId,
      expectedOwnerId: user.id,
      requestedAgreementVersionId: parsed.data.agreementVersionId,
      requestText: parsed.data.requestText,
      requesterRole: "OWNER",
      userId: user.id,
    });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
