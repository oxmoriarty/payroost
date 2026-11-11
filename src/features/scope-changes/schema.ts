import { z } from "zod";

const shortString = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} cannot exceed ${max} characters`);

const nullableBoundedString = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} cannot exceed ${max} characters`)
    .nullish()
    .transform((val) => (val && val.length > 0 ? val : null));

const boundedStringList = (maxItems = 20, maxItemLength = 500) =>
  z
    .array(z.string().trim().max(maxItemLength))
    .max(maxItems, `List cannot exceed ${maxItems} items`)
    .nullish()
    .transform((items) => (Array.isArray(items) ? items.filter((item) => item.length > 0) : []));

const boundedObjectArray = <T extends z.ZodTypeAny>(schema: T, maxItems = 25) =>
  z
    .array(schema)
    .max(maxItems, `List cannot exceed ${maxItems} items`)
    .nullish()
    .transform((items) => (Array.isArray(items) ? items : []));

const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO code");

export const scopeChangeOverallClassificationSchema = z.enum([
  "LOW",
  "MODERATE",
  "HIGH",
  "INSUFFICIENT_INFORMATION",
]);

export type ScopeChangeOverallClassification = z.infer<
  typeof scopeChangeOverallClassificationSchema
>;

export const scopeChangeFinancialDirectionSchema = z.enum([
  "INCREASE",
  "DECREASE",
  "UNCHANGED",
  "INSUFFICIENT_INFORMATION",
]);

export const scopeChangeTimelineClassificationSchema = z.enum([
  "NO_MATERIAL_IMPACT",
  "POTENTIAL_EXTENSION",
  "CANNOT_BE_ESTIMATED",
]);

export const affectedDeliverableSchema = z.object({
  scopeItemTitle: shortString(1, 200, "Scope item title"),
  deliverable: shortString(1, 500, "Deliverable"),
  impactType: z.enum(["MODIFIED", "REMOVED", "REPLACED", "AT_RISK", "UNCHANGED_CONTEXT"]),
  explanation: shortString(1, 1000, "Deliverable impact explanation"),
});

export const affectedMilestoneImpactSchema = z.object({
  milestoneTitle: shortString(1, 180, "Milestone title"),
  currentStatus: nullableBoundedString(50, "Milestone status"),
  isPaymentLinkedOrLocked: z.boolean(),
  impactType: z.enum([
    "SCOPE_MODIFIED",
    "DELIVERY_DELAY_RISK",
    "REMOVED_OR_REPLACED",
    "NEEDS_SPLIT_OR_FOLLOWUP",
    "NO_DIRECT_CHANGE",
  ]),
  existingAmountMinor: z.number().int().positive().max(9_000_000_000_000).nullable(),
  currency: currencyCodeSchema.nullable(),
  explanation: shortString(1, 1000, "Milestone impact explanation"),
});

export const proposedNewDeliverableSchema = z.object({
  title: shortString(1, 180, "Proposed deliverable title"),
  description: shortString(1, 1000, "Proposed deliverable description"),
  acceptanceCriteria: boundedStringList(10, 400),
  rationale: shortString(1, 600, "Proposed deliverable rationale"),
});

export const removedOrReplacedWorkSchema = z.object({
  item: shortString(1, 300, "Removed or replaced item"),
  reason: shortString(1, 600, "Removal rationale"),
  replacementNote: nullableBoundedString(600, "Replacement note"),
});

export const proposedAdditionalMilestoneSchema = z.object({
  title: shortString(2, 140, "Proposed milestone title"),
  description: shortString(1, 1000, "Proposed milestone description"),
  deliverables: boundedStringList(15, 400),
  acceptanceCriteria: boundedStringList(15, 400),
  proposedAdditionalAmountMinor: z.number().int().positive().max(9_000_000_000_000).nullable(),
  currency: currencyCodeSchema.nullable(),
  estimatedDuration: nullableBoundedString(120, "Estimated duration"),
});

export const dependencyChangeSchema = z.object({
  description: shortString(1, 600, "Dependency change description"),
  affectedMilestoneTitle: nullableBoundedString(180, "Affected milestone title"),
  dependencyType: z.enum([
    "NEW_PREREQUISITE",
    "BLOCKED_BY_CLIENT",
    "EXTERNAL_DEPENDENCY",
    "REORDERED_SEQUENCE",
    "REMOVED_DEPENDENCY",
  ]),
  blocksPaymentOrCompletion: z.boolean(),
});

