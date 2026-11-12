import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { NewProjectForm } from "@/features/projects/new-project-form";

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="mx-auto max-w-3xl">
      <Link className="group inline-flex items-center text-sm font-bold text-teal-700 transition-colors hover:text-teal-600" href="/app/projects">
        <ArrowLeft className="mr-2 transition-transform duration-200 group-hover:-translate-x-0.5" size={16} />Projects
      </Link>
      <p className="mt-7 text-sm font-bold uppercase tracking-[0.14em] text-teal-700">New project</p>
      <h1 className="mt-2 font-display text-3xl text-ink-950 sm:text-4xl">Give the work a clear beginning.</h1>
      {error === "owner_email_forbidden" ? (
        <p className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">
          You cannot use your own registered account email as the client email. Client email must belong to an external reviewer.
        </p>
      ) : error ? (
        <p className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">
          We could not save the project. Check each field and try again.
        </p>
      ) : null}
      <div className="mt-8">
        <NewProjectForm />
      </div>
    </div>
  );
}
