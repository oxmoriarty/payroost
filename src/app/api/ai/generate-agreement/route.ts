import { NextResponse } from "next/server";
import { generateAgreementDraft, GeminiOutputError, GeminiUnavailableError } from "@/features/agreements/gemini";
import { requireProjectOwner } from "@/features/projects/authorization";
import { saveAgreementDraft } from "@/app/api/projects/[projectId]/agreement/route";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";

export async function POST(request: Request) {
  let body: { projectId?: string };
  try { body = await request.json() as { projectId?: string }; } catch { return apiError("INVALID_JSON"); }
  if (!body.projectId) return apiError("VALIDATION_ERROR");
  try {
    const { project, user } = await requireProjectOwner(body.projectId);
    if (!(await allowRequest(`ai:${user.id}`, 5, 60_000))) return apiError("RATE_LIMITED", 429);
    const draft = await generateAgreementDraft({ title: project.title, brief: project.brief, clientLabel: project.client_name, freelancerLabel: "Freelancer", currency: project.currency, totalAmountMinor: project.total_amount_minor, startDate: null, endDate: project.target_end_date });
    const saved = await saveAgreementDraft(project.id, draft);
    if (saved.error) return saved.error;
    return NextResponse.json({ data: saved.data });
  } catch (error) {
    if (error instanceof GeminiUnavailableError) return apiError("AI_UNAVAILABLE", 503);
    if (error instanceof GeminiOutputError) return apiError("AI_OUTPUT_INVALID", 422);
    return apiError("FORBIDDEN", 403);
  }
}
