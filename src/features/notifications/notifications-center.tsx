"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fetchAppCsrfToken } from "@/features/notifications/client-csrf";
import type {
  NotificationCategory,
  NotificationFilter,
  NotificationPageResult,
  NotificationRecord,
} from "@/features/notifications/types";
import { cn } from "@/lib/utils";

interface NotificationsCenterProps {
  initialData: NotificationPageResult;
  projectTitles?: Record<string, string>;
}

const FILTER_OPTIONS: Array<{ value: NotificationFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "action_required", label: "Action required" },
];

const CATEGORY_OPTIONS: Array<{ value: NotificationCategory | "ALL"; label: string }> = [
  { value: "ALL", label: "All categories" },
  { value: "PROJECT", label: "Projects" },
  { value: "AGREEMENT", label: "Agreements" },
  { value: "MILESTONE", label: "Milestones" },
  { value: "SCOPE_CHANGE", label: "Scope changes" },
  { value: "PAYMENT", label: "Payments" },
  { value: "RECONCILIATION", label: "Reconciliation" },
];

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  PROJECT: "Project",
  AGREEMENT: "Agreement",
  MILESTONE: "Milestone",
  SCOPE_CHANGE: "Scope change",
  PAYMENT: "Payment",
  RECONCILIATION: "Reconciliation",
};

