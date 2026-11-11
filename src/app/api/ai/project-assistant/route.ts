import { NextResponse } from "next/server";
import { handleProjectAssistantRequest } from "@/features/assistant/handler";
import { freelancerAssistantRequestSchema } from "@/features/assistant/schema";
import { apiError } from "@/lib/http";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
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

  const parsed = freelancerAssistantRequestSchema.safeParse(bodyRaw);
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
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401, NO_STORE);
    }

    const rateLimit = await checkRateLimit(`ai:assistant:owner:${user.id}`, 15, 60_000, {
      failClosedInProduction: true,
    });

    if (!rateLimit.allowed) {
      if (rateLimit.status === "service_unavailable") {
        return apiError("RATE_LIMITER_UNAVAILABLE", 503, NO_STORE);
      }
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }

    return await handleProjectAssistantRequest({
      supabase,
      projectId: parsed.data.projectId,
      participantRole: "OWNER",
      expectedOwnerId: user.id,
      question: parsed.data.question,
      history: parsed.data.history,
      userId: user.id,
    });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
