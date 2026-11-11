"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Info,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  NotificationFilter,
  NotificationPageResult,
  NotificationRecord,
} from "@/features/notifications/types";
import { cn } from "@/lib/utils";

interface PortalNotificationsPanelProps {
  token: string;
  csrfToken: string;
  initialData: NotificationPageResult;
  onNavigateSection?: (sectionId: string) => void;
}

const FILTER_OPTIONS: Array<{ value: NotificationFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "action_required", label: "Action required" },
];

export function PortalNotificationsPanel({
  token,
  csrfToken,
  initialData,
  onNavigateSection,
}: PortalNotificationsPanelProps) {
  const [data, setData] = useState<NotificationPageResult>(initialData);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [expanded, setExpanded] = useState(
    initialData.unreadCount > 0 || initialData.actionRequiredCount > 0,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  function jumpToSection(href: string) {
    const hashIndex = href.indexOf("#");
    if (hashIndex === -1) return;
    const sectionId = href.slice(hashIndex + 1);
    if (!sectionId) return;
    if (onNavigateSection) {
      onNavigateSection(sectionId);
    }
    const el = document.getElementById(sectionId);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function loadPage(nextFilter: NotificationFilter, nextPage: number) {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      sp.set("filter", nextFilter);
      sp.set("page", String(nextPage));
      sp.set("pageSize", String(data.pageSize || 10));

      const response = await fetch(
        `/api/public/portal/${encodeURIComponent(token)}/notifications?${sp.toString()}`,
        {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
        },
      );

      if (!response.ok) {
        throw new Error("Unable to load notifications.");
      }

      const payload = (await response.json()) as { data?: NotificationPageResult };
      if (!payload.data) {
        throw new Error("Invalid notifications response.");
      }

      setData(payload.data);
      setFilter(nextFilter);
    } catch {
      setError("Could not load portal notifications. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMarkRead(notificationId: string) {
    setBusyId(notificationId);
    setError(null);
    try {
      const response = await fetch(
        `/api/public/portal/${encodeURIComponent(token)}/notifications/${encodeURIComponent(notificationId)}/read`,
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
    } catch {
      setError("Could not update notification status. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleMarkAllRead() {
    if (data.unreadCount === 0) return;
    setMarkingAll(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/public/portal/${encodeURIComponent(token)}/notifications/mark-all-read`,
        {
          method: "POST",
          headers: {
            "x-csrf-token": csrfToken,
          },
          credentials: "same-origin",
        },
      );

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
    } catch {
      setError("Could not mark all notifications as read. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / (data.pageSize || 10)));

  return (
    <Card className="mt-6 p-5 sm:p-6" id="notifications">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
            <Bell className="h-5 w-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-bold text-ink-950">
                Portal Notifications
              </h2>
              <Badge tone={data.unreadCount > 0 ? "info" : "neutral"}>
                {data.unreadCount} unread
              </Badge>
              {data.actionRequiredCount > 0 && (
                <Badge tone="warning">{data.actionRequiredCount} action needed</Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-ink-600">
              Updates on agreements, deliverable submissions, scope requests, and verified payments.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {data.unreadCount > 0 && (
            <Button
              className="min-h-9 px-3 text-xs"
              disabled={markingAll}
              onClick={() => void handleMarkAllRead()}
              variant="secondary"
            >
              {markingAll ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
              )}
              Mark all read
            </Button>
          )}
          <Button
            className="min-h-9 px-3 text-xs"
            onClick={() => setExpanded((prev) => !prev)}
            variant="ghost"
          >
            {expanded ? (
              <>
                Hide <ChevronUp className="ml-1 h-4 w-4" />
              </>
            ) : (
              <>
                Show ({data.totalCount}) <ChevronDown className="ml-1 h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-4 border-t border-ink-100 pt-4">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter portal notifications">
            {FILTER_OPTIONS.map((opt) => (
              <button
                aria-pressed={filter === opt.value}
                className={cn(
                  "rounded-xl px-3 py-1.5 text-xs font-semibold transition",
                  filter === opt.value
                    ? "bg-teal-600 text-white"
                    : "border border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
                )}
                disabled={loading}
                key={opt.value}
                onClick={() => void loadPage(opt.value, 1)}
                type="button"
              >
                {opt.label}
              </button>
            ))}
          </div>

          {error && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900"
              role="alert"
            >
              <span>{error}</span>
              <Button
                className="min-h-8 px-2.5 text-xs"
                onClick={() => void loadPage(filter, data.page)}
                variant="secondary"
              >
                Retry
              </Button>
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-teal-600" />
              <p className="mt-2 text-xs text-ink-600">Loading notifications...</p>
            </div>
          ) : data.notifications.length === 0 ? (
            <div className="py-6 text-center">
              <CheckCircle2 className="mx-auto h-6 w-6 text-teal-600" />
              <p className="mt-2 text-sm font-medium text-ink-900">
                {filter === "unread"
                  ? "No unread notifications"
                  : filter === "action_required"
                    ? "No pending action items"
                    : "All caught up"}
              </p>
              <p className="mt-0.5 text-xs text-ink-600">
                New updates on submissions, agreements, and verified payments appear here.
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {data.notifications.map((item) => {
                const isUnread = !item.readAt;
                const isWarning =
                  item.severity === "WARNING" || item.severity === "ACTION_REQUIRED";

                return (
                  <li
                    className={cn(
                      "rounded-xl border p-3.5 transition",
                      isUnread
                        ? isWarning
                          ? "border-amber-300 bg-amber-50/45"
                          : "border-teal-400/60 bg-teal-50/35"
                        : "border-ink-100 bg-white",
                    )}
                    key={item.id}
                  >
                    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-2.5">
                        {isWarning ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        ) : item.severity === "SUCCESS" ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        ) : (
                          <Info className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
                        )}
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-xs font-bold uppercase tracking-wider text-ink-800">
                              {item.title}
                            </p>
                            {isUnread && (
                              <span
                                aria-label="Unread"
                                className="inline-block h-2 w-2 rounded-full bg-teal-600"
                              />
                            )}
                            {item.actionRequired && (
                              <Badge tone="warning">Action needed</Badge>
                            )}
                          </div>
                          <p className="text-xs leading-relaxed text-ink-800">{item.body}</p>
                          <p className="text-[11px] text-ink-500">
                            {new Date(item.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {item.actionHref && item.actionHref.startsWith("/portal#") && (
                          <Button
                            className="min-h-8 px-3 text-xs"
                            onClick={() => {
                              if (isUnread) {
                                void handleMarkRead(item.id);
                              }
                              jumpToSection(item.actionHref!);
                            }}
                            variant="primary"
                          >
                            {item.actionLabel ?? "Go to section"}
                          </Button>
                        )}
                        {isUnread && (
                          <Button
                            className="min-h-8 px-2.5 text-xs"
                            disabled={busyId === item.id}
                            onClick={() => void handleMarkRead(item.id)}
                            variant="secondary"
                          >
                            {busyId === item.id ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <Check className="mr-1 h-3 w-3" />
                            )}
                            Mark read
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <p className="text-xs text-ink-600">
                Page {data.page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  className="min-h-8 px-2.5 text-xs"
                  disabled={loading || data.page <= 1}
                  onClick={() => void loadPage(filter, data.page - 1)}
                  variant="secondary"
                >
                  <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                  Previous
                </Button>
                <Button
                  className="min-h-8 px-2.5 text-xs"
                  disabled={loading || !data.hasMore}
                  onClick={() => void loadPage(filter, data.page + 1)}
                  variant="secondary"
                >
                  Next
                  <ChevronRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
