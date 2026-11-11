"use client";

import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  HelpCircle,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { StructuredBrief } from "./schema";

export interface ProjectBriefAssistantProps {
  initialDescription?: string;
  projectId?: string;
  onApplyBrief?: (brief: StructuredBrief) => void;
  className?: string;
}

export function updateListItem(list: string[], index: number, value: string): string[] {
  return list.map((item, i) => (i === index ? value : item));
}

export function addListItem(list: string[], defaultValue = ""): string[] {
  return [...list, defaultValue];
}

export function removeListItem(list: string[], index: number): string[] {
  return list.filter((_, i) => i !== index);
}

export function ProjectBriefAssistant({
  initialDescription = "",
  projectId,
  onApplyBrief,
  className = "",
}: ProjectBriefAssistantProps) {
  const [mode, setMode] = useState<"input" | "loading" | "review" | "applied">("input");
  const [description, setDescription] = useState(initialDescription);
  const [brief, setBrief] = useState<StructuredBrief | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleStructureBrief() {
    if (description.trim().length < 10) {
      setError("Please enter a project description with at least 10 characters.");
      return;
    }

    setMode("loading");
    setError(null);

    try {
      const response = await fetch("/api/ai/structure-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          projectId,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("You must be logged in to structure project briefs.");
        }
        if (response.status === 429) {
          throw new Error("AI request limit reached. Please wait a minute before trying again.");
        }
        if (response.status === 503) {
          throw new Error("AI service is temporarily unavailable. Please retry in a moment.");
        }
        if (response.status === 422) {
          throw new Error("AI generated an incomplete brief. Please provide a more descriptive summary and try again.");
        }
        throw new Error(payload.message || payload.error || "Unable to structure project brief.");
      }

      setBrief(payload.data.brief);
      setMode("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      setMode("input");
    }
  }

  function handleApply() {
    if (!brief) return;
    if (onApplyBrief) {
      onApplyBrief(brief);
    }
    setMode("applied");
  }

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Input Mode */}
      {mode === "input" && (
        <Card className="border-teal-200 bg-teal-50/30 p-6 sm:p-7">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600 text-white shadow-sm">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display text-xl text-ink-950">AI Project Brief Assistant</h3>
                <Badge tone="info">Free Tier</Badge>
              </div>
              <p className="mt-0.5 text-xs text-ink-700">
                Transform rough client notes or emails into a structured, reviewable project brief before creating agreements.
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            <label className="block text-sm font-semibold text-ink-800">
              Client&apos;s project description or notes
              <textarea
                aria-label="Client project description"
                className="mt-2 min-h-36 w-full rounded-xl border border-ink-200 bg-white p-3.5 text-sm text-ink-900 outline-none transition placeholder:text-ink-400 focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                maxLength={10000}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Example: Client needs an e-commerce website for their clothing business. They want to sell apparel, showcase lookbooks, and need customer accounts. No budget or launch date has been stated yet..."
                value={description}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-500">
              <span>{description.length} / 10,000 characters</span>
              <span>All AI output is reviewed by you before use.</span>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs text-red-900"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
              <div>
                <p className="font-semibold">Generation Error</p>
                <p className="mt-0.5">{error}</p>
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-teal-800">
              Untrusted client input is isolated. The AI will not invent budgets, deadlines, or client agreements.
            </p>
            <Button
              disabled={description.trim().length < 10}
              onClick={handleStructureBrief}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              Structure brief with AI
            </Button>
          </div>
        </Card>
      )}

      {/* Loading Mode */}
      {mode === "loading" && (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <Loader2 className="h-9 w-9 animate-spin text-teal-600" />
          <h4 className="mt-4 font-display text-lg text-ink-950">Analyzing & Structuring Brief</h4>
          <p className="mt-1.5 max-w-md text-sm text-ink-600">
            Extracting requirements, deliverables, unconfirmed assumptions, and critical clarification questions...
          </p>
          <p className="mt-3 text-xs text-ink-400">Powered by Gemini 3.8 Flash Free Tier ($0)</p>
        </Card>
      )}

      {/* Review Mode */}
      {mode === "review" && brief && (
        <Card className="border-ink-200 p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-5">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Project Brief Preview</p>
                <Badge tone="info">Editable</Badge>
              </div>
              <h3 className="mt-1 font-display text-2xl text-ink-950">Review Structured Project Brief</h3>
              <p className="mt-1 text-xs text-ink-600">
                Carefully review and refine each section below. Items flagged as assumptions or open questions require client confirmation.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setMode("input")}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Regenerate
              </Button>
            </div>
          </div>

          <div className="mt-6 space-y-7">
            {/* 1. Title and Summary */}
            <div className="space-y-4">
              <label className="block text-sm font-semibold text-ink-800">
                Project title
                <input
                  aria-label="Project title"
                  className="mt-1.5 block w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-base font-medium text-ink-950 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                  maxLength={140}
                  onChange={(e) => setBrief({ ...brief, title: e.target.value })}
                  value={brief.title}
                />
              </label>

              <label className="block text-sm font-semibold text-ink-800">
                Project summary
                <textarea
                  aria-label="Project summary"
                  className="mt-1.5 min-h-24 w-full rounded-xl border border-ink-200 bg-white p-3 text-sm text-ink-900 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                  maxLength={3000}
                  onChange={(e) => setBrief({ ...brief, summary: e.target.value })}
                  value={brief.summary}
                />
              </label>
            </div>

            {/* 2. Deliverables List */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold uppercase tracking-[0.1em] text-ink-800">
                    Deliverables ({brief.deliverables.length})
                  </h4>
                  <p className="text-xs text-ink-500">Tangible assets or products the freelancer must deliver.</p>
                </div>
                <Button
                  className="min-h-8 px-2.5 text-xs"
                  onClick={() => setBrief({ ...brief, deliverables: addListItem(brief.deliverables, "New deliverable") })}
                  variant="secondary"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add
                </Button>
              </div>

              <div className="space-y-2">
                {brief.deliverables.map((item, idx) => (
                  <div className="flex items-center gap-2" key={idx}>
                    <input
                      aria-label={`Deliverable ${idx + 1}`}
                      className="flex-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                      onChange={(e) => setBrief({ ...brief, deliverables: updateListItem(brief.deliverables, idx, e.target.value) })}
                      value={item}
                    />
                    <Button
                      aria-label={`Remove deliverable ${idx + 1}`}
                      className="min-h-8 px-2 text-red-600"
                      onClick={() => setBrief({ ...brief, deliverables: removeListItem(brief.deliverables, idx) })}
                      variant="ghost"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* 3. Functional Requirements */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold uppercase tracking-[0.1em] text-ink-800">
                    Functional Requirements ({brief.functionalRequirements.length})
                  </h4>
                  <p className="text-xs text-ink-500">Core features and functionality explicitly requested.</p>
                </div>
                <Button
                  className="min-h-8 px-2.5 text-xs"
                  onClick={() => setBrief({ ...brief, functionalRequirements: addListItem(brief.functionalRequirements, "New requirement") })}
                  variant="secondary"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add
                </Button>
              </div>

              <div className="space-y-2">
                {brief.functionalRequirements.map((item, idx) => (
                  <div className="flex items-center gap-2" key={idx}>
                    <input
                      aria-label={`Functional requirement ${idx + 1}`}
                      className="flex-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                      onChange={(e) => setBrief({ ...brief, functionalRequirements: updateListItem(brief.functionalRequirements, idx, e.target.value) })}
                      value={item}
                    />
                    <Button
                      aria-label={`Remove functional requirement ${idx + 1}`}
                      className="min-h-8 px-2 text-red-600"
                      onClick={() => setBrief({ ...brief, functionalRequirements: removeListItem(brief.functionalRequirements, idx) })}
                      variant="ghost"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* 4. Assumptions (Unconfirmed - Distinct Highlighting) */}
            <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-amber-950 uppercase tracking-wide">
                        Assumptions ({brief.assumptions.length})
                      </h4>
                      <Badge tone="warning">Needs Confirmation</Badge>
                    </div>
                    <p className="mt-1 text-xs text-amber-800">
                      Inferred conditions that have <strong>not been confirmed</strong> by the client. Must be validated prior to drafting formal terms.
                    </p>
                  </div>
                </div>
                <Button
                  className="min-h-8 px-2.5 text-xs text-amber-900 border-amber-300 hover:bg-amber-100"
                  onClick={() => setBrief({ ...brief, assumptions: addListItem(brief.assumptions, "New assumption") })}
                  variant="secondary"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add
                </Button>
              </div>

              <div className="mt-4 space-y-2">
                {brief.assumptions.length === 0 ? (
                  <p className="text-xs italic text-amber-700">No unconfirmed assumptions identified.</p>
                ) : (
                  brief.assumptions.map((item, idx) => (
                    <div className="flex items-center gap-2" key={idx}>
                      <input
                        aria-label={`Assumption ${idx + 1}`}
                        className="flex-1 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
                        onChange={(e) => setBrief({ ...brief, assumptions: updateListItem(brief.assumptions, idx, e.target.value) })}
                        value={item}
                      />
                      <Button
                        aria-label={`Remove assumption ${idx + 1}`}
                        className="min-h-8 px-2 text-red-600"
                        onClick={() => setBrief({ ...brief, assumptions: removeListItem(brief.assumptions, idx) })}
                        variant="ghost"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 5. Open Questions & Missing Information (Distinct Highlighting) */}
            <div className="rounded-2xl border border-teal-200 bg-teal-50/40 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <HelpCircle className="h-5 w-5 shrink-0 text-teal-700 mt-0.5" />
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-teal-950 uppercase tracking-wide">
                        Open Questions & Missing Information ({brief.openQuestions.length})
                      </h4>
                      <Badge tone="info">Requires Clarification</Badge>
                    </div>
                    <p className="mt-1 text-xs text-teal-800">
                      Critical details not specified in the client&apos;s description (e.g. payment methods, integrations, hosting, assets).
                    </p>
                  </div>
                </div>
                <Button
                  className="min-h-8 px-2.5 text-xs text-teal-900 border-teal-300 hover:bg-teal-100"
                  onClick={() => setBrief({ ...brief, openQuestions: addListItem(brief.openQuestions, "New clarification question") })}
                  variant="secondary"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add
                </Button>
              </div>

              <div className="mt-4 space-y-2">
                {brief.openQuestions.length === 0 ? (
                  <p className="text-xs italic text-teal-700">All necessary parameters appear to be addressed.</p>
                ) : (
                  brief.openQuestions.map((item, idx) => (
                    <div className="flex items-center gap-2" key={idx}>
                      <input
                        aria-label={`Open question ${idx + 1}`}
                        className="flex-1 rounded-lg border border-teal-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                        onChange={(e) => setBrief({ ...brief, openQuestions: updateListItem(brief.openQuestions, idx, e.target.value) })}
                        value={item}
                      />
                      <Button
                        aria-label={`Remove open question ${idx + 1}`}
                        className="min-h-8 px-2 text-red-600"
                        onClick={() => setBrief({ ...brief, openQuestions: removeListItem(brief.openQuestions, idx) })}
                        variant="ghost"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 6. Scope Inclusions & Exclusions */}
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">Scope Inclusions</h4>
                  <Button
                    className="min-h-7 px-2 text-xs"
                    onClick={() => setBrief({ ...brief, scopeInclusions: addListItem(brief.scopeInclusions, "Included work") })}
                    variant="ghost"
                  >
                    <Plus className="mr-1 h-3 w-3" /> Add
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {brief.scopeInclusions.map((item, idx) => (
                    <div className="flex items-center gap-1.5" key={idx}>
                      <input
                        aria-label={`Scope inclusion ${idx + 1}`}
                        className="flex-1 rounded border border-ink-200 bg-white px-2.5 py-1.5 text-xs text-ink-900 outline-none focus:border-teal-600"
                        onChange={(e) => setBrief({ ...brief, scopeInclusions: updateListItem(brief.scopeInclusions, idx, e.target.value) })}
                        value={item}
                      />
                      <button
                        aria-label={`Remove scope inclusion ${idx + 1}`}
                        className="p-1 text-ink-400 hover:text-red-600"
                        onClick={() => setBrief({ ...brief, scopeInclusions: removeListItem(brief.scopeInclusions, idx) })}
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">Scope Exclusions</h4>
                  <Button
                    className="min-h-7 px-2 text-xs"
                    onClick={() => setBrief({ ...brief, scopeExclusions: addListItem(brief.scopeExclusions, "Excluded work") })}
                    variant="ghost"
                  >
                    <Plus className="mr-1 h-3 w-3" /> Add
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {brief.scopeExclusions.map((item, idx) => (
                    <div className="flex items-center gap-1.5" key={idx}>
                      <input
                        aria-label={`Scope exclusion ${idx + 1}`}
                        className="flex-1 rounded border border-ink-200 bg-white px-2.5 py-1.5 text-xs text-ink-900 outline-none focus:border-teal-600"
                        onChange={(e) => setBrief({ ...brief, scopeExclusions: updateListItem(brief.scopeExclusions, idx, e.target.value) })}
                        value={item}
                      />
                      <button
                        aria-label={`Remove scope exclusion ${idx + 1}`}
                        className="p-1 text-ink-400 hover:text-red-600"
                        onClick={() => setBrief({ ...brief, scopeExclusions: removeListItem(brief.scopeExclusions, idx) })}
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 7. Timeline Expectations */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-ink-800">
                Timeline expectations
                <input
                  aria-label="Timeline expectations"
                  className="mt-1.5 block w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2 text-sm text-ink-900 outline-none focus:border-teal-600"
                  onChange={(e) => setBrief({ ...brief, timelineExpectations: e.target.value || null })}
                  placeholder="Not specified by client"
                  value={brief.timelineExpectations ?? ""}
                />
              </label>
              <p className="text-xs text-ink-500">
                {brief.timelineExpectations ? "Client-specified delivery expectation." : "No explicit deadline was found in the client description."}
              </p>
            </div>
          </div>

          {/* Action Bar */}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-ink-100 pt-6">
            <p className="text-xs text-ink-500">
              Applying this brief populates the project record. It does not create or overwrite agreements.
            </p>
            <div className="flex gap-3">
              <Button
                variant="secondary"
                onClick={() => setMode("input")}
              >
                Back to notes
              </Button>
              <Button onClick={handleApply}>
                <Check className="mr-2 h-4 w-4" />
                Apply to project brief
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Applied Confirmation */}
      {mode === "applied" && brief && (
        <Card className="border-emerald-200 bg-emerald-50/40 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
                <Check className="h-5 w-5" />
              </div>
              <div>
                <h4 className="font-display text-lg text-emerald-950">Structured Brief Applied</h4>
                <p className="mt-0.5 text-xs text-emerald-800">
                  The structured title and formatted brief have been applied to the project form. Review the details below and create your project workspace when ready.
                </p>
              </div>
            </div>
            <Button
              className="text-xs"
              onClick={() => setMode("review")}
              variant="secondary"
            >
              Edit brief again
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
