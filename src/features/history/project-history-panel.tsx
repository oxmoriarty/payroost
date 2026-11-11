"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  ProjectHistoryAudience,
  ProjectHistoryCategory,
  ProjectHistoryItem,
  ProjectHistoryPageResult,
} from "@/features/history/types";
import { cn } from "@/lib/utils";

interface ProjectHistoryPanelProps {
  mode: ProjectHistoryAudience;
  projectId: string;
  portalToken?: string;
  initialHistory: ProjectHistoryPageResult;
  onClientNavigateSection?: (sectionId: string) => void;
}

const FREELANCER_CATEGORIES: Array<{ value: ProjectHistoryCategory | "ALL"; label: string }> = [
  { value: "ALL", label: "All events" },
  { value: "PROJECT", label: "Project" },
  { value: "AGREEMENT", label: "Agreement" },
  { value: "MILESTONE", label: "Milestones" },
  { value: "SCOPE_CHANGE", label: "Scope changes" },
  { value: "PAYMENT", label: "Payments" },
  { value: "RECONCILIATION", label: "Reconciliation" },
];

const CLIENT_CATEGORIES: Array<{ value: ProjectHistoryCategory | "ALL"; label: string }> = [
  { value: "ALL", label: "All events" },
  { value: "PROJECT", label: "Project" },
  { value: "AGREEMENT", label: "Agreement" },
  { value: "MILESTONE", label: "Milestones" },
  { value: "SCOPE_CHANGE", label: "Scope changes" },
  { value: "PAYMENT", label: "Payments" },
];

const CATEGORY_LABELS: Record<ProjectHistoryCategory, string> = {
  PROJECT: "Project",
  AGREEMENT: "Agreement",
  MILESTONE: "Milestone",
  SCOPE_CHANGE: "Scope Change",
  PAYMENT: "Payment",
  RECONCILIATION: "Reconciliation",
};

