import { NextResponse } from "next/server";
import { agreementVersionUpdateSchema } from "@/features/agreements/schema";
import { agreementContentHash, manualAgreementDraft } from "@/features/agreements/versioning";
import { requireProjectOwner } from "@/features/projects/authorization";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";

export async function saveAgreementDraft(projectId: string, content: unknown) {
  const parsed = agreementVersionUpdateSchema.safeParse({ content });
  if (!parsed.success) return { error: apiError("VALIDATION_ERROR") };
  try {
    const { supabase, user, project } = await requireProjectOwner(projectId);
    const agreementResult = await supabase.from("agreements").select("id, current_version_id").eq("project_id", project.id).single();
    if (agreementResult.error || !agreementResult.data) return { error: apiError("NOT_FOUND", 404) };
    const agreement = agreementResult.data as { id: string; current_version_id: string | null };
    if (agreement.current_version_id) {
      const current = await supabase.from("agreement_versions").select("id, status").eq("id", agreement.current_version_id).single();
      if (!current.error && current.data && (current.data as { status: string }).status === "DRAFT") {
        const update = await supabase.from("agreement_versions").update({ content: parsed.data.content, content_hash: agreementContentHash(parsed.data.content) }).eq("id", agreement.current_version_id).select("id, version_number").single();
        if (update.error) return { error: apiError("SAVE_FAILED", 500) };
        await supabase.from("activity_events").insert({ project_id: project.id, actor_user_id: user.id, actor_label: "Freelancer", event_type: "agreement.edited", summary: "Edited agreement draft" });
        return { data: update.data };
      }
    }
    const previous = await supabase.from("agreement_versions").select("version_number").eq("agreement_id", agreement.id).order("version_number", { ascending: false }).limit(1);
    const nextNumber = ((previous.data?.[0] as { version_number?: number } | undefined)?.version_number ?? 0) + 1;
    const insert = await supabase.from("agreement_versions").insert({ agreement_id: agreement.id, version_number: nextNumber, content: parsed.data.content, content_hash: agreementContentHash(parsed.data.content), created_by: user.id }).select("id, version_number").single();
    if (insert.error || !insert.data) return { error: apiError("VERSION_CREATE_FAILED", 409) };
    const setCurrent = await supabase.from("agreements").update({ current_version_id: (insert.data as { id: string }).id, status: "DRAFT" }).eq("id", agreement.id);
    if (setCurrent.error) return { error: apiError("SAVE_FAILED", 500) };
    await supabase.from("activity_events").insert({ project_id: project.id, actor_user_id: user.id, actor_label: "Freelancer", event_type: "agreement.version_created", summary: `Created agreement version ${nextNumber}` });
    return { data: insert.data };
  } catch { return { error: apiError("FORBIDDEN", 403) }; }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  if (!(await allowRequest(`agreement-save:${projectId}`, 30, 60_000))) {
    return apiError("RATE_LIMITED", 429);
  }
  let body: { content?: unknown; action?: string };
  try { body = await request.json() as { content?: unknown; action?: string }; } catch { return apiError("INVALID_JSON"); }
  if (body.action === "CREATE_MANUAL") {
    try {
      const { project } = await requireProjectOwner(projectId);
      return await respond(saveAgreementDraft(projectId, manualAgreementDraft({ title: project.title, brief: project.brief, clientName: project.client_name, currency: project.currency, totalAmountMinor: project.total_amount_minor, endDate: project.target_end_date })));
    } catch { return apiError("FORBIDDEN", 403); }
  }
  return respond(saveAgreementDraft(projectId, body.content));
}

async function respond(resultPromise: Promise<{ data?: unknown; error?: NextResponse }>) {
  const result = await resultPromise;
  return result.error ?? NextResponse.json({ data: result.data });
}
