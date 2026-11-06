import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import { getMyProjects } from "@/features/projects/data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

export default async function ProjectsPage() {
  const projects = await getMyProjects();
  return <><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Projects</p><h1 className="mt-2 font-display text-4xl text-ink-950">The work you have in motion.</h1><p className="mt-2 text-ink-700">Each project keeps its agreement, milestones, and activity together.</p></div><Link href="/app/projects/new"><Button><Plus className="mr-2" size={16} />New project</Button></Link></div>{projects.length === 0 ? <Card className="mt-8 p-10 text-center"><h2 className="font-display text-2xl">No projects yet.</h2><p className="mx-auto mt-3 max-w-md text-ink-700">Start with the facts you know. You can shape the agreement and milestones inside the project workspace.</p><Link className="mt-6 inline-block" href="/app/projects/new"><Button>Create your first project</Button></Link></Card> : <div className="mt-8 grid gap-4">{projects.map((project) => <Link href={`/app/projects/${project.id}`} key={project.id}><Card className="group flex flex-wrap items-center gap-4 p-5 transition hover:border-teal-600/40"><div className="min-w-0 flex-1"><p className="font-display text-xl text-ink-950">{project.title}</p><p className="mt-1 text-sm text-ink-700">{project.client_name} · {formatMoney(project.total_amount_minor, project.currency)}</p></div><Badge tone={project.status === "ACTIVE" ? "success" : project.status === "AWAITING_CLIENT" ? "warning" : "neutral"}>{project.status.replaceAll("_", " ")}</Badge><ArrowUpRight className="text-ink-700 transition group-hover:text-teal-700" size={18} /></Card></Link>)}</div>}</>;
}
