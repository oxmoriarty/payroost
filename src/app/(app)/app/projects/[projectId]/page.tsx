import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, AlertTriangle, ShieldCheck } from "lucide-react";
import { getProjectWorkspace } from "@/features/projects/data";
import { AgreementEditor } from "@/features/agreements/agreement-editor";
import { agreementDraftSchema } from "@/features/agreements/schema";
import { MilestonePlanner } from "@/features/milestones/milestone-planner";
import { ScopeChangePanel } from "@/features/scope-changes/scope-change-panel";
import { ResendVerificationButton } from "@/features/projects/resend-verification-button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await contextParams(params);
  const workspace = await getProjectWorkspace(projectId);

  if (!workspace) {
    notFound();
  }

  const { project, agreement, versions, milestones, activities, changeRequests } = workspace;
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
      <AgreementEditor
        key={agreementEditorKey}
        projectId={project.id}
        versions={versions}
        canUseAi={canUseAi}
        isClientVerified={isClientVerified}
        clientEmail={project.client_email}
      />

      {/* Intelligent Scope-Change Analysis & Change Requests (AI-5) */}
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

      {/* Project Activity Audit Trail */}
      {activities.length > 0 && (
        <Card className="p-6">
          <h2 className="font-display text-xl text-ink-950">Activity history</h2>
          <ol className="mt-4 space-y-4">
            {activities.map((activity) => (
              <li key={activity.id} className="border-l-2 border-teal-600/30 pl-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-teal-800">{activity.event_type}</span>
                  <span className="text-xs text-ink-500">· {new Date(activity.created_at).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-sm text-ink-800">{activity.summary}</p>
                <p className="text-xs text-ink-500">Actor: {activity.actor_label}</p>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

// Helper for Next.js 15+ promise params
async function contextParams<T>(params: Promise<T> | T): Promise<T> {
  return await params;
}
