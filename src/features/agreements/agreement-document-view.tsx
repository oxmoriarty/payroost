"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/utils";

export type AgreementContentLike = {
  summary?: string;
  objective?: string;
  scopeItems?: Array<{
    id?: string;
    title: string;
    description?: string;
    deliverables?: string[];
    acceptanceCriteria?: string[];
    assumptions?: string[];
  }>;
  exclusions?: string[];
  milestones?: Array<{
    id?: string;
    title: string;
    description?: string;
    amountMinor: number;
    currency: string;
    dueDate?: string | null;
    deliverables?: string[];
    acceptanceCriteria?: string[];
  }>;
  timeline?: Array<{
    label: string;
    date?: string | null;
    notes?: string;
  }>;
  clientResponsibilities?: string[];
  freelancerResponsibilities?: string[];
  paymentTerms?: string[] | string;
  revisionPolicy?: string[] | string;
  changeProcess?: string[] | string;
  terminationNotes?: string[];
  disputeResolution?: string[];
  openQuestions?: string[];
  warnings?: string[];
};

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function StringListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="font-display text-lg text-ink-950">{title}</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-800">
        {items.map((item, idx) => (
          <li key={`${title}-${idx}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function AgreementDocumentView({
  content,
  showPrintButton = true,
  disclaimer = "This document summarizes project terms structured in PayRoost. It is not legal advice, and no term triggers automatic approval or payment settlement.",
}: {
  content: AgreementContentLike | null | undefined;
  showPrintButton?: boolean;
  disclaimer?: string;
}) {
  if (!content) {
    return (
      <p className="text-sm text-ink-600">
        Agreement terms are not available for this version.
      </p>
    );
  }

  const exclusions = toStringList(content.exclusions);
  const paymentTerms = toStringList(content.paymentTerms);
  const revisionPolicy = toStringList(content.revisionPolicy);
  const changeProcess = toStringList(content.changeProcess);
  const clientResponsibilities = toStringList(content.clientResponsibilities);
  const freelancerResponsibilities = toStringList(content.freelancerResponsibilities);
  const terminationNotes = toStringList(content.terminationNotes);
  const disputeResolution = toStringList(content.disputeResolution);
  const openQuestions = toStringList(content.openQuestions);
  const warnings = toStringList(content.warnings);
  const milestones = Array.isArray(content.milestones) ? content.milestones : [];
  const scopeItems = Array.isArray(content.scopeItems) ? content.scopeItems : [];
  const timeline = Array.isArray(content.timeline) ? content.timeline : [];

  const totalMinor = milestones.reduce((sum, m) => sum + (Number.isFinite(m.amountMinor) ? m.amountMinor : 0), 0);
  const primaryCurrency = milestones[0]?.currency ?? "USD";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 text-xs leading-relaxed text-amber-950">
        <p className="max-w-2xl">{disclaimer}</p>
        {showPrintButton && typeof window !== "undefined" && (
          <Button
            className="min-h-8 shrink-0 px-3 text-xs print:hidden"
            onClick={() => window.print()}
            type="button"
            variant="secondary"
          >
            <Printer className="mr-1.5 h-3.5 w-3.5" />
            Print / PDF
          </Button>
        )}
      </div>

      <div>
        <h3 className="font-display text-lg text-ink-950">Executive Summary</h3>
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-800">
          {content.summary || "No summary provided."}
        </p>
      </div>

      <div>
        <h3 className="font-display text-lg text-ink-950">Project Objective</h3>
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-800">
          {content.objective || "No objective provided."}
        </p>
      </div>

      {scopeItems.length > 0 && (
        <div>
          <h3 className="font-display text-lg text-ink-950">Scope Items &amp; Acceptance Criteria</h3>
          <div className="mt-3 space-y-4">
            {scopeItems.map((item, idx) => {
              const deliverables = toStringList(item.deliverables);
              const criteria = toStringList(item.acceptanceCriteria);
              const assumptions = toStringList(item.assumptions);
              return (
                <div
                  className="rounded-xl border border-ink-200 bg-ink-50/50 p-4 space-y-2.5"
                  key={item.id || idx}
                >
                  <h4 className="font-semibold text-sm text-ink-950">
                    {idx + 1}. {item.title}
                  </h4>
                  {item.description && (
                    <p className="text-xs leading-relaxed text-ink-700">{item.description}</p>
                  )}
                  {deliverables.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-ink-600">
                        Deliverables
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-800">
                        {deliverables.map((d, dIdx) => (
                          <li key={dIdx}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {criteria.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-teal-800">
                        Acceptance criteria
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-800">
                        {criteria.map((c, cIdx) => (
                          <li key={cIdx}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {assumptions.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-ink-600">
                        Assumptions
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-700">
                        {assumptions.map((a, aIdx) => (
                          <li key={aIdx}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {milestones.length > 0 && (
        <div>
          <h3 className="font-display text-lg text-ink-950">Agreed Milestone Schedule</h3>
          <div className="mt-3 overflow-x-auto rounded-xl border border-ink-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink-50/70">
                <tr className="border-b border-ink-200 text-xs font-bold uppercase tracking-wider text-ink-600">
                  <th className="px-4 py-2.5">Milestone &amp; Deliverables</th>
                  <th className="px-4 py-2.5">Due date</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 bg-white">
                {milestones.map((m, idx) => {
                  const deliverables = toStringList(m.deliverables);
                  const criteria = toStringList(m.acceptanceCriteria);
                  return (
                    <tr key={m.id || idx}>
                      <td className="px-4 py-3 align-top">
                        <p className="font-semibold text-ink-950">{m.title}</p>
                        {m.description && (
                          <p className="mt-0.5 text-xs text-ink-700">{m.description}</p>
                        )}
                        {deliverables.length > 0 && (
                          <p className="mt-1.5 text-xs text-ink-700">
                            <strong>Deliverables:</strong> {deliverables.join(" · ")}
                          </p>
                        )}
                        {criteria.length > 0 && (
                          <p className="mt-1 text-xs text-teal-800">
                            <strong>Acceptance criteria:</strong> {criteria.join(" · ")}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top text-xs text-ink-700 whitespace-nowrap">
                        {m.dueDate ? new Date(m.dueDate).toLocaleDateString() : "Flexible"}
                      </td>
                      <td className="px-4 py-3 align-top text-right font-semibold text-ink-950 whitespace-nowrap">
                        {formatMoney(m.amountMinor, m.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-ink-200 bg-ink-50/50">
                <tr>
                  <td className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-ink-700" colSpan={2}>
                    Total Scheduled Milestones
                  </td>
                  <td className="px-4 py-2.5 text-right font-bold text-ink-950">
                    {formatMoney(totalMinor, primaryCurrency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {timeline.length > 0 && (
        <div>
          <h3 className="font-display text-lg text-ink-950">Timeline Targets</h3>
          <ul className="mt-2 space-y-2">
            {timeline.map((t, idx) => (
              <li className="rounded-lg border border-ink-100 bg-ink-50/50 px-3 py-2 text-sm text-ink-800" key={idx}>
                <span className="font-semibold text-ink-950">{t.label}</span>
                {t.date ? ` · ${new Date(t.date).toLocaleDateString()}` : ""}
                {t.notes ? <p className="mt-0.5 text-xs text-ink-700">{t.notes}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <StringListSection items={exclusions} title="Out of Scope / Exclusions" />
        <StringListSection items={paymentTerms} title="Payment Terms" />
        <StringListSection items={revisionPolicy} title="Revision Policy" />
        <StringListSection items={changeProcess} title="Scope Change Process" />
        <StringListSection items={clientResponsibilities} title="Client Responsibilities" />
        <StringListSection items={freelancerResponsibilities} title="Freelancer Responsibilities" />
        <StringListSection items={terminationNotes} title="Termination Notes" />
        <StringListSection items={disputeResolution} title="Dispute Handling" />
      </div>

      <StringListSection items={openQuestions} title="Open Questions" />
      <StringListSection items={warnings} title="Review Notes" />
    </div>
  );
}
