import "server-only";

import { requireUser } from "@/lib/auth/require-user";
import type { ActivityEvent, Agreement, AgreementVersion, ChangeRequest, Milestone, Project } from "@/features/projects/types";

function throwQueryError(error: { message: string } | null) { if (error) throw new Error("Unable to load the requested project data."); }

export async function getMyProjects() {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("projects").select("*").order("updated_at", { ascending: false });
  throwQueryError(error);
  return (data ?? []) as Project[];
}

export async function getProjectWorkspace(projectId: string) {
  const { supabase } = await requireUser();
  const projectResult = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  throwQueryError(projectResult.error);
  if (!projectResult.data) return null;

  const agreementResult = await supabase.from("agreements").select("*").eq("project_id", projectId).maybeSingle();
  throwQueryError(agreementResult.error);
  const agreement = agreementResult.data as Agreement | null;

  const [versionsResult, milestonesResult, activityResult, changesResult] = await Promise.all([
    agreement?.id
      ? supabase.from("agreement_versions").select("*").eq("agreement_id", agreement.id).order("version_number", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    supabase.from("milestones").select("*").eq("project_id", projectId).order("sort_order"),
    supabase.from("activity_events").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(30),
    supabase.from("change_requests").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
  ]);
  [versionsResult, milestonesResult, activityResult, changesResult].forEach((result) => throwQueryError(result.error));

  const versions = (versionsResult.data ?? []) as AgreementVersion[];
  return { project: projectResult.data as Project, agreement, versions, milestones: (milestonesResult.data ?? []) as Milestone[], activities: (activityResult.data ?? []) as ActivityEvent[], changeRequests: (changesResult.data ?? []) as ChangeRequest[] };
}
