import "server-only";

import type { User } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth/require-user";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type {
  ActivityEvent,
  Agreement,
  AgreementVersion,
  ChangeRequest,
  DashboardSummary,
  Milestone,
  Project,
  ProjectSummaryItem,
  WorkspaceNotification,
} from "@/features/projects/types";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

function throwQueryError(error: { message: string } | null) {
  if (error) throw new Error("Unable to load the requested project data.");
}

export async function getMyProjects() {
  if (!isSupabaseConfigured()) return [] as Project[];
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
  return {
    project: projectResult.data as Project,
    agreement,
    versions,
    milestones: (milestonesResult.data ?? []) as Milestone[],
    activities: (activityResult.data ?? []) as ActivityEvent[],
    changeRequests: (changesResult.data ?? []) as ChangeRequest[],
  };
}

export type MilestoneReadOnlyPaymentState = {
  paymentStatus: "UNPAID" | "IN_PROGRESS" | "PENDING_VERIFICATION" | "PAID";
  completedCaptureId: string | null;
};

/**
 * Read-only query of provider-confirmed payment intent states per milestone for workspace visibility.
 * Never mutates payment tables.
 */
export async function getProjectMilestonePaymentStates(
  projectId: string,
  milestoneIds: string[],
): Promise<Record<string, MilestoneReadOnlyPaymentState>> {
  const result: Record<string, MilestoneReadOnlyPaymentState> = {};
  if (!isSupabaseConfigured() || milestoneIds.length === 0) {
    return result;
  }

  const { supabase } = await requireUser();
  const { data: intents, error: intentsError } = await supabase
    .from("payment_intents")
    .select("id, milestone_id, status, created_at")
    .eq("project_id", projectId)
    .in("milestone_id", milestoneIds)
    .order("created_at", { ascending: false });

  if (intentsError || !intents) {
    return result;
  }

  const latestByMilestone = new Map<string, { id: string; status: string }>();
  const intentIds: string[] = [];
  for (const intent of intents as Array<{ id: string; milestone_id: string; status: string }>) {
    intentIds.push(intent.id);
    if (!latestByMilestone.has(intent.milestone_id)) {
      latestByMilestone.set(intent.milestone_id, { id: intent.id, status: intent.status });
    }
  }

  const completedCaptureByIntent = new Map<string, string>();
  if (intentIds.length > 0) {
    const { data: captures } = await supabase
      .from("payment_transactions")
      .select("payment_intent_id, provider_reference_id")
      .in("payment_intent_id", intentIds)
      .eq("status", "COMPLETED")
      .eq("transaction_type", "CAPTURE");

    for (const tx of (captures ?? []) as Array<{ payment_intent_id: string; provider_reference_id: string }>) {
      completedCaptureByIntent.set(tx.payment_intent_id, tx.provider_reference_id);
    }
  }

  const REUSABLE_ACTIVE = new Set(["ORDER_CREATING", "ORDER_CREATED", "BUYER_APPROVED"]);
  const IN_FLIGHT = new Set(["CAPTURING", "RECONCILING", "RECONCILIATION_REQUIRED"]);

  for (const milestoneId of milestoneIds) {
    const latest = latestByMilestone.get(milestoneId);
    const captureId = latest ? completedCaptureByIntent.get(latest.id) ?? null : null;
    if (latest?.status === "COMPLETED" || captureId) {
      result[milestoneId] = { paymentStatus: "PAID", completedCaptureId: captureId };
    } else if (latest && IN_FLIGHT.has(latest.status)) {
      result[milestoneId] = { paymentStatus: "PENDING_VERIFICATION", completedCaptureId: null };
    } else if (latest && REUSABLE_ACTIVE.has(latest.status)) {
      result[milestoneId] = { paymentStatus: "IN_PROGRESS", completedCaptureId: null };
    } else {
      result[milestoneId] = { paymentStatus: "UNPAID", completedCaptureId: null };
    }
  }

  return result;
}

