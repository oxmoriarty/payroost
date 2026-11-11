"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, Bell, CheckCircle2, Info, LogOut, Menu, X } from "lucide-react";
import { Brand } from "@/components/brand";
import { APP_NAV_LINKS, isNavLinkActive } from "@/components/app/nav-links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkspaceNotification } from "@/features/projects/types";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  userLabel?: string;
  userEmail?: string | null;
  notifications?: WorkspaceNotification[];
};

export function AppHeader({
  userLabel = "Freelancer",
  userEmail = null,
  notifications = [],
}: AppHeaderProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app";
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);

  const warningCount = notifications.filter((n) => n.tone === "warning").length;
  const badgeCount = notifications.length;

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
          <div className="lg:hidden">
            <Brand compact />
          </div>
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
                    warningCount > 0 ? "bg-amber-600" : "bg-teal-600",
                  )}
                >
                  {badgeCount > 9 ? "9+" : badgeCount}
                </span>
              )}
            </button>

            {notificationsOpen && (
              <div
                aria-label="Workspace notifications"
                className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-ink-200 bg-white p-4 shadow-xl sm:w-96"
                role="dialog"
              >
                <div className="flex items-center justify-between border-b border-ink-100 pb-3">
                  <div>
                    <h2 className="font-display text-base font-semibold text-ink-950">
                      Workspace notifications
                    </h2>
                    <p className="text-xs text-ink-600">
                      Actionable items derived from project state
                    </p>
                  </div>
                  <Badge tone={warningCount > 0 ? "warning" : "neutral"}>
                    {badgeCount} {badgeCount === 1 ? "item" : "items"}
                  </Badge>
                </div>

                {notifications.length === 0 ? (
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
              <Brand dark />
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
