import { NextResponse } from "next/server";
import { z } from "zod";
import { submitValidatedChangeRequest } from "@/features/scope-changes/persistence";
import { submitChangeRequestPayloadSchema } from "@/features/scope-changes/schema";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const uuidSchema = z.string().uuid();
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  if (!uuidSchema.safeParse(projectId).success) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
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

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, owner_id")
      .eq("id", projectId)
      .maybeSingle();

    if (projectError) {
      return apiError("DATABASE_ERROR", 500, NO_STORE);
    }

    if (!project || (project as { owner_id: string }).owner_id !== user.id) {
      return apiError("FORBIDDEN", 403, NO_STORE);
    }

    const { data: rows, error: listError } = await supabase
      .from("change_requests")
      .select(
        "id, project_id, agreement_version_id, request_text, submitted_by_label, status, created_at, resolved_at, ai_analysis, ai_analyzed_at, ai_model"
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });

    if (listError) {
      return apiError("DATABASE_ERROR", 500, NO_STORE);
    }

    return NextResponse.json({ data: { changeRequests: rows ?? [] } }, { headers: NO_STORE });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  if (!uuidSchema.safeParse(projectId).success) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
  }

  let bodyRaw: unknown;
  try {
    bodyRaw = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = submitChangeRequestPayloadSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid change request submission payload.",
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

    if (!(await allowRequest(`change-request-create:${user.id}:${projectId}`, 15, 60_000))) {
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }

    const submittedByLabel = user.email ? `Freelancer (${user.email})` : "Freelancer";

    return await submitValidatedChangeRequest({
      supabase,
      projectId,
      expectedOwnerId: user.id,
      requestedAgreementVersionId: parsed.data.agreementVersionId,
      requestText: parsed.data.requestText,
      rawAiAnalysis: parsed.data.aiAnalysis,
      expectedRole: "OWNER",
      submittedByLabel,
      actorUserId: user.id,
    });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
