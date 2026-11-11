"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ProjectSummaryItem } from "@/features/projects/types";
import { cn, formatMoney } from "@/lib/utils";

const STATUS_FILTERS = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "AWAITING_CLIENT", label: "Awaiting client" },
  { key: "ACTIVE", label: "Active" },
  { key: "COMPLETED", label: "Completed" },
] as const;

function projectBadgeTone(status: string): "success" | "warning" | "info" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "AWAITING_CLIENT") return "warning";
  if (status === "COMPLETED") return "info";
  return "neutral";
}

function agreementBadgeTone(status: string): "success" | "warning" | "info" | "neutral" {
  if (status === "APPROVED") return "success";
  if (status === "CHANGES_REQUESTED") return "warning";
  if (status === "PENDING_CLIENT") return "info";
  return "neutral";
}

export function ProjectsListView({ projects }: { projects: ProjectSummaryItem[] }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  const counts = useMemo(() => {
    const map: Record<string, number> = { ALL: projects.length };
    for (const project of projects) {
      map[project.status] = (map[project.status] ?? 0) + 1;
    }
    return map;
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return projects.filter((project) => {
      if (statusFilter !== "ALL" && project.status !== statusFilter) {
        return false;
      }
      if (!query) return true;
      return (
        project.title.toLowerCase().includes(query) ||
        project.client_name.toLowerCase().includes(query) ||
        project.client_email.toLowerCase().includes(query)
      );
    });
  }, [projects, searchQuery, statusFilter]);

  if (projects.length === 0) {
    return (
      <Card className="mt-8 p-10 text-center">
        <h2 className="font-display text-2xl text-ink-950">No projects yet.</h2>
        <p className="mx-auto mt-3 max-w-md text-ink-700">
          Start with the facts you know. You can shape the agreement and milestones inside the project workspace.
        </p>
        <Link className="mt-6 inline-block" href="/app/projects/new">
          <Button>Create your first project</Button>
        </Link>
      </Card>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-ink-100 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500"
          />
          <input
            aria-label="Search projects"
            className="w-full rounded-xl border border-ink-200 bg-ink-50/40 py-2 pl-10 pr-4 text-sm text-ink-950 outline-none transition focus:border-teal-600 focus:bg-white focus:ring-2 focus:ring-teal-600/15"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by project title, client name, or client email..."
            type="search"
            value={searchQuery}
          />
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter projects by status">
          {STATUS_FILTERS.map((filter) => {
            const selected = statusFilter === filter.key;
            const count = counts[filter.key] ?? 0;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "rounded-xl px-3 py-1.5 text-xs font-semibold transition",
                  selected
                    ? "bg-ink-950 text-white"
                    : "border border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
                )}
                key={filter.key}
                onClick={() => setStatusFilter(filter.key)}
                type="button"
              >
                {filter.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {filteredProjects.length === 0 ? (
        <Card className="p-8 text-center">
          <h2 className="font-display text-xl text-ink-950">No matching projects</h2>
          <p className="mt-2 text-sm text-ink-700">
            Adjust your search query or status filter to view more projects.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("ALL");
            }}
            variant="secondary"
          >
            Clear filters
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredProjects.map((project) => (
            <Link href={`/app/projects/${project.id}`} key={project.id}>
              <Card className="group flex flex-wrap items-center justify-between gap-4 p-5 transition hover:border-teal-600/40">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-display text-xl text-ink-950">{project.title}</p>
                    <Badge tone={projectBadgeTone(project.status)}>
                      {project.status.replaceAll("_", " ")}
                    </Badge>
                  </div>

                  <p className="text-sm text-ink-700">
                    {project.client_name} ({project.client_email}) ·{" "}
                    <span className="font-semibold text-ink-950">
                      {formatMoney(project.total_amount_minor, project.currency)}
                    </span>
                  </p>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={project.client_email_verified_at ? "info" : "warning"}>
                      {project.client_email_verified_at ? "Client verified" : "Verification pending"}
                    </Badge>
                    <Badge tone={agreementBadgeTone(project.agreementStatus)}>
                      Agreement: {project.agreementStatus.replaceAll("_", " ")}
                      {project.agreementVersionNumber ? ` v${project.agreementVersionNumber}` : ""}
                    </Badge>
                    <Badge>
                      Milestones: {project.acceptedMilestoneCount}/{project.milestoneCount} accepted
                    </Badge>
                    {project.submittedMilestoneCount > 0 && (
                      <Badge tone="info">{project.submittedMilestoneCount} awaiting client</Badge>
                    )}
                    {project.revisionRequestedMilestoneCount > 0 && (
                      <Badge tone="warning">
                        {project.revisionRequestedMilestoneCount} revision requested
                      </Badge>
                    )}
                    {project.openChangeRequestCount > 0 && (
                      <Badge tone="warning">
                        {project.openChangeRequestCount} open scope request
                        {project.openChangeRequestCount > 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                </div>

                <ArrowUpRight className="shrink-0 text-ink-700 transition group-hover:text-teal-700" size={18} />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
