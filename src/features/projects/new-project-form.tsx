"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  createProjectAction,
  type CreateProjectActionState,
} from "@/features/projects/actions";
import { ProjectBriefAssistant } from "@/features/briefs/project-brief-assistant";
import { formatBriefToMarkdown } from "@/features/briefs/format";
import type { StructuredBrief } from "@/features/briefs/schema";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

const INITIAL_ACTION_STATE: CreateProjectActionState = {
  status: "idle",
  message: null,
  fieldErrors: {},
};

export function NewProjectForm() {
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [brief, setBrief] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [totalAmountMinor, setTotalAmountMinor] = useState("");
  const [startDate, setStartDate] = useState("");
  const [targetEndDate, setTargetEndDate] = useState("");
  const [showAiAssistant, setShowAiAssistant] = useState(true);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const [actionState, formAction, isPending] = useActionState(
    createProjectAction,
    INITIAL_ACTION_STATE,
  );

  useEffect(() => {
    if (!tokenInputRef.current || tokenInputRef.current.value) return;
    tokenInputRef.current.value =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }, []);

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
        <div className="flex justify-end pb-3">
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
        <form action={formAction} className="space-y-7">
          <input ref={tokenInputRef} type="hidden" name="submissionToken" defaultValue="" />

          <div className="rounded-xl border border-teal-200 bg-teal-50/70 p-4 text-sm text-teal-950">
            <p className="font-semibold text-teal-900">Verified Client Identity Required</p>
            <p className="mt-1 text-xs leading-relaxed text-teal-800">
              When created, PayRoost automatically sends a secure verification link to the client email address. Agreement review is locked until the client confirms their address.
            </p>
          </div>

          {actionState.status === "error" && actionState.message && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
            >
              {actionState.message}
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Project title"
              name="title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={actionState.fieldErrors.title}
            />
            <Field
              label="Client name"
              name="clientName"
              required
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              error={actionState.fieldErrors.clientName}
            />
            <Field
              label="Client email"
              name="clientEmail"
              type="email"
              hint="A verification link will be sent to this email upon creation."
              required
              value={clientEmail}
              onChange={(e) => setClientEmail(e.target.value)}
              error={actionState.fieldErrors.clientEmail}
            />
            <Field
              label="Currency"
              name="currency"
              maxLength={3}
              required
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              error={actionState.fieldErrors.currency}
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
              error={actionState.fieldErrors.totalAmountMinor}
            />
            <Field
              label="Start date"
              name="startDate"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              error={actionState.fieldErrors.startDate}
            />
            <Field
              label="Expected completion"
              name="targetEndDate"
              type="date"
              value={targetEndDate}
              onChange={(e) => setTargetEndDate(e.target.value)}
              error={actionState.fieldErrors.targetEndDate}
            />
          </div>

          <label className="block text-sm font-semibold text-ink-800">
            Project brief
            <textarea
              className="mt-2 min-h-44 w-full rounded-xl border border-ink-200 bg-white p-3 text-base font-normal outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 sm:text-sm"
              name="brief"
              minLength={20}
              maxLength={20000}
              required
              aria-invalid={Boolean(actionState.fieldErrors.brief)}
              placeholder="Describe the problem, intended work, key deliverables, assumptions, and exclusions."
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
            {actionState.fieldErrors.brief && (
              <span className="mt-1 block text-xs font-medium text-red-700">
                {actionState.fieldErrors.brief}
              </span>
            )}
          </label>

          <div className="flex justify-end">
            <Button className="w-full sm:w-auto" type="submit" disabled={isPending}>
              {isPending ? "Creating workspace..." : "Create project workspace"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  ...props
}: { label: string; hint?: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-semibold text-ink-800">
      {label}
      <input
        aria-invalid={Boolean(error)}
        className={`mt-2 block w-full rounded-xl border bg-white px-3 py-2.5 text-base font-normal outline-none transition focus:ring-2 sm:text-sm ${
          error
            ? "border-red-400 focus:border-red-600 focus:ring-red-600/15"
            : "border-ink-200 focus:border-teal-600 focus:ring-teal-600/15"
        }`}
        {...props}
      />
      {error && <span className="mt-1 block text-xs font-medium text-red-700">{error}</span>}
      {hint && <span className="mt-1 block text-xs font-normal text-ink-700">{hint}</span>}
    </label>
  );
}
