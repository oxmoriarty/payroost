import { NextResponse } from "next/server";
import { z } from "zod";
import { agreementVersionUpdateSchema } from "@/features/agreements/schema";
import { agreementContentHash, manualAgreementDraft } from "@/features/agreements/versioning";
import { createClient } from "@/lib/supabase/server";
import { syncNotificationsFromActivityEvents } from "@/features/notifications/service";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";

export type DraftSource = "MANUAL" | "AI_ASSISTED";

const uuidSchema = z.string().uuid();

export async function saveAgreementDraft(
  projectId: string,
  content: unknown,
  options?: { source?: DraftSource }
) {
  if (!uuidSchema.safeParse(projectId).success) {
    return { error: apiError("VALIDATION_ERROR", 400) };
  }

  const parsed = agreementVersionUpdateSchema.safeParse({ content });
  if (!parsed.success) {
    return { error: apiError("VALIDATION_ERROR", 400) };
  }

  const source: DraftSource = options?.source === "AI_ASSISTED" ? "AI_ASSISTED" : "MANUAL";

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { error: apiError("UNAUTHORIZED", 401) };
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, owner_id, title, client_name, brief, currency, total_amount_minor, target_end_date")
      .eq("id", projectId)
      .maybeSingle();

    if (projectError) {
      return { error: apiError("DATABASE_ERROR", 500) };
    }

    if (!project || (project as { owner_id: string }).owner_id !== user.id) {
      return { error: apiError("FORBIDDEN", 403) };
    }

    const agreementResult = await supabase
      .from("agreements")
      .select("id, current_version_id")
      .eq("project_id", project.id)
      .single();

    if (agreementResult.error || !agreementResult.data) {
      return { error: apiError("NOT_FOUND", 404) };
    }

    const agreement = agreementResult.data as { id: string; current_version_id: string | null };

    if (agreement.current_version_id) {
      const current = await supabase
        .from("agreement_versions")
        .select("id, status")
        .eq("id", agreement.current_version_id)
        .single();

      if (current.error) {
        return { error: apiError("DATABASE_ERROR", 500) };
      }

      if (current.data && (current.data as { status: string }).status === "DRAFT") {
        const update = await supabase
          .from("agreement_versions")
          .update({
            content: parsed.data.content,
            content_hash: agreementContentHash(parsed.data.content),
          })
          .eq("id", agreement.current_version_id)
          .select("id, version_number")
          .single();

        if (update.error) {
          return { error: apiError("SAVE_FAILED", 500) };
        }

        await supabase.from("activity_events").insert({
          project_id: project.id,
          actor_user_id: user.id,
          actor_label: "Freelancer",
          event_type: "agreement.edited",
          summary:
            source === "AI_ASSISTED"
              ? "Saved AI-assisted agreement draft"
              : "Edited agreement draft",
          metadata: { source },
        });

        return { data: update.data };
      }
    }

    // Current version is missing or immutable (SENT / APPROVED / CHANGES_REQUESTED): create new DRAFT version
    const previous = await supabase
      .from("agreement_versions")
      .select("version_number")
      .eq("agreement_id", agreement.id)
      .order("version_number", { ascending: false })
      .limit(1);

    if (previous.error) {
      return { error: apiError("DATABASE_ERROR", 500) };
    }

    const nextNumber =
      ((previous.data?.[0] as { version_number?: number } | undefined)?.version_number ?? 0) + 1;

    const insert = await supabase
      .from("agreement_versions")
      .insert({
        agreement_id: agreement.id,
        version_number: nextNumber,
        content: parsed.data.content,
        content_hash: agreementContentHash(parsed.data.content),
        created_by: user.id,
      })
      .select("id, version_number")
      .single();

    if (insert.error || !insert.data) {
      return { error: apiError("VERSION_CREATE_FAILED", 409) };
    }

    const setCurrent = await supabase
      .from("agreements")
      .update({
        current_version_id: (insert.data as { id: string }).id,
        status: "DRAFT",
      })
      .eq("id", agreement.id);

    if (setCurrent.error) {
      return { error: apiError("SAVE_FAILED", 500) };
    }

    const createdVersion = insert.data as { id: string; version_number: number };
    await supabase.from("activity_events").insert({
      project_id: project.id,
      actor_user_id: user.id,
      actor_label: "Freelancer",
      event_type: "agreement.version_created",
      summary:
        source === "AI_ASSISTED"
          ? `Created AI-assisted agreement version ${nextNumber}`
          : `Created agreement version ${nextNumber}`,
      metadata: {
        source,
        agreementVersionId: createdVersion.id,
        versionNumber: nextNumber,
        isRevision: nextNumber > 1,
      },
    });

    if (nextNumber > 1) {
      try {
        const { data: priorOpenRequests } = await supabase
          .from("change_requests")
          .select("id, agreement_version_id")
          .eq("project_id", project.id)
          .eq("status", "OPEN")
          .not("ai_analysis", "is", null)
          .neq("agreement_version_id", createdVersion.id);

        const openRequests = (priorOpenRequests ?? []) as Array<{
          id: string;
          agreement_version_id: string;
        }>;
        for (const reqRow of openRequests) {
          await supabase.from("activity_events").insert({
            project_id: project.id,
            actor_user_id: user.id,
            actor_label: "System",
            event_type: "change_request.analysis_stale",
            summary: `Earlier AI scope-change analysis predates agreement v${nextNumber} draft`,
            metadata: {
              changeRequestId: reqRow.id,
              previousAgreementVersionId: reqRow.agreement_version_id,
              agreementVersionId: createdVersion.id,
              versionNumber: nextNumber,
              stale: true,
            },
          });
        }
      } catch {
        // Non-fatal if change_requests check unavailable
      }
    }

    try {
      await syncNotificationsFromActivityEvents({ projectId: project.id, limit: 15 });
    } catch {
      // Non-fatal catch-up sync
    }

    return { data: insert.data };
  } catch {
    return { error: apiError("INTERNAL_ERROR", 500) };
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  if (!uuidSchema.safeParse(projectId).success) {
    return apiError("VALIDATION_ERROR", 400);
  }

  if (!(await allowRequest(`agreement-save:${projectId}`, 30, 60_000))) {
    return apiError("RATE_LIMITED", 429);
  }

  let body: { content?: unknown; action?: string; source?: string };
  try {
    body = (await request.json()) as { content?: unknown; action?: string; source?: string };
  } catch {
    return apiError("INVALID_JSON", 400);
  }

  if (body.action === "CREATE_MANUAL") {
    try {
      const supabase = await createClient();
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        return apiError("UNAUTHORIZED", 401);
      }

      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, owner_id, title, client_name, brief, currency, total_amount_minor, target_end_date")
        .eq("id", projectId)
        .maybeSingle();

      if (projectError) {
        return apiError("DATABASE_ERROR", 500);
      }

      if (!project || (project as { owner_id: string }).owner_id !== user.id) {
        return apiError("FORBIDDEN", 403);
      }

      const typedProject = project as {
        id: string;
        title: string;
        client_name: string;
        brief: string;
        currency: string;
        total_amount_minor: number;
        target_end_date: string | null;
      };

      return await respond(
        saveAgreementDraft(
          projectId,
          manualAgreementDraft({
            title: typedProject.title,
            brief: typedProject.brief,
            clientName: typedProject.client_name,
            currency: typedProject.currency,
            totalAmountMinor: typedProject.total_amount_minor,
            endDate: typedProject.target_end_date,
          }),
          { source: "MANUAL" }
        )
      );
    } catch {
      return apiError("INTERNAL_ERROR", 500);
    }
  }

  const source: DraftSource = body.source === "AI_ASSISTED" ? "AI_ASSISTED" : "MANUAL";
  return respond(saveAgreementDraft(projectId, body.content, { source }));
}

async function respond(resultPromise: Promise<{ data?: unknown; error?: NextResponse }>) {
  const result = await resultPromise;
  return result.error ?? NextResponse.json({ data: result.data });
}
