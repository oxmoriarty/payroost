import { NextResponse } from "next/server";
import { z } from "zod";
import { milestoneInputSchema } from "@/features/agreements/schema";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const uuidSchema = z.string().uuid();
const NO_STORE = { "Cache-Control": "no-store" } as const;

const freelancerMilestoneStatusSchema = z.object({
  status: z.enum(["IN_PROGRESS", "SUBMITTED"]),
  submissionNote: z.string().trim().max(2000).optional().default(""),
  deliverableUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .default("")
    .refine(
      (value) => value === "" || /^https?:\/\//i.test(value),
      "Deliverable URL must begin with http:// or https://",
    ),
});

async function authorizeOwnerMilestone(projectId: string, milestoneId: string) {
  if (!uuidSchema.safeParse(projectId).success || !uuidSchema.safeParse(milestoneId).success) {
    return { error: apiError("VALIDATION_ERROR", 400, NO_STORE) };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: apiError("UNAUTHORIZED", 401, NO_STORE) };
  }

  if (!(await allowRequest(`milestone-write:${user.id}:${projectId}`, 30, 60_000))) {
    return { error: apiError("RATE_LIMITED", 429, NO_STORE) };
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, owner_id, currency")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError) {
    return { error: apiError("DATABASE_ERROR", 500, NO_STORE) };
  }

  if (!project || (project as { owner_id: string }).owner_id !== user.id) {
    return { error: apiError("FORBIDDEN", 403, NO_STORE) };
  }

  const { data: milestone, error: milestoneError } = await supabase
    .from("milestones")
    .select("id, status, title")
    .eq("id", milestoneId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (milestoneError) {
    return { error: apiError("DATABASE_ERROR", 500, NO_STORE) };
  }

  if (!milestone) {
    return { error: apiError("NOT_FOUND", 404, NO_STORE) };
  }

  return {
    supabase,
    user,
    project: project as { id: string; owner_id: string; currency: string },
    milestone: milestone as { id: string; status: string; title: string },
  };
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string; milestoneId: string }> },
) {
  const { projectId, milestoneId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = milestoneInputSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
  }

  if (parsed.data.status === "ACCEPTED") {
    return NextResponse.json(
      {
        error: "CLIENT_ACCEPTANCE_REQUIRED",
        message: "Only the verified client can mark a milestone as ACCEPTED.",
      },
      { status: 403, headers: NO_STORE },
    );
  }

  try {
    const auth = await authorizeOwnerMilestone(projectId, milestoneId);
    if ("error" in auth && auth.error) return auth.error;
    const { supabase, user, project, milestone } = auth as Exclude<typeof auth, { error: NextResponse }>;

    if (parsed.data.currency !== project.currency) {
      return apiError("CURRENCY_MISMATCH", 400, NO_STORE);
    }

    if (!["DRAFT", "AWAITING_APPROVAL"].includes(milestone.status)) {
      return NextResponse.json(
        {
          error: "MILESTONE_LOCKED_AFTER_APPROVAL",
          message:
            "Agreed milestone amounts and terms cannot be edited directly after approval. Propose a new agreement revision or scope change request.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    const update = await supabase
      .from("milestones")
      .update({
        title: parsed.data.title,
        description: parsed.data.description,
        deliverables: parsed.data.deliverables,
        acceptance_criteria: parsed.data.acceptanceCriteria,
        amount_minor: parsed.data.amountMinor,
        currency: parsed.data.currency,
        due_date: parsed.data.dueDate,
        status: parsed.data.status,
      })
      .eq("id", milestoneId)
      .eq("project_id", project.id)
      .select("id")
      .single();

    if (update.error) {
      return apiError("MILESTONE_UPDATE_FAILED", 500, NO_STORE);
    }

    await supabase.from("activity_events").insert({
      project_id: project.id,
      actor_user_id: user.id,
      actor_label: "Freelancer",
      event_type: "milestone.updated",
      summary: `Updated milestone ${parsed.data.title}`,
    });

    return NextResponse.json({ data: update.data }, { headers: NO_STORE });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; milestoneId: string }> },
) {
  const { projectId, milestoneId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = freelancerMilestoneStatusSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid deliverable status update.",
      },
      { status: 400, headers: NO_STORE },
    );
  }

  if (parsed.data.status === "SUBMITTED" && parsed.data.submissionNote.trim().length < 3) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: "Please provide a short deliverable note (at least 3 characters) when submitting.",
      },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const auth = await authorizeOwnerMilestone(projectId, milestoneId);
    if ("error" in auth && auth.error) return auth.error;
    const { supabase, user, project, milestone } = auth as Exclude<typeof auth, { error: NextResponse }>;

    const targetStatus = parsed.data.status;
    const allowedFrom: Record<typeof targetStatus, string[]> = {
      IN_PROGRESS: ["APPROVED", "CHANGES_REQUESTED"],
      SUBMITTED: ["APPROVED", "IN_PROGRESS", "CHANGES_REQUESTED", "SUBMITTED"],
    };

    if (!allowedFrom[targetStatus].includes(milestone.status)) {
      return NextResponse.json(
        {
          error: "INVALID_MILESTONE_TRANSITION",
          message: `Cannot move milestone from ${milestone.status} to ${targetStatus}.`,
        },
        { status: 409, headers: NO_STORE },
      );
    }

    // Protect active payment state transitions if milestone is currently returning from CHANGES_REQUESTED
    if (milestone.status === "CHANGES_REQUESTED") {
      const { data: activeIntents } = await supabase
        .from("payment_intents")
        .select("id, status")
        .eq("milestone_id", milestoneId)
        .eq("project_id", project.id)
        .in("status", [
          "ORDER_CREATING",
          "ORDER_CREATED",
          "BUYER_APPROVED",
          "CAPTURING",
          "RECONCILING",
          "RECONCILIATION_REQUIRED",
        ]);

      if (activeIntents && activeIntents.length > 0) {
        return NextResponse.json(
          {
            error: "PAYMENT_OPERATION_IN_PROGRESS",
            message: "Cannot update milestone while a PayPal verification operation is active.",
          },
          { status: 409, headers: NO_STORE },
        );
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from("milestones")
      .update({ status: targetStatus })
      .eq("id", milestoneId)
      .eq("project_id", project.id)
      .select("id, status, updated_at")
      .single();

    if (updateError || !updated) {
      return apiError("MILESTONE_UPDATE_FAILED", 500, NO_STORE);
    }

    const submissionNote = parsed.data.submissionNote.trim() || null;
    const deliverableUrl = parsed.data.deliverableUrl.trim() || null;

    await supabase.from("activity_events").insert({
      project_id: project.id,
      actor_user_id: user.id,
      actor_label: "Freelancer",
      event_type: targetStatus === "SUBMITTED" ? "milestone.submitted" : "milestone.started",
      summary:
        targetStatus === "SUBMITTED"
          ? `Submitted deliverables for "${milestone.title}"`
          : `Started work on "${milestone.title}"`,
      metadata: {
        milestoneId: milestone.id,
        milestoneTitle: milestone.title,
        previousStatus: milestone.status,
        nextStatus: targetStatus,
        submissionNote,
        deliverableUrl,
      },
    });

    return NextResponse.json({ data: updated }, { headers: NO_STORE });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
