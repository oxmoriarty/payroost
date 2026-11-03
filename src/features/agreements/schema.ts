import { z } from "zod";

const line = z.string().trim().min(1).max(2000);

export const agreementDraftSchema = z.object({
  summary: line.max(3000),
  objective: line.max(1500),
  scopeItems: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    title: line.max(180),
    description: line.max(3000),
    deliverables: z.array(line.max(500)).max(30),
    acceptanceCriteria: z.array(line.max(500)).max(30),
    assumptions: z.array(line.max(500)).max(30),
  })).min(1).max(20),
  exclusions: z.array(line.max(800)).max(30),
  milestones: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    title: line.max(180),
    description: line.max(1500),
    amountMinor: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    dueDate: z.string().date().nullable(),
    deliverables: z.array(line.max(500)).max(30),
    acceptanceCriteria: z.array(line.max(500)).max(30),
  })).min(1).max(20),
  timeline: z.array(z.object({ label: line.max(160), date: z.string().date().nullable(), notes: z.string().trim().max(1000) })).max(20),
  clientResponsibilities: z.array(line.max(600)).max(20),
  freelancerResponsibilities: z.array(line.max(600)).max(20),
  paymentTerms: z.array(line.max(800)).max(20),
  revisionPolicy: z.array(line.max(800)).max(20),
  changeProcess: z.array(line.max(800)).max(20),
  terminationNotes: z.array(line.max(800)).max(20),
  disputeResolution: z.array(line.max(800)).max(10),
  openQuestions: z.array(line.max(500)).max(20),
  warnings: z.array(line.max(500)).max(20),
});

export type AgreementDraft = z.infer<typeof agreementDraftSchema>;

export const projectInputSchema = z.object({
  title: z.string().trim().min(2).max(140),
  clientName: z.string().trim().min(2).max(140),
  clientEmail: z.string().trim().email().max(320),
  brief: z.string().trim().min(20).max(20000),
  totalAmountMinor: z.coerce.number().int().positive().max(9_000_000_000_000),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  startDate: z.string().date().optional().or(z.literal("")),
  targetEndDate: z.string().date().optional().or(z.literal("")),
});

export const milestoneInputSchema = z.object({
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().max(5000),
  deliverables: z.array(z.string().trim().min(1).max(500)).max(30),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  dueDate: z.string().date().nullable(),
  status: z.enum(["DRAFT", "AWAITING_APPROVAL", "APPROVED", "IN_PROGRESS", "SUBMITTED", "ACCEPTED", "CHANGES_REQUESTED", "CANCELLED"]),
});

export const agreementVersionUpdateSchema = z.object({ content: agreementDraftSchema });
