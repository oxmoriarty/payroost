import Link from "next/link";
import { Brand } from "@/components/brand";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <main className="grid min-h-screen bg-[#f6f5f0] lg:grid-cols-[1fr_0.85fr]"><section className="hidden bg-ink-950 p-10 text-white lg:flex lg:flex-col"><Brand dark /><div className="my-auto max-w-md"><p className="text-sm font-bold uppercase tracking-[0.16em] text-teal-300">A better project rhythm</p><h1 className="mt-5 font-display text-5xl leading-tight">Work with fewer loose ends.</h1><p className="mt-5 text-lg leading-8 text-slate-300">Create the shared record before the work gets busy. Payroost is designed for clear human decisions, not automated financial promises.</p></div><p className="text-sm text-slate-400">© {new Date().getFullYear()} Payroost</p></section><section className="flex p-6 sm:p-10 lg:items-center lg:justify-center"><div className="w-full max-w-md"><Link className="lg:hidden" href="/"><Brand /></Link><div className="mt-16 lg:mt-0">{children}</div></div></section></main>;
}
