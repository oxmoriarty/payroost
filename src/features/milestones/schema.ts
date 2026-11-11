import { z } from "zod";
import { structuredBriefSchema } from "@/features/briefs/schema";

const shortString = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} cannot exceed ${max} characters`);

const boundedStringList = (maxItems = 20, maxItemLength = 500) =>
  z
    .array(z.string().trim().max(maxItemLength))
    .max(maxItems, `List cannot exceed ${maxItems} items`)
    .nullish()
    .transform((items) => (Array.isArray(items) ? items.filter((item) => item.length > 0) : []));

const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO code");

const isoDateNullableSchema = z
  .string()
  .date()
  .nullish()
  .transform((val) => val ?? null);

/**
 * Schema for an individual milestone within an AI-proposed standalone milestone plan.
 */
export const plannedMilestoneSchema = z.object({
  id: shortString(1, 64, "Milestone ID"),
  position: z.number().int().min(1).max(20),
  title: shortString(2, 140, "Milestone title"),
  description: shortString(1, 3000, "Milestone description"),
  deliverables: z
    .array(shortString(1, 500, "Deliverable"))
    .min(1, "Each milestone must include at least 1 deliverable")
    .max(20, "Milestone deliverables cannot exceed 20 items"),
  acceptanceCriteria: z
    .array(shortString(1, 500, "Acceptance criterion"))
    .min(1, "Each milestone must include at least 1 acceptance criterion")
    .max(20, "Milestone acceptance criteria cannot exceed 20 items"),
  estimatedDuration: z
    .string()
    .trim()
    .max(120, "Estimated duration cannot exceed 120 characters")
    .nullish()
    .transform((val) => (val && val.length > 0 ? val : null)),
  dueDate: isoDateNullableSchema,
  dependsOn: z
    .array(z.string().trim().min(1).max(64))
    .max(19, "Dependencies cannot exceed 19 milestones")
    .nullish()
    .transform((items) => (Array.isArray(items) ? items : [])),
  proposedAmountMinor: z
    .number()
    .int("Proposed amount must be an integer in minor units")
    .positive("Proposed amount must be positive when assigned")
    .max(9_000_000_000_000)
    .nullable(),
  currency: currencyCodeSchema.nullable(),
  assumptions: boundedStringList(20, 500),
  openQuestions: boundedStringList(20, 500),
});

export type PlannedMilestone = z.infer<typeof plannedMilestoneSchema>;

/**
 * Bounded Zod schema for the complete AI-4 standalone milestone plan output.
 */
export const milestonePlanSchema = z.object({
  overallTimelineEstimate: z
    .string()
    .trim()
    .max(300, "Overall timeline estimate cannot exceed 300 characters")
    .nullish()
    .transform((val) => (val && val.length > 0 ? val : null)),
  milestoneCount: z.number().int().min(1).max(20),
  allocatesFullBudget: z.boolean(),
  totalProposedAmountMinor: z
    .number()
    .int("Total proposed amount must be an integer in minor units")
    .positive("Total proposed amount must be positive when present")
    .max(9_000_000_000_000)
    .nullable(),
  currency: currencyCodeSchema.nullable(),
  milestones: z
    .array(plannedMilestoneSchema)
    .min(1, "Plan must propose at least 1 milestone")
    .max(20, "Plan cannot exceed 20 milestones"),
  assumptions: boundedStringList(25, 500),
  unresolvedQuestions: boundedStringList(25, 500),
  risksAndDependencies: boundedStringList(25, 500),
});

export type MilestonePlan = z.infer<typeof milestonePlanSchema>;

/**
 * Strict request schema for POST /api/ai/generate-milestones.
 * Deliberately excludes client-supplied budgets, currencies, ownership, or payment states
 * because financial and authorization authority come strictly from server database records.
 */
export const generateMilestonesRequestSchema = z
  .object({
    projectId: z.string().uuid("Invalid project ID format"),
    structuredBrief: structuredBriefSchema.nullish(),
    planningGoal: z.string().trim().max(1000, "Planning goal cannot exceed 1000 characters").optional(),
    includeFinancialAllocation: z.boolean().optional().default(true),
  })
  .strict();

export type GenerateMilestonesRequest = z.infer<typeof generateMilestonesRequestSchema>;

/**
 * Schema for applying a reviewed and edited milestone plan to the project's agreement/milestone workflow.
 */
export const applyMilestoneItemSchema = z
  .object({
    id: z.string().trim().min(1).max(64).optional(),
    title: shortString(2, 140, "Milestone title"),
    description: shortString(1, 1500, "Milestone description"),
    deliverables: z.array(shortString(1, 500, "Deliverable")).min(1).max(20),
    acceptanceCriteria: z.array(shortString(1, 500, "Acceptance criterion")).min(1).max(20),
    amountMinor: z.number().int().positive().max(9_000_000_000_000),
    currency: currencyCodeSchema,
    dueDate: z.string().date().nullable(),
    dependsOn: z.array(z.string().trim().min(1).max(64)).max(19).optional(),
    estimatedDuration: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export const applyMilestonePlanRequestSchema = z
  .object({
    milestones: z
      .array(applyMilestoneItemSchema)
      .min(1, "At least one milestone is required")
      .max(20, "Cannot apply more than 20 milestones"),
    source: z.enum(["AI_ASSISTED", "AI_EDITED", "MANUAL"]).default("AI_ASSISTED"),
    confirmNewRevision: z.boolean().optional().default(false),
  })
  .strict();

export type ApplyMilestonePlanRequest = z.infer<typeof applyMilestonePlanRequestSchema>;