type AggregatedWorkspaceRows = {
  projects: Project[];
  agreements: Agreement[];
  versions: AgreementVersion[];
  milestones: Array<{
    id: string;
    project_id: string;
    title: string;
    status: string;
    updated_at: string;
  }>;
  changeRequests: Array<{
    id: string;
    project_id: string;
    submitted_by_label: string;
    request_text: string;
    status: string;
    created_at: string;
  }>;
};

async function loadOwnerProjectAggregates(supabase: SupabaseServerClient): Promise<AggregatedWorkspaceRows> {
  const projectsResult = await supabase.from("projects").select("*").order("updated_at", { ascending: false });
  throwQueryError(projectsResult.error);
  const projects = (projectsResult.data ?? []) as Project[];

  if (projects.length === 0) {
    return { projects: [], agreements: [], versions: [], milestones: [], changeRequests: [] };
  }

  const projectIds = projects.map((p) => p.id);

  const [agreementsResult, milestonesResult, changesResult] = await Promise.all([
    supabase.from("agreements").select("*").in("project_id", projectIds),
    supabase.from("milestones").select("id, project_id, title, status, updated_at").in("project_id", projectIds),
    supabase
      .from("change_requests")
      .select("id, project_id, submitted_by_label, request_text, status, created_at")
      .in("project_id", projectIds),
  ]);
  [agreementsResult, milestonesResult, changesResult].forEach((r) => throwQueryError(r.error));

  const agreements = (agreementsResult.data ?? []) as Agreement[];
  const versionIds = agreements
    .map((a) => a.current_version_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  let versions: AgreementVersion[] = [];
  if (versionIds.length > 0) {
    const versionsResult = await supabase
      .from("agreement_versions")
      .select("id, agreement_id, version_number, status, updated_at")
      .in("id", versionIds);
    throwQueryError(versionsResult.error);
    versions = (versionsResult.data ?? []) as AgreementVersion[];
  }

  return {
    projects,
    agreements,
    versions,
    milestones: (milestonesResult.data ?? []) as AggregatedWorkspaceRows["milestones"],
    changeRequests: (changesResult.data ?? []) as AggregatedWorkspaceRows["changeRequests"],
  };
}

function buildSummariesAndNotifications(rows: AggregatedWorkspaceRows): {
  projectSummaries: ProjectSummaryItem[];
  notifications: WorkspaceNotification[];
} {
  const agreementByProject = new Map<string, Agreement>();
  for (const ag of rows.agreements) {
    agreementByProject.set(ag.project_id, ag);
  }
  const versionById = new Map<string, AgreementVersion>();
  for (const v of rows.versions) {
    versionById.set(v.id, v);
  }

  const notifications: WorkspaceNotification[] = [];

  const projectSummaries: ProjectSummaryItem[] = rows.projects.map((project) => {
    const agreement = agreementByProject.get(project.id);
    const currentVersion = agreement?.current_version_id ? versionById.get(agreement.current_version_id) : undefined;
    const agreementStatus = currentVersion?.status ?? agreement?.status ?? "DRAFT";
    const agreementVersionNumber = currentVersion?.version_number ?? null;

    const projectMilestones = rows.milestones.filter((m) => m.project_id === project.id);
    const projectChanges = rows.changeRequests.filter((cr) => cr.project_id === project.id);
    const openChanges = projectChanges.filter((cr) => cr.status === "OPEN");
    const submittedMilestones = projectMilestones.filter((m) => m.status === "SUBMITTED");
    const acceptedMilestones = projectMilestones.filter((m) => m.status === "ACCEPTED");
    const revisionMilestones = projectMilestones.filter((m) => m.status === "CHANGES_REQUESTED");

    if (agreementStatus === "CHANGES_REQUESTED") {
      notifications.push({
        id: `ag-changes-${project.id}`,
        projectId: project.id,
        projectTitle: project.title,
        kind: "AGREEMENT_CHANGES",
        title: "Agreement revision requested",
        description: `${project.client_name} requested changes on ${project.title}${agreementVersionNumber ? ` (v${agreementVersionNumber})` : ""}.`,
        href: `/app/projects/${project.id}#agreement`,
        tone: "warning",
        createdAt: currentVersion?.updated_at ?? project.updated_at,
      });
    }

    for (const m of revisionMilestones) {
      notifications.push({
        id: `ms-rev-${m.id}`,
        projectId: project.id,
        projectTitle: project.title,
        kind: "MILESTONE_REVISION",
        title: "Milestone deliverable needs revision",
        description: `"${m.title}" on ${project.title} was returned by ${project.client_name}.`,
        href: `/app/projects/${project.id}#milestones`,
        tone: "warning",
        createdAt: m.updated_at,
      });
    }

    for (const cr of openChanges) {
      notifications.push({
        id: `cr-open-${cr.id}`,
        projectId: project.id,
        projectTitle: project.title,
        kind: "SCOPE_OPEN",
        title: "Open scope-change request",
        description: `${cr.submitted_by_label} opened a request on ${project.title}.`,
        href: `/app/projects/${project.id}#scope-changes`,
        tone: "warning",
        createdAt: cr.created_at,
      });
    }

    if (!project.client_email_verified_at && project.status !== "CANCELLED") {
      notifications.push({
        id: `verify-${project.id}`,
        projectId: project.id,
        projectTitle: project.title,
        kind: "VERIFY_CLIENT",
        title: "Client email verification pending",
        description: `Waiting for ${project.client_name} to confirm ${project.client_email} on ${project.title}.`,
        href: `/app/projects/${project.id}`,
        tone: "info",
        createdAt: project.created_at,
      });
    }

    if (agreementStatus === "PENDING_CLIENT") {
      notifications.push({
        id: `ag-pending-${project.id}`,
        projectId: project.id,
        projectTitle: project.title,
        kind: "AGREEMENT_PENDING",
        title: "Agreement awaiting client review",
        description: `${project.title} v${agreementVersionNumber ?? 1} is out for OTP review with ${project.client_name}.`,
        href: `/app/projects/${project.id}#agreement`,
        tone: "info",
        createdAt: currentVersion?.updated_at ?? project.updated_at,
      });
    }

    for (const m of submittedMilestones) {
      notifications.push({
        id: `ms-sub-${m.id}`,
        projectId: project.id,
        projectTitle: project.title,
        kind: "MILESTONE_SUBMITTED",
        title: "Submitted milestone awaiting client acceptance",
        description: `"${m.title}" on ${project.title} is awaiting ${project.client_name}'s review.`,
        href: `/app/projects/${project.id}#milestones`,
        tone: "info",
        createdAt: m.updated_at,
      });
    }

    return {
      ...project,
      agreementStatus,
      agreementVersionNumber,
      milestoneCount: projectMilestones.length,
      acceptedMilestoneCount: acceptedMilestones.length,
      submittedMilestoneCount: submittedMilestones.length,
      revisionRequestedMilestoneCount: revisionMilestones.length,
      openChangeRequestCount: openChanges.length,
    };
  });

  notifications.sort((a, b) => {
    if (a.tone !== b.tone) return a.tone === "warning" ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return { projectSummaries, notifications };
}

export async function getMyProjectsWithSummary(): Promise<ProjectSummaryItem[]> {
  if (!isSupabaseConfigured()) return [];
  const { supabase } = await requireUser();
  const rows = await loadOwnerProjectAggregates(supabase);
  return buildSummariesAndNotifications(rows).projectSummaries;
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  if (!isSupabaseConfigured()) {
    return {
      isConfigured: false,
      metrics: {
        activeProjectsCount: 0,
        awaitingApprovalCount: 0,
        openActionItemsCount: 0,
        confirmedPaymentsCount: 0,
        completedProjectsCount: 0,
      },
      needsAttention: [],
      recentProjects: [],
      recentActivities: [],
    };
  }

  const { supabase } = await requireUser();
  const rows = await loadOwnerProjectAggregates(supabase);
  const { projectSummaries, notifications } = buildSummariesAndNotifications(rows);

  const projectIds = rows.projects.map((p) => p.id);
  const projectTitleById = new Map(rows.projects.map((p) => [p.id, p.title]));

  let confirmedPaymentsCount = 0;
  let recentActivities: Array<ActivityEvent & { projectTitle: string }> = [];

  if (projectIds.length > 0) {
    const [paymentsResult, activitiesResult] = await Promise.all([
      supabase
        .from("payment_intents")
        .select("id")
        .in("project_id", projectIds)
        .eq("status", "COMPLETED"),
      supabase
        .from("activity_events")
        .select("*")
        .in("project_id", projectIds)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    if (!paymentsResult.error && paymentsResult.data) {
      confirmedPaymentsCount = paymentsResult.data.length;
    }
    if (!activitiesResult.error && activitiesResult.data) {
      recentActivities = (activitiesResult.data as ActivityEvent[]).map((event) => ({
        ...event,
        projectTitle: projectTitleById.get(event.project_id) ?? "Project",
      }));
    }
  }

  const activeProjectsCount = projectSummaries.filter((p) => p.status === "ACTIVE").length;
  const awaitingApprovalCount = projectSummaries.filter(
    (p) => p.status === "AWAITING_CLIENT" || p.agreementStatus === "PENDING_CLIENT",
  ).length;
  const openActionItemsCount = notifications.filter((n) => n.tone === "warning").length;
  const completedProjectsCount = projectSummaries.filter((p) => p.status === "COMPLETED").length;

  return {
    isConfigured: true,
    metrics: {
      activeProjectsCount,
      awaitingApprovalCount,
      openActionItemsCount,
      confirmedPaymentsCount,
      completedProjectsCount,
    },
    needsAttention: notifications.slice(0, 6),
    recentProjects: projectSummaries.slice(0, 6),
    recentActivities,
  };
}

export async function getWorkspaceChromeData(supabase: SupabaseServerClient, user: User): Promise<{
  userLabel: string;
  userEmail: string | null;
  notifications: WorkspaceNotification[];
}> {
  let profileDisplayName: string | null = null;
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle();
    if (profile && typeof profile.display_name === "string" && profile.display_name.trim().length > 0) {
      profileDisplayName = profile.display_name.trim();
    }
  } catch {
    // Non-fatal fallback to auth metadata / email
  }

  let notifications: WorkspaceNotification[] = [];
  try {
    const rows = await loadOwnerProjectAggregates(supabase);
    notifications = buildSummariesAndNotifications(rows).notifications.slice(0, 15);
  } catch {
    notifications = [];
  }

  const metaDisplay =
    typeof user.user_metadata?.display_name === "string" && user.user_metadata.display_name.trim().length > 0
      ? user.user_metadata.display_name.trim()
      : null;

  const emailName = user.email ? user.email.split("@")[0] : null;
  const userLabel = profileDisplayName ?? metaDisplay ?? emailName ?? "Freelancer";

  return {
    userLabel,
    userEmail: user.email ?? null,
    notifications,
  };
}

export async function getMyProfile(): Promise<{
  isConfigured: boolean;
  email: string | null;
  displayName: string;
  countryCode: string;
}> {
  if (!isSupabaseConfigured()) {
    return { isConfigured: false, email: null, displayName: "", countryCode: "" };
  }
  const { supabase, user } = await requireUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, country_code")
    .eq("id", user.id)
    .maybeSingle();

  const metaDisplay =
    typeof user.user_metadata?.display_name === "string" ? user.user_metadata.display_name : "";

  return {
    isConfigured: true,
    email: user.email ?? null,
    displayName: (profile?.display_name as string | undefined) || metaDisplay || "",
    countryCode: (profile?.country_code as string | null | undefined) ?? "",
  };
}
