import Link from "next/link";
import { CreditCard, FolderKanban, LayoutDashboard, Settings } from "lucide-react";
import { Brand } from "@/components/brand";

const links = [
  ["Overview", "/app", LayoutDashboard],
  ["Projects", "/app/projects", FolderKanban],
  ["Payment operations", "/app/payments", CreditCard],
  ["Settings", "/app/settings", Settings],
] as const;

export function Sidebar() {
  return <aside className="hidden min-h-screen w-64 shrink-0 border-r border-ink-800 bg-ink-950 px-4 py-6 text-white lg:flex lg:flex-col"><Brand dark /><nav aria-label="Main navigation" className="mt-12 space-y-1">{links.map(([label, href, Icon]) => <Link className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-white/8 hover:text-white" href={href} key={href}><Icon aria-hidden="true" size={18} />{label}</Link>)}</nav><div className="mt-auto rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-xs font-bold uppercase tracking-[0.12em] text-teal-300">Sandbox-aware</p><p className="mt-2 text-sm leading-5 text-slate-300">Payment records will show provider-confirmed states only.</p></div></aside>;
}
