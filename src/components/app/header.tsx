"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  CheckCircle2,
  Info,
  Loader2,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { APP_NAV_LINKS, isNavLinkActive } from "@/components/app/nav-links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchAppCsrfToken } from "@/features/notifications/client-csrf";
import type { NotificationRecord } from "@/features/notifications/types";
import type { WorkspaceNotification } from "@/features/projects/types";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  userLabel?: string;
  userEmail?: string | null;
  notifications?: WorkspaceNotification[];
  persistentNotifications?: NotificationRecord[];
  unreadCount?: number;
  actionRequiredCount?: number;
};

export function AppHeader({
  userLabel = "Freelancer",
  userEmail = null,
  notifications = [],
  persistentNotifications,
  unreadCount,
  actionRequiredCount,
}: AppHeaderProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app";
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);

  const isPersistentMode = persistentNotifications !== undefined;
  const [readOverrides, setReadOverrides] = useState<Record<string, string>>({});
  const [markAllState, setMarkAllState] = useState<{
    snapshot: NotificationRecord[] | undefined;
    timestamp: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const markedAllActive =
    markAllState !== null && markAllState.snapshot === persistentNotifications;

  const items: NotificationRecord[] = (persistentNotifications ?? []).map((item) => ({
    ...item,
    readAt:
      item.readAt ??
      readOverrides[item.id] ??
      (markedAllActive ? markAllState.timestamp : null),
  }));

  const baseUnread =
    unreadCount ?? (persistentNotifications ?? []).filter((n) => !n.readAt).length;
  const newlyMarkedCount = markedAllActive
    ? baseUnread
    : (persistentNotifications ?? []).filter(
        (n) => !n.readAt && Boolean(readOverrides[n.id]),
      ).length;
  const unread = Math.max(0, baseUnread - newlyMarkedCount);

  const legacyWarningCount = notifications.filter((n) => n.tone === "warning").length;
  const hasUrgentPersistent =
    (actionRequiredCount ?? 0) > 0 ||
    items.some(
      (item) =>
        !item.readAt && (item.actionRequired || item.severity === "WARNING" || item.severity === "ACTION_REQUIRED"),
    );

  const badgeCount = isPersistentMode ? unread : notifications.length;
  const isWarningBadge = isPersistentMode ? hasUrgentPersistent : legacyWarningCount > 0;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        setNotificationsOpen(false);
      }
    }
    function handleClickOutside(event: MouseEvent) {
      if (
        notificationsRef.current &&
        event.target instanceof Node &&
        !notificationsRef.current.contains(event.target)
      ) {
        setNotificationsOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  async function signOut() {
    try {
      await createClient().auth.signOut();
    } finally {
      router.push("/");
      router.refresh();
    }
  }

  async function handleMarkRead(notificationId: string) {
    setActionError(null);
    setBusyId(notificationId);
    try {
      const csrfToken = await fetchAppCsrfToken();
      const response = await fetch(`/api/app/notifications/${encodeURIComponent(notificationId)}/read`, {
        method: "PATCH",
        headers: {
          "x-csrf-token": csrfToken,
        },
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error("Unable to mark notification as read.");
      }
      const payload = (await response.json()) as { data?: NotificationRecord };
      const updatedReadAt = payload.data?.readAt ?? new Date().toISOString();
      setReadOverrides((prev) => ({
        ...prev,
        [notificationId]: prev[notificationId] ?? updatedReadAt,
      }));
      router.refresh();
    } catch {
      setActionError("Could not update notification status. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleMarkAllRead() {
    if (unread === 0) return;
    setActionError(null);
    setMarkingAll(true);
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
      setMarkAllState({
        snapshot: persistentNotifications,
        timestamp: now,
      });
      router.refresh();
    } catch {
      setActionError("Could not mark all notifications read. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  }

  const urgentItems = items.filter((item) => !item.readAt && (item.actionRequired || item.severity === "ACTION_REQUIRED"));
  const urgentIds = new Set(urgentItems.map((i) => i.id));
  const otherItems = items.filter((item) => !urgentIds.has(item.id));

  function renderPersistentItem(item: NotificationRecord) {
    const isUnread = !item.readAt;
    const isWarning = item.severity === "WARNING" || item.severity === "ACTION_REQUIRED";
    return (
      <li
        className={cn(
          "rounded-xl border p-3 transition",
          isUnread
            ? isWarning
              ? "border-amber-300/80 bg-amber-50/40"
              : "border-teal-500/40 bg-teal-50/35"
            : "border-ink-100 bg-white opacity-85",
        )}
        key={item.id}
      >
        <div className="flex items-start gap-2.5">
          {isWarning ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          ) : item.severity === "SUCCESS" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold uppercase tracking-wider text-ink-800">
                {item.title}
              </p>
              {isUnread && (
                <span
                  aria-label="Unread"
                  className="h-2 w-2 shrink-0 rounded-full bg-teal-600"
                />
              )}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-800">{item.body}</p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-ink-500">
                {new Date(item.createdAt).toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                {isUnread && (
                  <button
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-ink-600 hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
                    disabled={busyId === item.id}
                    onClick={() => void handleMarkRead(item.id)}
                    type="button"
                  >
                    {busyId === item.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Mark read
                  </button>
                )}
                {item.actionHref && (
                  <Link
                    className="text-[11px] font-semibold text-teal-700 hover:underline"
                    href={item.actionHref}
                    onClick={() => {
                      if (isUnread) {
                        void handleMarkRead(item.id);
                      }
                      setNotificationsOpen(false);
                    }}
                  >
                    {item.actionLabel ?? "Open"} →
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </li>
    );
  }

  return (
    <>
      <header className="relative z-30 flex min-h-20 items-center justify-between border-b border-ink-100 bg-[#f6f5f0]/85 px-5 backdrop-blur sm:px-8">
        <div className="flex items-center gap-3">
          <button
            aria-expanded={mobileNavOpen}
            aria-label="Open navigation"
            className="rounded-lg p-2 text-ink-700 hover:bg-ink-100 lg:hidden"
            onClick={() => setMobileNavOpen(true)}
            type="button"
          >
            <Menu size={20} />
          </button>
          <Link className="inline-flex items-center lg:hidden" href="/app">
            <Brand compact />
          </Link>
          <div className="hidden lg:block">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-ink-700">
              Freelancer workspace{userEmail ? ` · ${userEmail}` : ""}
            </p>
            <p className="mt-1 font-display text-xl text-ink-950">Welcome back, {userLabel}</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative" ref={notificationsRef}>
            <button
              aria-expanded={notificationsOpen}
              aria-label={`Notifications (${badgeCount})`}
              className="relative rounded-xl p-2.5 text-ink-700 transition hover:bg-ink-100"
              onClick={() => setNotificationsOpen((prev) => !prev)}
              type="button"
            >
              <Bell size={18} />
              {badgeCount > 0 && (
                <span
                  className={cn(
                    "absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white",
                    isWarningBadge ? "bg-amber-600" : "bg-teal-600",
                  )}
                >
                  {badgeCount > 9 ? "9+" : badgeCount}
                </span>
              )}
            </button>

            {notificationsOpen && (
              <div
                aria-label="Workspace notifications"
                className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-ink-200 bg-white p-4 shadow-xl sm:w-[26rem]"
                role="dialog"
              >
                <div className="flex items-center justify-between gap-2 border-b border-ink-100 pb-3">
                  <div>
                    <h2 className="font-display text-base font-semibold text-ink-950">
                      Workspace notifications
                    </h2>
                    <p className="text-xs text-ink-600">
                      {isPersistentMode
                        ? "Persistent workspace & payment alerts"
                        : "Actionable items derived from project state"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={isWarningBadge ? "warning" : "neutral"}>
                      {badgeCount} {isPersistentMode ? "unread" : badgeCount === 1 ? "item" : "items"}
                    </Badge>
                    {isPersistentMode && unread > 0 && (
                      <button
                        className="inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-[11px] font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                        disabled={markingAll}
                        onClick={() => void handleMarkAllRead()}
                        type="button"
                      >
                        {markingAll ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCheck className="h-3 w-3" />
                        )}
                        Mark all
                      </button>
                    )}
                  </div>
                </div>

                {actionError && (
                  <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
                    {actionError}
                  </p>
                )}

                {isPersistentMode ? (
                  items.length === 0 && notifications.length === 0 ? (
                    <div className="py-8 text-center">
                      <CheckCircle2 className="mx-auto h-7 w-7 text-teal-600" />
                      <p className="mt-2 text-sm font-medium text-ink-900">All caught up</p>
                      <p className="mt-1 text-xs text-ink-600">
                        No unread updates or pending workspace actions right now.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-3 max-h-80 space-y-3 overflow-y-auto pr-1">
                      {urgentItems.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-800">
                            Action Required ({urgentItems.length})
                          </p>
                          <ul className="space-y-2">{urgentItems.map(renderPersistentItem)}</ul>
                        </div>
                      )}
                      {otherItems.length > 0 && (
                        <div>
                          {urgentItems.length > 0 && (
                            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-600">
                              Recent Updates
                            </p>
                          )}
                          <ul className="space-y-2">{otherItems.map(renderPersistentItem)}</ul>
                        </div>
                      )}
                      {items.length === 0 && notifications.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-600">
                            Active Workflow Reminders
                          </p>
                          <ul className="space-y-2">
                            {notifications.map((item) => (
                              <li key={item.id}>
                                <Link
                                  className="flex items-start gap-3 rounded-xl border border-ink-100 p-3 transition hover:border-teal-500/40 hover:bg-teal-50/40"
                                  href={item.href}
                                  onClick={() => setNotificationsOpen(false)}
                                >
                                  {item.tone === "warning" ? (
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                                  ) : (
                                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-bold uppercase tracking-wider text-ink-700">
                                      {item.title}
                                    </p>
                                    <p className="mt-0.5 text-sm text-ink-900">{item.description}</p>
                                  </div>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )
                ) : notifications.length === 0 ? (
                  <div className="py-8 text-center">
                    <CheckCircle2 className="mx-auto h-7 w-7 text-teal-600" />
                    <p className="mt-2 text-sm font-medium text-ink-900">All caught up</p>
                    <p className="mt-1 text-xs text-ink-600">
                      No pending client verifications, open scope requests, or returned work.
                    </p>
                  </div>
                ) : (
                  <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                    {notifications.map((item) => (
                      <li key={item.id}>
                        <Link
                          className="flex items-start gap-3 rounded-xl border border-ink-100 p-3 transition hover:border-teal-500/40 hover:bg-teal-50/40"
                          href={item.href}
                          onClick={() => setNotificationsOpen(false)}
                        >
                          {item.tone === "warning" ? (
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                          ) : (
                            <Info className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-bold uppercase tracking-wider text-ink-700">
                              {item.title}
                            </p>
                            <p className="mt-0.5 text-sm text-ink-900">{item.description}</p>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 border-t border-ink-100 pt-2.5 text-center">
                  <Link
                    className="text-xs font-semibold text-teal-700 hover:underline"
                    href="/app/notifications"
                    onClick={() => setNotificationsOpen(false)}
                  >
                    Open notification center →
                  </Link>
                </div>
              </div>
            )}
          </div>

          <Button aria-label="Sign out" onClick={signOut} variant="secondary">
            <LogOut size={16} />
            <span className="ml-2 hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      {mobileNavOpen && (
        <div
          aria-label="Mobile navigation"
          aria-modal="true"
          className="fixed inset-0 z-50 flex lg:hidden"
          role="dialog"
        >
          <div
            className="fixed inset-0 bg-ink-950/60 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative z-10 flex w-72 max-w-[82vw] flex-col bg-ink-950 px-5 py-6 text-white shadow-2xl">
            <div className="flex items-center justify-between">
              <Link
                className="inline-flex items-center"
                href="/app"
                onClick={() => setMobileNavOpen(false)}
              >
                <Brand dark size="sm" />
              </Link>
              <button
                aria-label="Close navigation"
                className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
                onClick={() => setMobileNavOpen(false)}
                type="button"
              >
                <X size={20} />
              </button>
            </div>
            <p className="mt-6 text-xs text-slate-400">Signed in as {userLabel}</p>
            <nav aria-label="Mobile workspace navigation" className="mt-4 space-y-1">
              {APP_NAV_LINKS.map(({ label, href, icon: Icon, exact }) => {
                const active = isNavLinkActive(pathname, href, exact);
                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition",
                      active
                        ? "bg-teal-600/20 text-white ring-1 ring-inset ring-teal-400/30"
                        : "text-slate-300 hover:bg-white/8 hover:text-white",
                    )}
                    href={href}
                    key={href}
                    onClick={() => setMobileNavOpen(false)}
                  >
                    <Icon aria-hidden="true" size={18} />
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
