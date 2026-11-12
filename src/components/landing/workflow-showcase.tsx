"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, FileCheck2, ShieldCheck, WalletCards } from "lucide-react";
import { cn } from "@/lib/utils";

interface StageItem {
  id: string;
  step: string;
  tabLabel: string;
  title: string;
  description: string;
  statusLabel: string;
  previewTitle: string;
  previewMeta: string;
  rows: Array<{ label: string; state: string; active?: boolean }>;
}

const STAGES: StageItem[] = [
  {
    id: "agreement",
    step: "01",
    tabLabel: "Agreement",
    title: "Start from a clear written scope",
    description:
      "Share a review link with your client so they can read the deliverables and approve the plan before work begins.",
    statusLabel: "Client approved",
    previewTitle: "Brand Identity Refresh",
    previewMeta: "Version 2 agreed before kickoff",
    rows: [
      { label: "Discovery workshop notes", state: "Included", active: true },
      { label: "Primary visual system", state: "Included", active: true },
      { label: "Launch asset handoff", state: "Included" },
    ],
  },
  {
    id: "portal",
    step: "02",
    tabLabel: "Client portal",
    title: "One calm link for client reviews",
    description:
      "Clients confirm access with a short email code, inspect submitted work, and check what comes next.",
    statusLabel: "Email verified",
    previewTitle: "Milestone Two Review",
    previewMeta: "Shared portal session active",
    rows: [
      { label: "Homepage layout screens", state: "Accepted", active: true },
      { label: "Mobile responsive screens", state: "Ready for review", active: true },
      { label: "Final production files", state: "Scheduled" },
    ],
  },
  {
    id: "records",
    step: "03",
    tabLabel: "Payment records",
    title: "Honest payment history",
    description:
      "Confirmed PayPal captures appear beside your milestones so every payment event stays easy to verify.",
    statusLabel: "Provider confirmed",
    previewTitle: "Milestone Payment Ledger",
    previewMeta: "Recorded via PayPal capture event",
    rows: [
      { label: "Deposit milestone", state: "Confirmed", active: true },
      { label: "Design delivery milestone", state: "Confirmed", active: true },
      { label: "Final handoff milestone", state: "Pending capture" },
    ],
  },
];

export function WorkflowShowcase() {
  const [activeId, setActiveId] = useState<string>(STAGES[0].id);
  const activeStage = STAGES.find((stage) => stage.id === activeId) ?? STAGES[0];

  return (
    <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-12">
      <div>
        <div
          aria-label="Payroost workflow stages"
          className="inline-flex flex-wrap gap-2 rounded-2xl border border-ink-200/80 bg-white/80 p-1.5 backdrop-blur"
          role="tablist"
        >
          {STAGES.map((stage) => {
            const isSelected = stage.id === activeStage.id;
            return (
              <button
                aria-selected={isSelected}
                className={cn(
                  "inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all duration-200 sm:text-sm",
                  isSelected
                    ? "bg-ink-950 text-white shadow-sm"
                    : "text-ink-700 hover:bg-ink-100/80 hover:text-ink-950"
                )}
                key={stage.id}
                onClick={() => setActiveId(stage.id)}
                role="tab"
                type="button"
              >
                <span
                  className={cn(
                    "font-mono text-[11px]",
                    isSelected ? "text-teal-300" : "text-ink-500"
                  )}
                >
                  {stage.step}
                </span>
                <span>{stage.tabLabel}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-7 min-h-[11rem]" key={activeStage.id}>
          <div className="pr-page-enter">
            <h3 className="font-display text-2xl font-semibold tracking-[-0.025em] text-ink-950 sm:text-3xl">
              {activeStage.title}
            </h3>
            <p className="mt-3.5 max-w-xl text-base leading-7 text-ink-700">
              {activeStage.description}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-teal-600/20 bg-teal-50 px-3.5 py-1.5 text-xs font-semibold text-teal-700">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                {activeStage.statusLabel}
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-600">
                Select any stage above to preview
                <ArrowRight className="size-3.5 text-teal-700" aria-hidden="true" />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        className="pr-interactive-card relative overflow-hidden rounded-3xl border border-ink-200/80 bg-white p-5 shadow-[0_20px_50px_-28px_rgba(13,28,37,0.2)] sm:p-7"
        role="tabpanel"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-12 -top-12 size-44 rounded-full bg-teal-50 blur-2xl"
        />
        <div className="relative flex items-start justify-between gap-4 border-b border-ink-100 pb-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">
              Stage {activeStage.step}
            </p>
            <h4 className="mt-1 font-display text-lg font-semibold text-ink-950 sm:text-xl">
              {activeStage.previewTitle}
            </h4>
            <p className="mt-0.5 text-xs text-ink-600">{activeStage.previewMeta}</p>
          </div>
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
            {activeStage.id === "agreement" ? (
              <FileCheck2 size={18} />
            ) : activeStage.id === "portal" ? (
              <CheckCircle2 size={18} />
            ) : (
              <WalletCards size={18} />
            )}
          </span>
        </div>

        <ul className="relative mt-4 space-y-2.5" key={`panel-${activeStage.id}`}>
          {activeStage.rows.map((row, index) => (
            <li
              className="pr-page-enter flex items-center justify-between gap-3 rounded-2xl border border-ink-100 bg-ink-50/70 px-4 py-3 transition-colors duration-200 hover:border-teal-600/30 hover:bg-white"
              key={row.label}
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <span className="text-sm font-medium text-ink-900">{row.label}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
                  row.active
                    ? "bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-600/20"
                    : "bg-white text-ink-600 ring-1 ring-inset ring-ink-200"
                )}
              >
                {row.state}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
