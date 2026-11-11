"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { APP_NAV_LINKS, isNavLinkActive } from "@/components/app/nav-links";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname() ?? "/app";

  return (
    <aside className="hidden min-h-screen w-64 shrink-0 border-r border-ink-800 bg-ink-950 px-4 py-6 text-white lg:flex lg:flex-col">
      <Brand dark />
      <nav aria-label="Main navigation" className="mt-12 space-y-1">
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
            >
              <Icon aria-hidden="true" size={18} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto rounded-xl border border-white/10 bg-white/5 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-teal-300">Provider-confirmed</p>
        <p className="mt-2 text-sm leading-5 text-slate-300">
          Deliverable acceptance and PayPal payment records stay strictly separated.
        </p>
      </div>
    </aside>
  );
}
