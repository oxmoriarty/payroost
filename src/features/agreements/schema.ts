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
  title: z.string().trim().min(2, "Project title must be at least 2 characters.").max(140, "Project title must be 140 characters or less."),
  clientName: z.string().trim().min(2, "Client name must be at least 2 characters.").max(140, "Client name must be 140 characters or less."),
  clientEmail: z.string().trim().email("Enter a valid client email address.").max(320, "Client email must be 320 characters or less."),
  brief: z.string().trim().min(20, "Project brief must be at least 20 characters.").max(20000, "Project brief must be 20,000 characters or less."),
  totalAmountMinor: z.coerce
    .number()
    .int("Total amount must be a whole number in minor units.")
    .positive("Total amount must be greater than zero.")
    .max(9_000_000_000_000, "Total amount exceeds the supported maximum."),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Select a valid 3-letter currency code."),
  startDate: z.string().date("Start date must be a valid YYYY-MM-DD date.").optional().or(z.literal("")),
  targetEndDate: z.string().date("Target end date must be a valid YYYY-MM-DD date.").optional().or(z.literal("")),
}).refine(
  (data) => !data.startDate || !data.targetEndDate || data.targetEndDate >= data.startDate,
  {
    message: "Target end date must be on or after the start date.",
    path: ["targetEndDate"],
  },
);

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
