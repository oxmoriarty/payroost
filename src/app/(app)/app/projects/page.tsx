import Link from "next/link";
import { Plus } from "lucide-react";
import { getMyProjectsWithSummary } from "@/features/projects/data";
import { ProjectsListView } from "@/features/projects/projects-list-view";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = await getMyProjectsWithSummary();

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Projects</p>
          <h1 className="mt-2 font-display text-4xl text-ink-950">The work you have in motion.</h1>
          <p className="mt-2 text-ink-700">
            Each project keeps its agreement, milestones, client verification, and activity together.
          </p>
        </div>
        <Link href="/app/projects/new">
          <Button>
            <Plus className="mr-2" size={16} />
            New project
          </Button>
        </Link>
      </div>
      <ProjectsListView projects={projects} />
    </>
  );
}
