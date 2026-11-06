import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createProjectAction } from "@/features/projects/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="mx-auto max-w-3xl">
      <Link className="inline-flex items-center text-sm font-bold text-teal-700 hover:text-teal-600" href="/app/projects">
        <ArrowLeft className="mr-2" size={16} />Projects
      </Link>
      <p className="mt-7 text-sm font-bold uppercase tracking-[0.14em] text-teal-700">New project</p>
      <h1 className="mt-2 font-display text-4xl text-ink-950">Give the work a clear beginning.</h1>
      <p className="mt-3 text-ink-700">Add the facts you know. Agreement drafting comes after the project record exists.</p>
      {error === "owner_email_forbidden" ? (
        <p className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">
          You cannot use your own registered account email as the client email. Client email must belong to an external reviewer.
        </p>
      ) : error ? (
        <p className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">
          We could not save the project. Check each field and try again.
        </p>
      ) : null}
      <Card className="mt-8 p-6 sm:p-8">
        <form action={createProjectAction} className="space-y-7">
          <div className="rounded-xl border border-teal-200 bg-teal-50/70 p-4 text-sm text-teal-950">
            <p className="font-semibold text-teal-900">Verified Client Identity Required</p>
            <p className="mt-1 text-xs leading-relaxed text-teal-800">
              When created, Payroost automatically sends a secure verification link to the client email address. Agreement review is locked until the client confirms their address.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Project title" name="title" required />
            <Field label="Client name" name="clientName" required />
            <Field
              label="Client email"
              name="clientEmail"
              type="email"
              hint="A verification link will be sent to this email upon creation."
              required
            />
            <Field label="Currency" name="currency" defaultValue="USD" maxLength={3} required />
            <Field label="Total amount (minor units)" name="totalAmountMinor" type="number" min="1" hint="Example: 200000 means USD 2,000.00" required />
            <Field label="Start date" name="startDate" type="date" />
            <Field label="Expected completion" name="targetEndDate" type="date" />
          </div>
          <label className="block text-sm font-semibold text-ink-800">Project brief
            <textarea className="mt-2 min-h-44 w-full rounded-xl border border-ink-200 bg-white p-3 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15" name="brief" minLength={20} maxLength={20000} required placeholder="Describe the problem, intended work, key deliverables, assumptions, and exclusions." />
          </label>
          <div className="flex justify-end">
            <Button type="submit">Create project workspace</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({ label, hint, ...props }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) { return <label className="block text-sm font-semibold text-ink-800">{label}<input className="mt-2 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 font-normal outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15" {...props} />{hint && <span className="mt-1 block text-xs font-normal text-ink-700">{hint}</span>}</label>; }