function scrollPortalHash(href: string, onClientNavigateSection?: (id: string) => void) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return;
  const sectionId = href.slice(hashIndex + 1);
  if (!sectionId) return;
  if (onClientNavigateSection) {
    onClientNavigateSection(sectionId);
  }
  const el = document.getElementById(sectionId);
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function ProjectHistoryPanel({
  mode,
  projectId,
  portalToken,
  initialHistory,
  onClientNavigateSection,
}: ProjectHistoryPanelProps) {
  const [data, setData] = useState<ProjectHistoryPageResult>(initialHistory);
  const [category, setCategory] = useState<ProjectHistoryCategory | "ALL">("ALL");
  const [sort, setSort] = useState<"desc" | "asc">("desc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categoryOptions = mode === "client" ? CLIENT_CATEGORIES : FREELANCER_CATEGORIES;

  async function loadHistory(params: {
    nextCategory?: ProjectHistoryCategory | "ALL";
    nextSort?: "desc" | "asc";
    nextPage?: number;
  }) {
    const targetCategory = params.nextCategory ?? category;
    const targetSort = params.nextSort ?? sort;
    const targetPage = params.nextPage ?? 1;

    const baseUrl =
      mode === "client"
        ? portalToken
          ? `/api/public/portal/${encodeURIComponent(portalToken)}/history`
          : null
        : `/api/projects/${encodeURIComponent(projectId)}/history`;

    if (!baseUrl) return;

    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      sp.set("sort", targetSort);
      sp.set("page", String(targetPage));
      sp.set("pageSize", String(data.pageSize || 20));
      if (targetCategory !== "ALL") {
        sp.set("category", targetCategory);
      }

      const response = await fetch(`${baseUrl}?${sp.toString()}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });

      if (!response.ok) {
        throw new Error("Unable to load project history.");
      }

      const payload = (await response.json()) as { data?: ProjectHistoryPageResult };
      if (!payload.data) {
        throw new Error("Invalid project history response.");
      }

      setData(payload.data);
      setCategory(targetCategory);
      setSort(targetSort);
    } catch {
      setError("Could not refresh project history. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function renderEntityLink(item: ProjectHistoryItem) {
    if (!item.entityRef?.href) return null;
    const { href, label } = item.entityRef;

    if (mode === "client" && (href.startsWith("#") || href.startsWith("/portal#"))) {
      return (
        <button
          className="text-xs font-semibold text-teal-700 hover:underline"
          onClick={() => scrollPortalHash(href, onClientNavigateSection)}
          type="button"
        >
          {label} →
        </button>
      );
    }

    return (
      <Link className="text-xs font-semibold text-teal-700 hover:underline" href={href}>
        {label} →
      </Link>
    );
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / (data.pageSize || 20)));

  return (
    <Card className="p-5 sm:p-6" id="history">
      <div className="flex flex-col gap-3 border-b border-ink-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl text-ink-950">
            {mode === "client" ? "Project Activity History" : "Project history"}
          </h2>
          <p className="mt-0.5 text-xs text-ink-600">
            Chronological record of agreements, deliverables, scope decisions, and verified payment events.
          </p>
        </div>

        <Button
          className="min-h-9 self-start px-3 text-xs sm:self-auto"
          disabled={loading}
          onClick={() =>
            void loadHistory({
              nextSort: sort === "desc" ? "asc" : "desc",
              nextPage: 1,
            })
          }
          variant="secondary"
        >
          <ArrowUpDown className="mr-1.5 h-3.5 w-3.5" />
          {sort === "desc" ? "Newest first" : "Oldest first"}
        </Button>
      </div>

      {/* Category Filter Pills */}
      <div
        aria-label="Filter project history"
        className="mt-4 flex flex-wrap items-center gap-2"
        role="group"
      >
        {categoryOptions.map((opt) => (
          <button
            aria-pressed={category === opt.value}
            className={cn(
              "rounded-xl px-3 py-1.5 text-xs font-semibold transition",
              category === opt.value
                ? "bg-teal-600 text-white"
                : "border border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
            )}
            disabled={loading}
            key={opt.value}
            onClick={() => void loadHistory({ nextCategory: opt.value, nextPage: 1 })}
            type="button"
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900" role="alert">
          <span>{error}</span>
          <Button
            className="min-h-8 px-2.5 text-xs"
            onClick={() => void loadHistory({ nextPage: data.page })}
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-teal-600" />
          <p className="mt-2 text-xs text-ink-600">Loading project history...</p>
        </div>
      ) : data.items.length === 0 ? (
        <div className="py-10 text-center">
          <Clock3 className="mx-auto h-7 w-7 text-ink-400" />
          <p className="mt-2 text-sm font-medium text-ink-900">
            {category === "ALL"
              ? "No project history recorded yet"
              : "No matching events in this category"}
          </p>
          <p className="mt-1 text-xs text-ink-600">
            {category === "ALL"
              ? "Milestones, agreement approvals, and verified payment records will appear chronologically."
              : "Select All events to inspect other project activity."}
          </p>
        </div>
      ) : (
        <ol className="mt-5 space-y-4">
          {data.items.map((item) => (
            <li
              className="relative border-l-2 border-teal-600/30 pl-4 pb-1"
              key={item.id}
            >
              <span
                aria-hidden="true"
                className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-teal-600"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{CATEGORY_LABELS[item.category]}</Badge>
                {item.aiAttributionLabel && (
                  <Badge tone={item.isAiAssisted ? "info" : "neutral"}>
                    {item.isAiAssisted && <Sparkles className="mr-1 h-3 w-3" />}
                    {item.aiAttributionLabel}
                  </Badge>
                )}
                {item.stateDisciplineBadge && (
                  <Badge tone="warning">{item.stateDisciplineBadge}</Badge>
                )}
                <span className="text-xs text-ink-500">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>

              <div className="mt-1.5 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                <h3 className="text-sm font-semibold text-ink-950">{item.title}</h3>
                {renderEntityLink(item)}
              </div>

              <p className="mt-0.5 text-sm leading-relaxed text-ink-800">{item.summary}</p>
              <p className="mt-1 text-xs text-ink-500">Actor: {item.actorLabel}</p>
            </li>
          ))}
        </ol>
      )}

      {totalPages > 1 && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-4">
          <p className="text-xs text-ink-600">
            Page {data.page} of {totalPages} · {data.totalCount} events
          </p>
          <div className="flex items-center gap-2">
            <Button
              className="min-h-8 px-3 text-xs"
              disabled={loading || data.page <= 1}
              onClick={() => void loadHistory({ nextPage: data.page - 1 })}
              variant="secondary"
            >
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              Previous
            </Button>
            <Button
              className="min-h-8 px-3 text-xs"
              disabled={loading || !data.hasMore}
              onClick={() => void loadHistory({ nextPage: data.page + 1 })}
              variant="secondary"
            >
              Next
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