export const scopeRiskItemSchema = z.object({
  title: shortString(1, 180, "Risk title"),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  mitigation: shortString(1, 600, "Risk mitigation"),
});

/**
 * Schema validated directly against raw structured AI provider output before deterministic
 * server enrichment, classification, and integrity signing.
 */
export const aiRawScopeChangeOutputSchema = z.object({
  changeSummary: z.object({
    requestedChangeSummary: shortString(1, 1500, "Requested change summary"),
    changeType: z.enum([
      "ADDITION",
      "MODIFICATION",
      "REMOVAL",
      "REPLACEMENT",
      "CLARIFICATION",
      "MIXED",
    ]),
    conflictsOrContradictions: boundedStringList(15, 500),
  }),
  originalAgreementContext: z.object({
    agreementVersionNumber: z.number().int().positive().max(1000),
    agreementStatus: shortString(1, 50, "Agreement status"),
    confirmedBudgetMinor: z.number().int().positive().max(9_000_000_000_000).nullable(),
    currency: currencyCodeSchema.nullable(),
    summaryExcerpt: shortString(1, 1500, "Agreement summary excerpt"),
  }),
  affectedDeliverables: boundedObjectArray(affectedDeliverableSchema, 25),
  affectedMilestones: boundedObjectArray(affectedMilestoneImpactSchema, 25),
  proposedChanges: z.object({
    newDeliverables: boundedObjectArray(proposedNewDeliverableSchema, 20),
    removedOrReplacedWork: boundedObjectArray(removedOrReplacedWorkSchema, 20),
    proposedNewMilestones: boundedObjectArray(proposedAdditionalMilestoneSchema, 15),
  }),
  financialImpact: z.object({
    direction: scopeChangeFinancialDirectionSchema,
    existingAgreedBudgetMinor: z.number().int().positive().max(9_000_000_000_000).nullable(),
    currency: currencyCodeSchema.nullable(),
    proposedCostDeltaMinor: z
      .number()
      .int("Proposed cost delta must be an integer in minor units")
      .min(-9_000_000_000_000)
      .max(9_000_000_000_000)
      .nullable(),
    proposedRevisedTotalMinor: z
      .number()
      .int("Proposed revised total must be an integer in minor units")
      .positive()
      .max(9_000_000_000_000)
      .nullable(),
    costDriversJustification: nullableBoundedString(1500, "Cost drivers justification"),
    reconcilesExistingMilestonesUnchanged: z.boolean(),
  }),
  timelineImpact: z.object({
    classification: scopeChangeTimelineClassificationSchema,
    estimatedAdditionalDaysMin: z.number().int().min(0).max(3650).nullable(),
    estimatedAdditionalDaysMax: z.number().int().min(0).max(3650).nullable(),
    canProceedInParallel: z.boolean().nullable(),
    parallelWorkNotes: nullableBoundedString(800, "Parallel work notes"),
    criticalPathMilestones: boundedStringList(15, 180),
    missingSchedulingInformation: boundedStringList(15, 400),
    explanation: shortString(1, 1200, "Timeline impact explanation"),
  }),
  dependencyChanges: boundedObjectArray(dependencyChangeSchema, 20),
  riskAssessment: boundedObjectArray(scopeRiskItemSchema, 20),
  assumptions: boundedStringList(20, 500),
  unresolvedQuestions: boundedStringList(20, 500),
  recommendedNextSteps: boundedStringList(15, 500),
  overallClassification: scopeChangeOverallClassificationSchema,
});

export type AiRawScopeChangeOutput = z.infer<typeof aiRawScopeChangeOutputSchema>;

/**
 * Validated, server-grounded scope-change analysis payload with deterministic classification
 * criteria and non-contractual proposal notices.
 */
export const scopeChangeAnalysisSchema = aiRawScopeChangeOutputSchema.extend({
  financialImpact: aiRawScopeChangeOutputSchema.shape.financialImpact.extend({
    requiresHumanReviewNotice: shortString(10, 400, "Human review notice"),
    reconcilesExistingMilestonesUnchanged: z.literal(true),
  }),
  classificationCriteria: z.array(shortString(1, 300, "Classification criterion")).min(1).max(15),
});

