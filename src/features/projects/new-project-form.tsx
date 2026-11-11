"use client";

import { useState } from "react";
import { Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { createProjectAction } from "@/features/projects/actions";
import { ProjectBriefAssistant } from "@/features/briefs/project-brief-assistant";
import { formatBriefToMarkdown } from "@/features/briefs/format";
import type { StructuredBrief } from "@/features/briefs/schema";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

export function NewProjectForm() {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [totalAmountMinor, setTotalAmountMinor] = useState("");
  const [showAiAssistant, setShowAiAssistant] = useState(true);

  let amountHint = "Example: 200000 means USD 2,000.00";
  const parsedAmount = Number(totalAmountMinor);
  const normalizedCurrency = currency.trim().toUpperCase();
  if (Number.isInteger(parsedAmount) && parsedAmount > 0 && /^[A-Z]{3}$/.test(normalizedCurrency)) {
    try {
      amountHint = `Formatted total: ${formatMoney(parsedAmount, normalizedCurrency)}`;
    } catch {
      amountHint = "Enter a valid 3-letter ISO currency code.";
    }
  }

  function handleApplyBrief(structuredBrief: StructuredBrief) {
    if (!title || title.trim().length === 0) {
      setTitle(structuredBrief.title);
    }
    setBrief(formatBriefToMarkdown(structuredBrief));
  }

  return (
    <div className="space-y-8">
      {/* AI Assistant Section */}
      <div>
        <div className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-teal-600" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-teal-800">
              Optional: AI Project Brief Assistant
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setShowAiAssistant(!showAiAssistant)}
            className="inline-flex items-center text-xs font-semibold text-teal-700 hover:text-teal-900"
          >
            {showAiAssistant ? (
              <>
                Hide Assistant <ChevronUp className="ml-1 h-3.5 w-3.5" />
              </>
            ) : (
              <>
                Use AI Assistant <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </>
            )}
          </button>
        </div>

        {showAiAssistant && (
          <ProjectBriefAssistant onApplyBrief={handleApplyBrief} />
        )}
      </div>

      {/* Main Project Setup Form */}
      <Card className="p-6 sm:p-8">
        <form action={createProjectAction} className="space-y-7">
          <div className="rounded-xl border border-teal-200 bg-teal-50/70 p-4 text-sm text-teal-950">
            <p className="font-semibold text-teal-900">Verified Client Identity Required</p>
            <p className="mt-1 text-xs leading-relaxed text-teal-800">
              When created, PayRoost automatically sends a secure verification link to the client email address. Agreement review is locked until the client confirms their address.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Project title"
              name="title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Field label="Client name" name="clientName" required />
            <Field
              label="Client email"
              name="clientEmail"
              type="email"
              hint="A verification link will be sent to this email upon creation."
              required
            />
            <Field
              label="Currency"
              name="currency"
              maxLength={3}
              required
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
            <Field
              label="Total amount (minor units)"
              name="totalAmountMinor"
              type="number"
              min="1"
              hint={amountHint}
              required
              value={totalAmountMinor}
              onChange={(e) => setTotalAmountMinor(e.target.value)}
            />
            <Field label="Start date" name="startDate" type="date" />
            <Field label="Expected completion" name="targetEndDate" type="date" />
          </div>

          <label className="block text-sm font-semibold text-ink-800">
            Project brief
            <textarea
              className="mt-2 min-h-44 w-full rounded-xl border border-ink-200 bg-white p-3 font-normal outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
              name="brief"
              minLength={20}
              maxLength={20000}
              required
              placeholder="Describe the problem, intended work, key deliverables, assumptions, and exclusions."
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </label>

          <div className="flex justify-end">
            <Button type="submit">Create project workspace</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-semibold text-ink-800">
      {label}
      <input
        className="mt-2 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 font-normal outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
        {...props}
      />
      {hint && <span className="mt-1 block text-xs font-normal text-ink-700">{hint}</span>}
    </label>
  );
}
