import { NextResponse } from "next/server";
import { milestoneInputSchema } from "@/features/agreements/schema";
import { requireProjectOwner } from "@/features/projects/authorization";
import { apiError } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  let body: unknown;
  try { body = await request.json(); } catch { return apiError("INVALID_JSON"); }
  const parsed = milestoneInputSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR");
  try {
    const { supabase, user, project } = await requireProjectOwner(projectId);
    if (parsed.data.currency !== project.currency) return apiError("CURRENCY_MISMATCH");
    const agreement = await supabase.from("agreements").select("current_version_id").eq("project_id", project.id).single();
    if (agreement.error || !agreement.data?.current_version_id) return apiError("AGREEMENT_DRAFT_REQUIRED", 409);
    const current = await supabase.from("agreement_versions").select("id, status").eq("id", agreement.data.current_version_id as string).single();
    if (current.error || !current.data || (current.data as { status: string }).status !== "DRAFT") return apiError("MILESTONE_VERSION_LOCKED", 409);
    const orderResult = await supabase.from("milestones").select("sort_order").eq("project_id", project.id).order("sort_order", { ascending: false }).limit(1);
    const nextOrder = ((orderResult.data?.[0] as { sort_order?: number } | undefined)?.sort_order ?? -1) + 1;
    const insert = await supabase.from("milestones").insert({ project_id: project.id, agreement_version_id: current.data.id as string, title: parsed.data.title, description: parsed.data.description, deliverables: parsed.data.deliverables, acceptance_criteria: parsed.data.acceptanceCriteria, amount_minor: parsed.data.amountMinor, currency: parsed.data.currency, due_date: parsed.data.dueDate, status: parsed.data.status, sort_order: nextOrder }).select("id").single();
    if (insert.error || !insert.data) return apiError("MILESTONE_CREATE_FAILED", 500);
    await supabase.from("activity_events").insert({ project_id: project.id, actor_user_id: user.id, actor_label: "Freelancer", event_type: "milestone.created", summary: `Created milestone ${parsed.data.title}` });
    return NextResponse.json({ data: insert.data }, { status: 201 });
  } catch { return apiError("FORBIDDEN", 403); }
}