export type ScopeChangeAnalysis = z.infer<typeof scopeChangeAnalysisSchema>;

export const scopeChangeRequesterRoleSchema = z.enum(["OWNER", "CLIENT"]);
export type ScopeChangeRequesterRole = z.infer<typeof scopeChangeRequesterRoleSchema>;

/**
 * Integrity-bound scope-change analysis snapshot returned by preview APIs and stored safely in
 * public.change_requests.ai_analysis without modifying request_text.
 */
export const storedScopeChangeAnalysisSchema = scopeChangeAnalysisSchema.extend({
  snapshotMetadata: z.object({
    analyzedRequestTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    agreementVersionId: z.string().uuid(),
    agreementVersionNumber: z.number().int().positive(),
    projectId: z.string().uuid(),
    requesterRole: scopeChangeRequesterRoleSchema,
    analyzedAt: z.string().datetime(),
    model: shortString(1, 120, "Model identifier"),
    integrityTag: z.string().regex(/^[a-f0-9]{64}$/),
    isProposalOnly: z.literal(true),
  }),
});

export type StoredScopeChangeAnalysis = z.infer<typeof storedScopeChangeAnalysisSchema>;

const changeRequestTextSchema = z
  .string()
  .trim()
  .min(3, "Change request description must be at least 3 characters.")
  .max(10_000, "Change request description cannot exceed 10,000 characters.");

/**
 * Strict request body for Freelancer preview scope-change analysis (`POST /api/ai/analyze-scope-change`).
 * Rejects client-supplied financial baselines, agreement content, or requester role overrides.
 */
export const analyzeScopeChangeRequestSchema = z
  .object({
    projectId: z.string().uuid("Invalid project ID"),
    agreementVersionId: z.string().uuid("Invalid agreement version ID").optional(),
    requestText: changeRequestTextSchema,
  })
  .strict();

export type AnalyzeScopeChangeRequest = z.infer<typeof analyzeScopeChangeRequestSchema>;

/**
 * Strict request body for Client Portal preview scope-change analysis
 * (`POST /api/public/portal/[token]/scope-change/analyze`).
 * Project ID and client identity are derived strictly from the verified portal token/session.
 */
export const portalAnalyzeScopeChangeRequestSchema = z
  .object({
    agreementVersionId: z.string().uuid("Invalid agreement version ID").optional(),
    requestText: changeRequestTextSchema,
  })
  .strict();

export type PortalAnalyzeScopeChangeRequest = z.infer<typeof portalAnalyzeScopeChangeRequestSchema>;

/**
 * Strict payload for explicit Freelancer change-request submission
 * (`POST /api/projects/[projectId]/change-requests`).
 */
export const submitChangeRequestPayloadSchema = z
  .object({
    requestText: changeRequestTextSchema,
    agreementVersionId: z.string().uuid("Invalid agreement version ID").optional(),
    aiAnalysis: storedScopeChangeAnalysisSchema.nullable().optional(),
  })
  .strict();

export type SubmitChangeRequestPayload = z.infer<typeof submitChangeRequestPayloadSchema>;

/**
 * Strict payload for explicit Client Portal change-request submission
 * (`POST /api/public/portal/[token]/change-requests`).
 */
export const portalSubmitChangeRequestPayloadSchema = z
  .object({
    requestText: changeRequestTextSchema,
    agreementVersionId: z.string().uuid("Invalid agreement version ID").optional(),
    aiAnalysis: storedScopeChangeAnalysisSchema.nullable().optional(),
  })
  .strict();

export type PortalSubmitChangeRequestPayload = z.infer<
  typeof portalSubmitChangeRequestPayloadSchema
>;

/**
 * Strict payload for manual owner status tracking on an existing change request
 * (`PATCH /api/projects/[projectId]/change-requests/[changeRequestId]`).
 * Never modifies agreements, milestones, or payments.
 */
export const updateChangeRequestStatusSchema = z
  .object({
    status: z.enum(["RESOLVED", "WITHDRAWN"]),
  })
  .strict();

export type UpdateChangeRequestStatusPayload = z.infer<typeof updateChangeRequestStatusSchema>;
