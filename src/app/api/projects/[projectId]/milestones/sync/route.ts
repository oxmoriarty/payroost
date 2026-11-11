import { NextResponse } from "next/server";
import { z } from "zod";
import { syncApprovedAgreementMilestones } from "@/features/milestones/sync";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const uuidSchema = z.string().uuid();
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
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

    if (!(await allowRequest(`milestone-sync:${user.id}:${projectId}`, 15, 60_000))) {
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

    const result = await syncApprovedAgreementMilestones({
      supabase,
      projectId,
      actorUserId: user.id,
      actorLabel: "Freelancer",
    });

    return NextResponse.json({ data: result }, { headers: NO_STORE });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
