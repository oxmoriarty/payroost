import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, AlertTriangle, Calendar, CheckCircle2, ShieldCheck } from "lucide-react";
import {
  getProjectMilestonePaymentStates,
  getProjectWorkspace,
} from "@/features/projects/data";
import { AgreementEditor } from "@/features/agreements/agreement-editor";
import { agreementDraftSchema } from "@/features/agreements/schema";
import { extractMilestoneNotes } from "@/features/milestones/activity-notes";
import { MilestonePlanner } from "@/features/milestones/milestone-planner";
import { MilestoneWorkspacePanel } from "@/features/milestones/milestone-workspace-panel";
import { syncApprovedAgreementMilestones } from "@/features/milestones/sync";
import { ScopeChangePanel } from "@/features/scope-changes/scope-change-panel";
import { ProjectAssistantPanel } from "@/features/assistant/project-assistant-panel";
import { mapActivityEventsToHistoryItems } from "@/features/history/mapper";
import { ProjectHistoryPanel } from "@/features/history/project-history-panel";
import { getProjectHistory } from "@/features/history/service";
import type { ProjectHistoryPageResult } from "@/features/history/types";
import { syncNotificationsFromActivityEvents } from "@/features/notifications/service";
import { PortalInviteCard } from "@/features/projects/portal-invite-card";
import { ResendVerificationButton } from "@/features/projects/resend-verification-button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await contextParams(params);
  let workspace = await getProjectWorkspace(projectId);

  if (!workspace) {
    notFound();
  }

  // Catch-up idempotent sync if agreement is approved while milestones remain DRAFT or empty
  const hasApprovedVersion = workspace.versions.some((v) => v.status === "APPROVED");
  const needsMilestoneSync =
    hasApprovedVersion &&
    (workspace.milestones.length === 0 || workspace.milestones.some((m) => m.status === "DRAFT"));

  if (needsMilestoneSync) {
    try {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const syncResult = await syncApprovedAgreementMilestones({
        supabase,
        projectId: workspace.project.id,
        actorUserId: user?.id ?? null,
        actorLabel: "System catch-up",
      });
      if (syncResult.promotedCount > 0 || syncResult.insertedCount > 0) {
        const refreshed = await getProjectWorkspace(projectId);
        if (refreshed) workspace = refreshed;
      }
    } catch {
      // Non-fatal: manual sync control remains available in UI
    }
  }

  const { project, agreement, versions, milestones, activities, changeRequests } = workspace;
  const supabaseForHistory = await createClient();
  const [paymentStates, initialHistoryResult] = await Promise.all([
    getProjectMilestonePaymentStates(
      project.id,
      milestones.map((m) => m.id),
    ),
    getProjectHistory({
      projectId: project.id,
      page: 1,
      pageSize: 20,
      supabaseClient: supabaseForHistory,
    }).catch(() => null),
    syncNotificationsFromActivityEvents({
      projectId: project.id,
      limit: 50,
    }).catch(() => undefined),
  ]);
  const fallbackHistoryItems = mapActivityEventsToHistoryItems(activities, "freelancer");
  const initialHistory: ProjectHistoryPageResult = initialHistoryResult ?? {
    items: fallbackHistoryItems.slice(0, 20),
    totalCount: fallbackHistoryItems.length,
    page: 1,
    pageSize: 20,
    hasMore: fallbackHistoryItems.length > 20,
  };
  const milestoneNotes = extractMilestoneNotes(activities);

  const isClientVerified = Boolean(project.client_email_verified_at);
  const canUseAi = Boolean(process.env.GEMINI_API_KEY);
  const currentVersion =
    versions.find((v) => v.id === agreement?.current_version_id) ?? versions[0] ?? null;
  const approvedVersion = versions.find((v) => v.status === "APPROVED") ?? null;
  const draftVersion = versions.find((v) => v.status === "DRAFT") ?? null;
  const scopeBaselineVersion = approvedVersion ?? currentVersion;
  const parsedApproved = approvedVersion
    ? agreementDraftSchema.safeParse(approvedVersion.content)
    : null;
  const parsedDraft = draftVersion
    ? agreementDraftSchema.safeParse(draftVersion.content)
    : null;
  const agreementEditorKey = `${agreement?.current_version_id ?? "none"}-${versions[0]?.updated_at ?? "none"}-${milestones.length}`;

  const workflowSteps = [
    {
      label: "Client verified",
      done: isClientVerified,
    },
    {
      label: "Agreement drafted",
      done: versions.length > 0,
    },
    {
      label: "Agreement approved",
      done: Boolean(approvedVersion),
    },
    {
      label: "Deliverables accepted",
      done: milestones.length > 0 && milestones.every((m) => m.status === "ACCEPTED"),
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <Link
          className="inline-flex items-center text-sm font-bold text-teal-700 hover:text-teal-600"
          href="/app/projects"
        >
          <ArrowLeft className="mr-2" size={16} /> Projects
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Project workspace</p>
            <h1 className="mt-1 font-display text-3xl sm:text-4xl text-ink-950">{project.title}</h1>
            <p className="mt-1 text-sm text-ink-700">
              {project.client_name} · {formatMoney(project.total_amount_minor, project.currency)}
            </p>
          </div>
          <Badge tone={project.status === "ACTIVE" ? "success" : project.status === "AWAITING_CLIENT" ? "warning" : "neutral"}>
            {project.status.replaceAll("_", " ")}
          </Badge>
        </div>
      </div>

      {/* Client Email Verification Status Banner */}
      <Card className={`p-5 sm:p-6 border-l-4 ${isClientVerified ? "border-l-teal-600 bg-teal-50/40" : "border-l-amber-500 bg-amber-50/50"}`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            {isClientVerified ? (
              <ShieldCheck className="h-6 w-6 text-teal-700 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
            )}
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display text-lg text-ink-950">
                  {isClientVerified ? "Client Identity Verified" : "Client Verification Pending"}
                </h3>
                <Badge tone={isClientVerified ? "success" : "warning"}>
                  {isClientVerified ? "Verified" : "Action Required"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-ink-700">
                {isClientVerified ? (
                  <>
                    The client email <strong>{project.client_email}</strong> was independently verified. Agreement decisions will require one-time security codes dispatched to this address.
                  </>
                ) : (
                  <>
                    A verification link was sent to <strong>{project.client_email}</strong>. The client must verify their email address before you can submit agreements for review.
                  </>
                )}
              </p>
            </div>
          </div>
          {!isClientVerified && (
            <div className="shrink-0">
              <ResendVerificationButton projectId={project.id} />
            </div>
          )}
        </div>
      </Card>

      {/* Project Workflow Progress & Brief Summary */}
      <Card className="p-5 sm:p-6 space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {workflowSteps.map((step, idx) => (
            <div
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                step.done
                  ? "border-emerald-200 bg-emerald-50/70 text-emerald-900"
                  : "border-ink-100 bg-ink-50/60 text-ink-600"
              }`}
              key={step.label}
            >
              {step.done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
              ) : (
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ink-300 text-[10px]">
                  {idx + 1}
                </span>
              )}
              <span>{step.label}</span>
            </div>
          ))}
        </div>

        <div className="border-t border-ink-100 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-600">
            <span className="font-bold uppercase tracking-wider text-ink-700">Project Brief</span>
            {(project.start_date || project.target_end_date) && (
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {project.start_date ? `Start ${new Date(project.start_date).toLocaleDateString()}` : "Flexible start"}
                {" · "}
                {project.target_end_date
                  ? `Target ${new Date(project.target_end_date).toLocaleDateString()}`
                  : "No target date"}
              </span>
            )}
          </div>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-800">
            {project.brief}
          </p>
        </div>
      </Card>

      {/* Client Workspace Portal Invite (verified client access) */}
      <PortalInviteCard
        agreementApproved={Boolean(approvedVersion)}
        clientEmail={project.client_email}
        clientName={project.client_name}
        isClientVerified={isClientVerified}
        projectId={project.id}
      />

      {/* Active Milestone Execution & Deliverable Submissions */}
      <div id="milestones">
        <MilestoneWorkspacePanel
          agreementApproved={Boolean(approvedVersion)}
          initialNotes={milestoneNotes}
          milestones={milestones}
          paymentStates={paymentStates}
          projectId={project.id}
        />
      </div>

      {/* Standalone Milestone Planner (AI-4) */}
      <MilestonePlanner
        projectId={project.id}
        projectCurrency={project.currency}
        confirmedBudgetMinor={project.total_amount_minor}
        agreementStatus={currentVersion?.status ?? agreement?.status ?? null}
        currentVersionNumber={currentVersion?.version_number ?? null}
        savedMilestones={milestones}
        agreedVersionMilestones={
          parsedApproved?.success ? parsedApproved.data.milestones : []
        }
        draftVersionMilestones={
          parsedDraft?.success ? parsedDraft.data.milestones : []
        }
        canUseAi={canUseAi}
      />

      {/* Agreement Editor with Verification Guard */}
      <div id="agreement">
        <AgreementEditor
          key={agreementEditorKey}
          projectId={project.id}
          versions={versions}
          canUseAi={canUseAi}
          isClientVerified={isClientVerified}
          clientEmail={project.client_email}
        />
      </div>

      {/* Intelligent Scope-Change Analysis & Change Requests (AI-5) */}
      <div id="scope-changes">
        <ScopeChangePanel
          mode="freelancer"
          projectId={project.id}
          projectCurrency={project.currency}
          confirmedBudgetMinor={project.total_amount_minor}
          agreementVersionId={scopeBaselineVersion?.id ?? null}
          agreementVersionNumber={scopeBaselineVersion?.version_number ?? null}
          agreementStatus={scopeBaselineVersion?.status ?? agreement?.status ?? null}
          canUseAi={canUseAi}
          initialChangeRequests={changeRequests}
        />
      </div>

      {/* Context-Aware Read-Only Project Assistant (AI-6) */}
      <ProjectAssistantPanel
        mode="freelancer"
        projectId={project.id}
        projectTitle={project.title}
        canUseAi={canUseAi}
      />

      {/* Chronological Project History */}
      <ProjectHistoryPanel
        initialHistory={initialHistory}
        mode="freelancer"
        projectId={project.id}
      />
    </div>
  );
}

// Helper for Next.js 15+ promise params
async function contextParams<T>(params: Promise<T> | T): Promise<T> {
  return await params;
}
