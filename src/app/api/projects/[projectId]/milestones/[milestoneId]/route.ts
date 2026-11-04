import { NextResponse } from "next/server";
import { milestoneInputSchema } from "@/features/agreements/schema";
import { requireProjectOwner } from "@/features/projects/authorization";
import { apiError } from "@/lib/http";

export async function PUT(request: Request, context: { params: Promise<{ projectId: string; milestoneId: string }> }) {
  const { projectId, milestoneId } = await context.params;
  let body: unknown;
  try { body = await request.json(); } catch { return apiError("INVALID_JSON"); }
  const parsed = milestoneInputSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR");
  try {
    const { supabase, user, project } = await requireProjectOwner(projectId);
    if (parsed.data.currency !== project.currency) return apiError("CURRENCY_MISMATCH");
    const milestone = await supabase.from("milestones").select("id, status, title").eq("id", milestoneId).eq("project_id", project.id).maybeSingle();
    if (milestone.error || !milestone.data) return apiError("NOT_FOUND", 404);
    if (["ACCEPTED", "CANCELLED"].includes((milestone.data as { status: string }).status)) return apiError("MILESTONE_IMMUTABLE", 409);
    const update = await supabase.from("milestones").update({ title: parsed.data.title, description: parsed.data.description, deliverables: parsed.data.deliverables, acceptance_criteria: parsed.data.acceptanceCriteria, amount_minor: parsed.data.amountMinor, currency: parsed.data.currency, due_date: parsed.data.dueDate, status: parsed.data.status }).eq("id", milestoneId).select("id").single();
    if (update.error) return apiError("MILESTONE_UPDATE_FAILED", 500);
    await supabase.from("activity_events").insert({ project_id: project.id, actor_user_id: user.id, actor_label: "Freelancer", event_type: "milestone.updated", summary: `Updated milestone ${parsed.data.title}` });
    return NextResponse.json({ data: update.data });
  } catch { return apiError("FORBIDDEN", 403); }
}
