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
  return <main className="min-h-screen overflow-hidden bg-[#f6f5f0]">
    <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-8"><Brand /><nav className="flex items-center gap-2"><Link className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-100" href="/login">Sign in</Link><Link href="/signup"><Button>Get started <ArrowRight className="ml-2" size={16} /></Button></Link></nav></header>
    <section className="relative mx-auto max-w-7xl px-6 pb-20 pt-16 lg:px-8 lg:pb-28 lg:pt-24">
      <div className="absolute right-[-8rem] top-8 size-[32rem] rounded-full bg-teal-50 blur-3xl" aria-hidden="true" />
      <div className="relative max-w-4xl"><p className="mb-6 inline-flex rounded-full border border-teal-600/15 bg-teal-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] text-teal-700">Freelance work, made clearer</p><h1 className="font-display text-5xl leading-[0.96] tracking-[-0.04em] text-ink-950 sm:text-6xl lg:text-8xl">A stronger start for every client project.</h1><p className="mt-7 max-w-2xl text-lg leading-8 text-ink-700">Payroost gives freelancers one calm place to shape agreements, track milestones, and keep payment records visible—without pretending to hold your funds.</p><div className="mt-9 flex flex-wrap gap-3"><Link href="/signup"><Button className="px-5">Create your workspace <ArrowRight className="ml-2" size={16} /></Button></Link><Link href="/login"><Button variant="secondary">Sign in to Payroost</Button></Link></div></div>
      <div className="relative mt-16 grid gap-4 md:grid-cols-3">{steps.map(([Icon, title, description], index) => <Card className="p-6" key={title as string}><span className="mb-7 inline-flex size-10 items-center justify-center rounded-xl bg-ink-50 text-teal-700"><Icon size={20} /></span><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink-700">0{index + 1}</p><h2 className="mt-2 font-display text-2xl text-ink-950">{title as string}</h2><p className="mt-3 leading-6 text-ink-700">{description as string}</p></Card>)}</div>
    </section>
    <footer className="border-t border-ink-100 px-6 py-6 text-center text-sm text-ink-700">Payroost records payment events; it does not provide escrow or custody.</footer>
  </main>;
}
