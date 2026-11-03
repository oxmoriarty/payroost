import "server-only";
import { createHash } from "node:crypto";
import type { AgreementDraft } from "@/features/agreements/schema";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agreementContentHash(content: AgreementDraft) {
  return createHash("sha256").update(stable(content), "utf8").digest("hex");
}

export function manualAgreementDraft(input: { title: string; brief: string; clientName: string; currency: string; totalAmountMinor: number; endDate: string | null }): AgreementDraft {
  return {
    summary: `Working draft for ${input.title}. Review and complete every section before sending.`,
    objective: input.brief,
    scopeItems: [{ id: "scope-1", title: input.title, description: input.brief, deliverables: [], acceptanceCriteria: [], assumptions: [] }],
    exclusions: [],
    milestones: [{ id: "milestone-1", title: "Project milestone", description: "Proposed milestone — review before sending.", amountMinor: input.totalAmountMinor, currency: input.currency, dueDate: input.endDate, deliverables: [], acceptanceCriteria: [] }],
    timeline: [], clientResponsibilities: [], freelancerResponsibilities: [], paymentTerms: [`Proposed total: ${input.totalAmountMinor} minor units of ${input.currency}. Confirm the allocation before sending.`],
    revisionPolicy: [], changeProcess: ["Any scope or term change must be reviewed and recorded in a new agreement version."],
    terminationNotes: [], disputeResolution: ["This is a project workflow draft, not legal advice or a legal determination."],
    openQuestions: ["Confirm deliverables, acceptance criteria, dates, and revision expectations before sending."], warnings: ["AI-generated or manual draft — review before sending."],
  };
}
