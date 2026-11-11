import { NextResponse } from "next/server";
import { z } from "zod";
import { updateChangeRequestStatusSchema } from "@/features/scope-changes/schema";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const uuidSchema = z.string().uuid();
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; changeRequestId: string }> }
) {
  const { projectId, changeRequestId } = await context.params;
  if (
    !uuidSchema.safeParse(projectId).success ||
    !uuidSchema.safeParse(changeRequestId).success
  ) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
  }

  let bodyRaw: unknown;
  try {
    bodyRaw = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = updateChangeRequestStatusSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid change request status update.",
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

    if (!(await allowRequest(`change-request-update:${user.id}:${projectId}`, 20, 60_000))) {
      return apiError("RATE_LIMITED", 429, NO_STORE);
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

    const { data: existing, error: fetchError } = await supabase
      .from("change_requests")
      .select("id, project_id, status")
      .eq("id", changeRequestId)
      .eq("project_id", projectId)
      .maybeSingle();

    if (fetchError) {
      return apiError("DATABASE_ERROR", 500, NO_STORE);
    }

    if (!existing) {
      return apiError("NOT_FOUND", 404, NO_STORE);
    }

    if ((existing as { status: string }).status !== "OPEN") {
      return NextResponse.json(
        {
          error: "CHANGE_REQUEST_NOT_OPEN",
          message: "Only OPEN change requests can be marked resolved or withdrawn.",
        },
        { status: 409, headers: NO_STORE }
      );
    }

    const resolvedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("change_requests")
      .update({
        status: parsed.data.status,
        resolved_at: resolvedAt,
      })
      .eq("id", changeRequestId)
      .eq("project_id", projectId)
      .select(
        "id, project_id, agreement_version_id, request_text, submitted_by_label, status, created_at, resolved_at, ai_analysis, ai_analyzed_at, ai_model"
      )
      .single();

    if (updateError || !updated) {
      return apiError("CHANGE_REQUEST_UPDATE_FAILED", 500, NO_STORE);
    }

    const eventType =
      parsed.data.status === "RESOLVED"
        ? "change_request.resolved"
        : "change_request.withdrawn";

    await supabase.from("activity_events").insert({
      project_id: projectId,
      actor_user_id: user.id,
      actor_label: user.email ? `Freelancer (${user.email})` : "Freelancer",
      event_type: eventType,
      summary:
        parsed.data.status === "RESOLVED"
          ? "Marked change request as resolved (agreement revision remains explicit)"
          : "Marked change request as withdrawn",
      metadata: {
        changeRequestId,
        previousStatus: "OPEN",
        newStatus: parsed.data.status,
      },
    });

    return NextResponse.json(
      {
        data: {
          changeRequest: updated,
          agreementChanged: false,
          milestonesChanged: false,
          paymentsChanged: false,
        },
      },
      { status: 200, headers: NO_STORE }
    );
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
