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
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Projects</p>
          <h1 className="mt-2 font-display text-3xl text-ink-950 sm:text-4xl">The work you have in motion.</h1>
        </div>
        <Link className="w-full sm:w-auto" href="/app/projects/new">
          <Button className="w-full sm:w-auto">
            <Plus className="mr-2" size={16} />
            New project
          </Button>
        </Link>
      </div>
      <ProjectsListView projects={projects} />
    </>
  );
}
