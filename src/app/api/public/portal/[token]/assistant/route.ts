import { NextResponse } from "next/server";
import { handleProjectAssistantRequest } from "@/features/assistant/handler";
import { portalAssistantRequestSchema } from "@/features/assistant/schema";
import { authenticatePortalRequest } from "@/features/scope-changes/portal-auth";
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
    rateLimitPrefix: "portal-assistant",
    limit: 15,
    windowMs: 300_000,
  });

  if (!portalAuth.ok) {
    return portalAuth.response;
  }

  let bodyRaw: unknown;
  try {
    const rawText = await request.text();
    if (!rawText || rawText.trim().length === 0) {
      return apiError("VALIDATION_ERROR", 400, NO_STORE);
    }
    bodyRaw = JSON.parse(rawText);
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = portalAssistantRequestSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid assistant request.",
        issues: parsed.error.issues,
      },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    return await handleProjectAssistantRequest({
      supabase: portalAuth.serviceClient,
      projectId: portalAuth.projectId,
      participantRole: "CLIENT",
      expectedClientEmail: portalAuth.clientEmail,
      question: parsed.data.question,
      history: parsed.data.history,
    });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
