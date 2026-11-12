import Link from "next/link";
import { ArrowRight, CheckCircle2, FileCheck2, WalletCards } from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const steps = [
  [FileCheck2, "Agree on the work", "Turn a brief into a clear, reviewable agreement."],
  [CheckCircle2, "Track the milestones", "Keep deliverables, acceptance, and activity in one place."],
  [WalletCards, "See the payment record", "View provider-confirmed payment history alongside the work."],
];

export default function LandingPage() {
  return <main className="min-h-[100dvh] overflow-x-clip bg-[#f6f5f0]">
    <header className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:gap-4 sm:px-6 sm:py-6 lg:px-8"><Link className="inline-flex shrink-0 items-center" href="/"><Brand /></Link><nav className="flex items-center gap-1.5 sm:gap-2"><Link className="whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-100 sm:px-3" href="/login">Sign in</Link><Link href="/signup"><Button className="whitespace-nowrap px-3 text-xs sm:px-4 sm:text-sm">Get started <ArrowRight className="ml-1.5 sm:ml-2" size={16} /></Button></Link></nav></header>
    <section className="relative mx-auto max-w-7xl px-4 pb-16 pt-10 sm:px-6 sm:pb-20 sm:pt-16 lg:px-8 lg:pb-28 lg:pt-24">
      <div className="pointer-events-none absolute right-[-8rem] top-8 size-[22rem] rounded-full bg-teal-50 blur-3xl sm:size-[32rem]" aria-hidden="true" />
      <div className="relative max-w-4xl"><p className="mb-5 inline-flex rounded-full border border-teal-600/15 bg-teal-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700 sm:mb-6 sm:text-xs">Freelance work, made clearer</p><h1 className="font-display text-4xl leading-[0.98] tracking-[-0.04em] text-ink-950 sm:text-6xl lg:text-8xl">A stronger start for every client project.</h1><p className="mt-5 max-w-2xl text-base leading-7 text-ink-700 sm:mt-7 sm:text-lg sm:leading-8">Payroost gives freelancers one calm place to shape agreements, track milestones, and keep payment records visible—without pretending to hold your funds.</p><div className="mt-7 flex flex-col gap-3 sm:mt-9 sm:flex-row sm:flex-wrap"><Link className="w-full sm:w-auto" href="/signup"><Button className="w-full px-5 sm:w-auto">Create your workspace <ArrowRight className="ml-2" size={16} /></Button></Link><Link className="w-full sm:w-auto" href="/login"><Button className="w-full sm:w-auto" variant="secondary">Sign in to Payroost</Button></Link></div></div>
      <div className="relative mt-12 grid gap-4 sm:mt-16 md:grid-cols-3">{steps.map(([Icon, title, description], index) => <Card className="p-5 sm:p-6" key={title as string}><span className="mb-5 inline-flex size-10 items-center justify-center rounded-xl bg-ink-50 text-teal-700 sm:mb-7"><Icon size={20} /></span><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink-700">0{index + 1}</p><h2 className="mt-2 font-display text-xl text-ink-950 sm:text-2xl">{title as string}</h2><p className="mt-2.5 text-sm leading-6 text-ink-700 sm:mt-3 sm:text-base">{description as string}</p></Card>)}</div>
    </section>
    <footer className="border-t border-ink-100 px-4 py-6 text-center text-xs text-ink-700 sm:px-6 sm:text-sm">Payroost records payment events; it does not provide escrow or custody.</footer>
  </main>;
}
