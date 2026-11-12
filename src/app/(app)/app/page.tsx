import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  FileText,
  Info,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getDashboardSummary } from "@/features/projects/data";
import { formatMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

function projectStatusTone(status: string): "success" | "warning" | "info" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "AWAITING_CLIENT") return "warning";
  if (status === "COMPLETED") return "info";
  return "neutral";
}

export default async function DashboardPage() {
  const dashboard = await getDashboardSummary();

  const metrics = [
    {
      label: "Active projects",
      value: String(dashboard.metrics.activeProjectsCount),
      detail: `${dashboard.metrics.completedProjectsCount} completed total`,
    },
    {
      label: "Awaiting client",
      value: String(dashboard.metrics.awaitingApprovalCount),
      detail: "Agreements under client review",
    },
    {
      label: "Action required",
      value: String(dashboard.metrics.openActionItemsCount),
      detail: "Changes or scope requests open",
    },
    {
      label: "Confirmed payments",
      value: String(dashboard.metrics.confirmedPaymentsCount),
      detail: "Provider-confirmed PayPal records",
    },
  ];

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Overview</p>
          <h1 className="mt-2 font-display text-3xl text-ink-950 sm:text-4xl">Your project ledger.</h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-700 sm:text-base">
            Track client verification, agreement revisions, deliverable submissions, and scope requests across every project.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!dashboard.isConfigured && <Badge tone="warning">Supabase unconfigured</Badge>}
          <Link className="w-full sm:w-auto" href="/app/projects/new">
            <Button className="w-full sm:w-auto">
              <Plus className="mr-2" size={16} />
              New project
            </Button>
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:mt-8 sm:gap-4 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card className="pr-interactive-card p-4 sm:p-5 hover:border-ink-200" key={metric.label}>
            <p className="text-xs font-semibold text-ink-700 sm:text-sm">{metric.label}</p>
            <p className="mt-2 font-display text-3xl text-ink-950 sm:mt-4 sm:text-4xl">{metric.value}</p>
            <p className="mt-1 text-xs text-ink-700 sm:text-sm">{metric.detail}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 sm:mt-8 xl:grid-cols-[1.45fr_0.95fr]">
        <div className="space-y-6">
          <Card className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-2xl text-ink-950">Needs attention</h2>
                <p className="mt-1 text-sm text-ink-700">
                  Prioritized client reviews, scope changes, and deliverable updates.
                </p>
              </div>
              <Badge tone={dashboard.needsAttention.some((n) => n.tone === "warning") ? "warning" : "neutral"}>
                {dashboard.needsAttention.length} open
              </Badge>
            </div>

            {dashboard.needsAttention.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-ink-200 bg-ink-50 px-6 py-10 text-center">
                <CheckCircle2 className="mx-auto text-teal-700" size={28} />
                <h3 className="mt-3 font-display text-xl text-ink-950">Nothing blocked right now.</h3>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-700">
                  Create a new project or open an existing workspace to draft an agreement and invite your client.
                </p>
              </div>
            ) : (
              <ul className="mt-5 space-y-3">
                {dashboard.needsAttention.map((item) => (
                  <li key={item.id}>
                    <Link
                      className="group flex items-start gap-3 rounded-xl border border-ink-100 bg-white p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-600/40 hover:bg-teal-50/30 hover:shadow-sm"
                      href={item.href}
                    >
                      {item.tone === "warning" ? (
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                      ) : (
                        <Info className="mt-0.5 h-5 w-5 shrink-0 text-teal-600" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold uppercase tracking-wider text-ink-700">
                            {item.title}
                          </span>
                          <Badge tone={item.tone === "warning" ? "warning" : "info"}>
                            {item.projectTitle}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-ink-800">{item.description}</p>
                      </div>
                      <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-ink-500 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-teal-700" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-2xl text-ink-950">Recent projects</h2>
                <p className="mt-1 text-sm text-ink-700">Latest agreements, milestones, and client progress.</p>
              </div>
              <Link className="inline-flex items-center text-sm font-bold text-teal-700 hover:text-teal-600" href="/app/projects">
                All projects <ArrowUpRight className="ml-1" size={16} />
              </Link>
            </div>

            {dashboard.recentProjects.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-ink-200 bg-ink-50 px-6 py-10 text-center">
                <FileText className="mx-auto text-teal-700" size={28} />
                <h3 className="mt-3 font-display text-xl text-ink-950">No projects created yet.</h3>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-700">
                  Start a project workspace with a structured brief, milestones, and a verified client review flow.
                </p>
                <Link className="mt-5 inline-block" href="/app/projects/new">
                  <Button>Create your first project</Button>
                </Link>
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {dashboard.recentProjects.map((project) => (
                  <Link href={`/app/projects/${project.id}`} key={project.id}>
                    <div className="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-100 p-4 transition hover:border-teal-600/40">
                      <div className="min-w-0">
                        <p className="font-display text-lg text-ink-950">{project.title}</p>
                        <p className="mt-0.5 text-sm text-ink-700">
                          {project.client_name} · {formatMoney(project.total_amount_minor, project.currency)} ·{" "}
                          {project.acceptedMilestoneCount}/{project.milestoneCount} milestones accepted
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={project.client_email_verified_at ? "info" : "warning"}>
                          {project.client_email_verified_at ? "Client verified" : "Verify email"}
                        </Badge>
                        <Badge tone={projectStatusTone(project.status)}>
                          {project.status.replaceAll("_", " ")}
                        </Badge>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-teal-50 text-teal-700">
                <Clock3 size={20} />
              </span>
              <div>
                <h2 className="font-display text-2xl text-ink-950">Recent activity</h2>
                <p className="text-sm text-ink-700">Audit trail across your workspace</p>
              </div>
            </div>

            {dashboard.recentActivities.length === 0 ? (
              <p className="mt-6 text-sm text-ink-600">
                Project events will appear here as briefs, agreements, milestones, and scope changes progress.
              </p>
            ) : (
              <ol className="mt-5 space-y-4">
                {dashboard.recentActivities.map((event) => (
                  <li className="border-l-2 border-teal-600/30 pl-4" key={event.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        className="text-xs font-bold uppercase tracking-wider text-teal-800 hover:underline"
                        href={`/app/projects/${event.project_id}`}
                      >
                        {event.projectTitle}
                      </Link>
                      <span className="text-xs text-ink-500">
                        · {new Date(event.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-900">{event.summary}</p>
                    <p className="text-xs text-ink-600">
                      {event.event_type} · Actor: {event.actor_label}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card className="p-6">
            <h2 className="font-display text-xl text-ink-950">Payment coordination boundary</h2>
            <p className="mt-3 border-l-2 border-teal-600 pl-4 text-sm leading-6 text-ink-700">
              Payment Operations remains strictly provider-confirmed. Marking a deliverable accepted never creates a payout, and PayPal capture never auto-accepts deliverables.
            </p>
            <Link
              className="mt-5 inline-flex items-center text-sm font-bold text-teal-700 hover:text-teal-600"
              href="/app/payments"
            >
              View payment operations <ArrowUpRight className="ml-1" size={16} />
            </Link>
          </Card>
        </div>
      </div>
    </>
  );
}
