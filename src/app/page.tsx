import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { LiveWorkspaceTime, Reveal } from "@/components/ui/motion";
import { WorkflowShowcase } from "@/components/landing/workflow-showcase";

export default function LandingPage() {
  return (
    <main className="min-h-[100dvh] overflow-x-clip bg-[#f6f5f0] text-ink-950">
      {/* Top editorial navigation */}
      <header className="sticky top-0 z-40 border-b border-ink-100/80 bg-[#f6f5f0]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
          <div className="flex items-center gap-8">
            <Link className="inline-flex shrink-0 items-center" href="/">
              <Brand size="sm" />
            </Link>
            <nav aria-label="Primary navigation" className="hidden items-center gap-6 md:flex">
              <a
                className="text-sm font-medium text-ink-700 transition-colors hover:text-ink-950"
                href="#overview"
              >
                Overview
              </a>
              <a
                className="text-sm font-medium text-ink-700 transition-colors hover:text-ink-950"
                href="#spaces"
              >
                Spaces
              </a>
              <a
                className="text-sm font-medium text-ink-700 transition-colors hover:text-ink-950"
                href="#flow"
              >
                Workflow
              </a>
              <Link
                className="text-sm font-medium text-ink-700 transition-colors hover:text-ink-950"
                href="/login"
              >
                Sign in
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-3 sm:gap-5">
            <LiveWorkspaceTime />
            <span className="hidden items-center gap-2 text-xs font-medium text-ink-700 lg:inline-flex">
              <span className="relative flex size-2" aria-hidden="true">
                <span className="pr-live-dot absolute inline-flex h-full w-full rounded-full bg-teal-600/60" />
                <span className="relative inline-flex size-2 rounded-full bg-teal-600" />
              </span>
              Ready for new projects
            </span>
            <Link
              className="group inline-flex items-center gap-2.5 rounded-full bg-ink-950 py-1.5 pl-4 pr-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-ink-900 hover:text-white active:translate-y-0 active:scale-[0.985] sm:text-sm"
              href="/signup"
            >
              <span className="text-white">Create workspace</span>
              <span className="grid size-7 place-items-center rounded-full bg-white text-ink-950 transition-transform duration-200 group-hover:translate-x-0.5">
                <ArrowRight size={14} aria-hidden="true" />
              </span>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero band with calm architectural light ribbons */}
      <section className="relative overflow-hidden border-b border-ink-100/90 bg-gradient-to-b from-[#faf9f5] via-[#f6f5f0] to-[#f2f1eb]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div className="pr-hero-beam absolute -left-24 -top-48 h-[46rem] w-44 bg-gradient-to-b from-white/80 via-white/35 to-transparent blur-xl sm:w-64" />
          <div
            className="pr-hero-beam absolute left-[28%] -top-56 h-[50rem] w-48 bg-gradient-to-b from-white/85 via-teal-50/45 to-transparent blur-xl sm:w-72"
            style={{ animationDelay: "-4s" }}
          />
          <div
            className="pr-hero-beam absolute right-[10%] -top-40 h-[44rem] w-40 bg-gradient-to-b from-white/75 via-teal-50/35 to-transparent blur-xl sm:w-60"
            style={{ animationDelay: "-7s" }}
          />
        </div>

        <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-20 sm:px-6 sm:pb-24 sm:pt-32 lg:px-8 lg:pb-28 lg:pt-44">
          <div className="pr-page-enter max-w-4xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700 sm:text-sm">
              Payroost Studio Workspace
            </p>
            <h1 className="mt-4 font-display text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-ink-950 sm:text-6xl lg:text-[4.35rem]">
              Clear agreements and milestone records for independent work.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-ink-700 sm:mt-6 sm:text-lg sm:leading-8">
              Shape written project terms, track each deliverable phase, and keep confirmed payment records visible for both you and your client.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-10 sm:gap-4">
              <Link
                className="group inline-flex items-center gap-3 rounded-full bg-teal-600 py-2 pl-5 pr-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md active:translate-y-0 active:scale-[0.985]"
                href="/signup"
              >
                <span>Start a project</span>
                <span className="grid size-7 place-items-center rounded-full bg-white text-teal-700 transition-transform duration-200 group-hover:translate-x-0.5">
                  <ArrowRight size={15} aria-hidden="true" />
                </span>
              </Link>

              <Link
                className="inline-flex items-center gap-2.5 rounded-full border border-ink-200/90 bg-white/95 px-4 py-2 text-xs font-semibold text-ink-800 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-ink-300 hover:bg-white sm:text-sm"
                href="/login"
              >
                <ShieldCheck className="size-4 text-teal-700" aria-hidden="true" />
                <span>Verified PayPal records</span>
                <span className="rounded-md bg-ink-950 px-2 py-0.5 text-[11px] font-semibold text-white">
                  Sign in
                </span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Section 1: Editorial Asymmetric Split & Studio Photography */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 lg:py-28" id="overview">
        <Reveal>
          <div className="flex items-center gap-3">
            <span className="grid size-6 place-items-center rounded-full bg-ink-950 text-[11px] font-bold text-white">
              1
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-700">
              Introducing Payroost
            </p>
          </div>

          <h2 className="mt-5 max-w-3xl font-display text-3xl font-semibold leading-[1.12] tracking-[-0.03em] text-ink-950 sm:text-5xl">
            Calm structure before the work begins.
          </h2>
        </Reveal>

        <div className="mt-10 grid gap-6 sm:mt-14 lg:grid-cols-12 lg:items-end lg:gap-8">
          <Reveal className="lg:col-span-3" delayMs={80}>
            <div className="pr-media-zoom overflow-hidden rounded-2xl border border-ink-200/70 bg-white shadow-xs">
              <Image
                alt="Independent designer reviewing a project scope on a laptop at a sunny oak desk"
                className="aspect-[4/3] w-full object-cover"
                height={900}
                src="/images/landing/studio-desk.jpg"
                width={1200}
              />
            </div>
          </Reveal>

          <Reveal className="lg:col-span-3 lg:pb-6" delayMs={150}>
            <p className="text-sm leading-6 text-ink-700 sm:text-base sm:leading-7">
              Turn early client conversations into a structured agreement, shared deliverable phases, and an honest record of every approval.
            </p>
            <a
              className="group mt-6 inline-flex items-center gap-2.5 rounded-full border border-ink-200 bg-white py-1.5 pl-4 pr-1.5 text-sm font-semibold text-ink-950 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-600/40 active:translate-y-0"
              href="#spaces"
            >
              <span>Explore workspaces</span>
              <span className="grid size-7 place-items-center rounded-full bg-teal-600 text-white transition-transform duration-200 group-hover:translate-x-0.5">
                <ArrowRight size={14} aria-hidden="true" />
              </span>
            </a>
          </Reveal>

          <Reveal className="lg:col-span-6" delayMs={220}>
            <div className="pr-media-zoom overflow-hidden rounded-2xl border border-ink-200/70 bg-white shadow-sm">
              <Image
                alt="Freelancer and client planning project milestones together in a bright studio"
                className="aspect-[16/10] w-full object-cover"
                height={1000}
                src="/images/landing/team-planning.jpg"
                width={1600}
              />
            </div>
          </Reveal>
        </div>
      </section>

      {/* Section 2: Featured Showcase Grid (mirrors reference visual showcase) */}
      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 sm:pb-24 lg:px-8 lg:pb-28" id="spaces">
        <Reveal>
          <div className="flex items-center gap-3">
            <span className="grid size-6 place-items-center rounded-full bg-ink-950 text-[11px] font-bold text-white">
              2
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-700">
              Core spaces
            </p>
          </div>

          <h2 className="mt-5 font-display text-3xl font-semibold leading-[1.1] tracking-[-0.03em] text-ink-950 sm:text-5xl">
            Built around real project moments
          </h2>
        </Reveal>

        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:gap-8">
          <Reveal delayMs={80}>
            <Link
              className="group pr-interactive-card pr-media-zoom relative flex h-full flex-col overflow-hidden rounded-3xl border border-ink-800 bg-ink-950 text-white"
              href="/signup"
            >
              <div className="relative overflow-hidden">
                <Image
                  alt="Smooth interlocking teal glass milestone modules in studio light"
                  className="aspect-[4/3] w-full object-cover"
                  height={900}
                  src="/images/landing/milestone-3d.jpg"
                  width={1200}
                />
                <span className="absolute left-5 top-5 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-ink-950/75 px-3 py-1 text-xs font-semibold text-teal-50 backdrop-blur">
                  <CheckCircle2 className="size-3.5 text-teal-400" aria-hidden="true" />
                  Milestones
                </span>
              </div>
              <div className="flex flex-1 flex-col justify-between p-6 sm:p-8">
                <div>
                  <h3 className="font-display text-2xl font-semibold tracking-[-0.02em] text-white sm:text-3xl">
                    Milestones everyone understands
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-slate-300 sm:text-base">
                    Break work into clear phases so your client always knows what is delivered, reviewed, and scheduled next.
                  </p>
                </div>
                <div className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-teal-300">
                  <span>Open a workspace</span>
                  <ArrowRight
                    className="transition-transform duration-200 group-hover:translate-x-1"
                    size={16}
                    aria-hidden="true"
                  />
                </div>
              </div>
            </Link>
          </Reveal>

          <Reveal delayMs={160}>
            <Link
              className="group pr-interactive-card pr-media-zoom relative flex h-full flex-col overflow-hidden rounded-3xl border border-ink-200/80 bg-white text-ink-950"
              href="/signup"
            >
              <div className="relative overflow-hidden bg-ink-50">
                <Image
                  alt="Layered frosted glass cards beside a brushed titanium key on stone"
                  className="aspect-[4/3] w-full object-cover"
                  height={900}
                  src="/images/landing/payment-record.jpg"
                  width={1200}
                />
                <span className="absolute left-5 top-5 inline-flex items-center gap-1.5 rounded-full border border-ink-200/80 bg-white/90 px-3 py-1 text-xs font-semibold text-ink-900 backdrop-blur">
                  <ShieldCheck className="size-3.5 text-teal-700" aria-hidden="true" />
                  Audit trail
                </span>
              </div>
              <div className="flex flex-1 flex-col justify-between p-6 sm:p-8">
                <div>
                  <h3 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink-950 sm:text-3xl">
                    Verified records at every step
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-ink-700 sm:text-base">
                    Keep scope approvals, deliverable acceptance, and confirmed PayPal captures documented cleanly in one timeline.
                  </p>
                </div>
                <div className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-teal-700">
                  <span>Set up client access</span>
                  <ArrowRight
                    className="transition-transform duration-200 group-hover:translate-x-1"
                    size={16}
                    aria-hidden="true"
                  />
                </div>
              </div>
            </Link>
          </Reveal>
        </div>
      </section>

      {/* Section 3: Interactive Workflow Preview */}
      <section className="border-t border-ink-100 bg-white/60 py-16 sm:py-24 lg:py-28" id="flow">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="mb-10 flex items-center gap-3">
              <span className="grid size-6 place-items-center rounded-full bg-ink-950 text-[11px] font-bold text-white">
                3
              </span>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-700">
                Interactive flow
              </p>
            </div>
            <WorkflowShowcase />
          </Reveal>
        </div>
      </section>

      {/* Editorial Closing Band & Footer */}
      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl bg-ink-950 px-6 py-12 text-white shadow-xl sm:px-12 sm:py-16">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-teal-600/20 blur-3xl"
            />
            <div className="relative flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
              <div className="max-w-2xl">
                <Brand dark size="sm" />
                <h2 className="mt-6 font-display text-3xl font-semibold leading-[1.1] tracking-[-0.03em] text-white sm:text-5xl">
                  Ready for your next client project?
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-300 sm:text-lg">
                  Create your workspace in minutes and invite your client once the scope is ready for review.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  className="group inline-flex items-center justify-center gap-3 rounded-full bg-teal-600 py-2.5 pl-6 pr-2.5 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-500 active:translate-y-0"
                  href="/signup"
                >
                  <span>Create your workspace</span>
                  <span className="grid size-7 place-items-center rounded-full bg-white text-teal-700 transition-transform duration-200 group-hover:translate-x-0.5">
                    <ArrowRight size={15} aria-hidden="true" />
                  </span>
                </Link>
                <Link
                  className="inline-flex items-center justify-center rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                  href="/login"
                >
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-ink-100 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-center text-xs text-ink-700 sm:flex-row sm:text-left sm:text-sm">
          <Link className="inline-flex items-center" href="/">
            <Brand compact />
          </Link>
          <p>
            Payroost records payment events and does not hold funds, offer escrow, or act as a custodian.
          </p>
        </div>
      </footer>
    </main>
  );
}