export function NotificationsCenter({
  initialData,
  projectTitles = {},
}: NotificationsCenterProps) {
  const router = useRouter();
  const [data, setData] = useState<NotificationPageResult>(initialData);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [category, setCategory] = useState<NotificationCategory | "ALL">("ALL");
  const [grouped, setGrouped] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  async function loadPage(params: {
    nextFilter?: NotificationFilter;
    nextCategory?: NotificationCategory | "ALL";
    nextPage?: number;
  }) {
    const targetFilter = params.nextFilter ?? filter;
    const targetCategory = params.nextCategory ?? category;
    const targetPage = params.nextPage ?? 1;

    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      sp.set("filter", targetFilter);
      sp.set("page", String(targetPage));
      sp.set("pageSize", String(data.pageSize || 20));
      if (targetCategory !== "ALL") {
        sp.set("category", targetCategory);
      }

      const response = await fetch(`/api/app/notifications?${sp.toString()}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });

      if (!response.ok) {
        throw new Error("Failed to fetch notifications.");
      }

      const payload = (await response.json()) as { data?: NotificationPageResult };
      if (!payload.data) {
        throw new Error("Invalid notifications response.");
      }

      setData(payload.data);
      setFilter(targetFilter);
      setCategory(targetCategory);
    } catch {
      setError("Unable to load notifications right now. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMarkRead(notificationId: string) {
    setBusyId(notificationId);
    setError(null);
    try {
      const csrfToken = await fetchAppCsrfToken();
      const response = await fetch(
        `/api/app/notifications/${encodeURIComponent(notificationId)}/read`,
        {
          method: "PATCH",
          headers: {
            "x-csrf-token": csrfToken,
          },
          credentials: "same-origin",
        },
      );

      if (!response.ok) {
        throw new Error("Unable to mark notification as read.");
      }

      const payload = (await response.json()) as { data?: NotificationRecord };
      const readAt = payload.data?.readAt ?? new Date().toISOString();

      setData((prev) => {
        const target = prev.notifications.find((n) => n.id === notificationId);
        const wasUnread = target ? !target.readAt : false;
        const wasUrgentUnread = target ? !target.readAt && target.actionRequired : false;

        let nextList = prev.notifications.map((n) =>
          n.id === notificationId ? { ...n, readAt: n.readAt ?? readAt } : n,
        );
        if (filter === "unread" || filter === "action_required") {
          nextList = nextList.filter((n) => !n.readAt);
        }

        return {
          ...prev,
          notifications: nextList,
          unreadCount: wasUnread ? Math.max(0, prev.unreadCount - 1) : prev.unreadCount,
          actionRequiredCount: wasUrgentUnread
            ? Math.max(0, prev.actionRequiredCount - 1)
            : prev.actionRequiredCount,
        };
      });

      router.refresh();
    } catch {
      setError("Could not mark notification as read. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleMarkAllRead() {
    if (data.unreadCount === 0) return;
    setMarkingAll(true);
    setError(null);
    try {
      const csrfToken = await fetchAppCsrfToken();
      const response = await fetch("/api/app/notifications/mark-all-read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error("Unable to mark all notifications as read.");
      }

      const now = new Date().toISOString();
      setData((prev) => ({
        ...prev,
        notifications:
          filter === "unread" || filter === "action_required"
            ? []
            : prev.notifications.map((n) => ({ ...n, readAt: n.readAt ?? now })),
        unreadCount: 0,
        actionRequiredCount: 0,
        totalCount:
          filter === "unread" || filter === "action_required" ? 0 : prev.totalCount,
      }));

      router.refresh();
    } catch {
      setError("Could not mark all notifications read. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  }

  function renderCard(item: NotificationRecord) {
    const isUnread = !item.readAt;
    const isWarning = item.severity === "WARNING" || item.severity === "ACTION_REQUIRED";
    const projectLabel =
      projectTitles[item.projectId] ??
      (typeof item.metadata?.projectTitle === "string" ? item.metadata.projectTitle : null);

    return (
      <li
        className={cn(
          "rounded-2xl border p-4 transition sm:p-5",
          isUnread
            ? isWarning
              ? "border-amber-300 bg-amber-50/45 shadow-sm"
              : "border-teal-400/60 bg-teal-50/35 shadow-sm"
            : "border-ink-100 bg-white",
        )}
        key={item.id}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {isWarning ? (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            ) : item.severity === "SUCCESS" ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            ) : (
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-teal-600" />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {isUnread ? (
                  <Badge tone={isWarning ? "warning" : "info"}>Unread</Badge>
                ) : (
                  <Badge tone="neutral">Read</Badge>
                )}
                <Badge tone="neutral">{CATEGORY_LABELS[item.category]}</Badge>
                {item.actionRequired && (
                  <Badge tone="warning">Action required</Badge>
                )}
                {projectLabel && (
                  <span className="truncate text-xs font-semibold text-ink-600">
                    · {projectLabel}
                  </span>
                )}
              </div>

              <h3 className="font-display text-base font-semibold text-ink-950">
                {item.title}
              </h3>
              <p className="text-sm leading-relaxed text-ink-800">{item.body}</p>

              <p className="text-xs text-ink-500">
                Initiated by {item.actorLabel} · {new Date(item.createdAt).toLocaleString()}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
            {item.actionHref && (
              <Link
                className="inline-flex min-h-9 items-center justify-center rounded-xl bg-teal-600 px-3.5 text-xs font-semibold text-white transition hover:bg-teal-700"
                href={item.actionHref}
                onClick={() => {
                  if (isUnread) {
                    void handleMarkRead(item.id);
                  }
                }}
              >
                {item.actionLabel ?? "Open project"}
              </Link>
            )}
            {isUnread && (
              <Button
                className="min-h-9 px-3 text-xs"
                disabled={busyId === item.id}
                onClick={() => void handleMarkRead(item.id)}
                variant="secondary"
              >
                {busyId === item.id ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                )}
                Mark read
              </Button>
            )}
          </div>
        </div>
      </li>
    );
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / (data.pageSize || 20)));
  const actionItems = data.notifications.filter((n) => n.actionRequired && !n.readAt);
  const unreadUpdates = data.notifications.filter((n) => !n.readAt && !n.actionRequired);
  const readItems = data.notifications.filter((n) => Boolean(n.readAt));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-800">
            Workspace inbox
          </p>
          <h1 className="mt-1 font-display text-3xl text-ink-950">Notifications</h1>
          <p className="mt-1 text-sm text-ink-600">
            Directed project, agreement, milestone, scope-change, and verified payment alerts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={loading}
            onClick={() => void loadPage({ nextPage: data.page })}
            variant="secondary"
          >
            <RefreshCw className={cn("mr-1.5 h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            disabled={markingAll || data.unreadCount === 0}
            onClick={() => void handleMarkAllRead()}
            variant="primary"
          >
            {markingAll ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <CheckCheck className="mr-1.5 h-4 w-4" />
            )}
            Mark all read ({data.unreadCount})
          </Button>
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
        <Card className="p-3 sm:p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-600 sm:text-xs">Unread</p>
          <p className="mt-1 font-display text-xl font-bold text-ink-950 sm:text-2xl">{data.unreadCount}</p>
        </Card>
        <Card className="p-3 sm:p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 sm:text-xs">
            Action required
          </p>
          <p className="mt-1 font-display text-xl font-bold text-amber-900 sm:text-2xl">
            {data.actionRequiredCount}
          </p>
        </Card>
        <Card className="p-3 sm:p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-ink-600 sm:text-xs">Matching view</p>
          <p className="mt-1 font-display text-xl font-bold text-ink-950 sm:text-2xl">{data.totalCount}</p>
        </Card>
      </div>

      {/* Filter & category controls */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter notifications">
            {FILTER_OPTIONS.map((opt) => (
              <button
                aria-pressed={filter === opt.value}
                className={cn(
                  "min-h-10 rounded-xl px-3.5 py-2 text-xs font-semibold transition sm:min-h-0",
                  filter === opt.value
                    ? "bg-teal-600 text-white"
                    : "border border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
                )}
                disabled={loading}
                key={opt.value}
                onClick={() => void loadPage({ nextFilter: opt.value, nextPage: 1 })}
                type="button"
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold text-ink-700 sm:flex-row sm:items-center sm:gap-2">
              Category
              <select
                aria-label="Filter notifications by category"
                className="min-h-10 w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-base font-medium text-ink-900 sm:min-h-0 sm:w-auto sm:text-xs"
                disabled={loading}
                onChange={(e) =>
                  void loadPage({
                    nextCategory: e.target.value as NotificationCategory | "ALL",
                    nextPage: 1,
                  })
                }
                value={category}
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              aria-pressed={grouped}
              className={cn(
                "rounded-xl border px-3 py-2 text-xs font-semibold transition",
                grouped
                  ? "border-teal-600 bg-teal-50 text-teal-900"
                  : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
              )}
              onClick={() => setGrouped((prev) => !prev)}
              type="button"
            >
              {grouped ? "Grouped view" : "Chronological list"}
            </button>
          </div>
        </div>
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50 p-4" role="alert">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-red-900">{error}</p>
            <Button
              className="min-h-9 px-3 text-xs"
              onClick={() => void loadPage({ nextPage: data.page })}
              variant="secondary"
            >
              Retry
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <Card className="p-10 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-teal-600" />
          <p className="mt-2 text-sm text-ink-600">Loading notifications...</p>
        </Card>
      ) : data.notifications.length === 0 ? (
        <Card className="p-10 text-center">
          <Bell className="mx-auto h-8 w-8 text-ink-400" />
          <h2 className="mt-3 font-display text-lg font-semibold text-ink-950">
            {filter === "unread"
              ? "No unread notifications"
              : filter === "action_required"
                ? "No action-required notifications"
                : "No notifications yet"}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-600">
            {filter === "all" && category === "ALL"
              ? "Updates will appear here when agreements, deliverables, scope requests, or verified payments change."
              : "Try switching filters or categories to inspect earlier notifications."}
          </p>
        </Card>
      ) : grouped && filter === "all" ? (
        <div className="space-y-6">
          {actionItems.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-amber-800">
                Action Required ({actionItems.length})
              </h2>
              <ul className="space-y-3">{actionItems.map(renderCard)}</ul>
            </section>
          )}
          {unreadUpdates.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-teal-800">
                Unread Updates ({unreadUpdates.length})
              </h2>
              <ul className="space-y-3">{unreadUpdates.map(renderCard)}</ul>
            </section>
          )}
          {readItems.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-ink-600">
                Earlier ({readItems.length})
              </h2>
              <ul className="space-y-3">{readItems.map(renderCard)}</ul>
            </section>
          )}
        </div>
      ) : (
        <ul className="space-y-3">{data.notifications.map(renderCard)}</ul>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink-100 bg-white px-4 py-3">
          <p className="text-xs text-ink-600">
            Page {data.page} of {totalPages} · {data.totalCount} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              className="min-h-9 px-3 text-xs"
              disabled={loading || data.page <= 1}
              onClick={() => void loadPage({ nextPage: data.page - 1 })}
              variant="secondary"
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              className="min-h-9 px-3 text-xs"
              disabled={loading || !data.hasMore}
              onClick={() => void loadPage({ nextPage: data.page + 1 })}
              variant="secondary"
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
