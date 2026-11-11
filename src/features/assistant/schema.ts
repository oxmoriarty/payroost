import { z } from "zod";

const shortString = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} cannot exceed ${max} characters`);

const boundedStringList = (maxItems: number, maxItemLen: number) =>
  z
    .array(z.string().trim().max(maxItemLen))
    .max(maxItems, `List cannot exceed ${maxItems} items`)
    .nullish()
    .transform((items) => (Array.isArray(items) ? items.filter((item) => item.length > 0) : []));

export const assistantParticipantRoleSchema = z.enum(["OWNER", "CLIENT"]);
export type AssistantParticipantRole = z.infer<typeof assistantParticipantRoleSchema>;

export const assistantAuthorityLabelSchema = z.enum([
  "APPROVED_AGREEMENT",
  "CURRENT_DRAFT_OR_PENDING",
  "HISTORICAL_VERSION",
  "MILESTONE_RECORD",
  "SUBMITTED_CHANGE_REQUEST",
  "AI_SCOPE_PROPOSAL",
  "PAYMENT_RECORD",
  "PROJECT_RECORD",
  "ACTIVITY_LOG",
  "SYSTEM_BOUNDARY",
]);
export type AssistantAuthorityLabel = z.infer<typeof assistantAuthorityLabelSchema>;

export const assistantAnswerStatusSchema = z.enum([
  "ANSWERED",
  "PARTIAL_INFORMATION",
  "INSUFFICIENT_INFORMATION",
  "CONFLICTING_RECORDS",
  "ACTION_REDIRECT",
]);
export type AssistantAnswerStatus = z.infer<typeof assistantAnswerStatusSchema>;

export const recordedFactClaimSchema = z.object({
  fact: shortString(2, 600, "Fact statement"),
  authorityLabel: assistantAuthorityLabelSchema,
  sourceRef: shortString(2, 160, "Source reference"),
});
export type RecordedFactClaim = z.infer<typeof recordedFactClaimSchema>;

/**
 * Bounded structured output requested from the central AI provider before
 * server-side grounding, conflict enrichment, and leakage/settlement guards run.
 */
export const aiRawAssistantResponseSchema = z.object({
  answerStatus: assistantAnswerStatusSchema,
  summary: shortString(4, 2400, "Assistant summary"),
  recordedFacts: z
    .array(recordedFactClaimSchema)
    .max(15, "Recorded facts cannot exceed 15 items")
    .nullish()
    .transform((items) => (Array.isArray(items) ? items : [])),
  aiInterpretation: z
    .string()
    .trim()
    .max(1400, "AI interpretation cannot exceed 1400 characters")
    .nullish()
    .transform((val) => (val && val.length > 0 ? val : null)),
  uncertaintiesAndGaps: boundedStringList(10, 400),
  clarificationQuestions: boundedStringList(5, 300),
  recommendedNextSteps: boundedStringList(6, 400),
});

export type AiRawAssistantResponse = z.infer<typeof aiRawAssistantResponseSchema>;

export const assistantContextStatsSchema = z.object({
  approvedAgreementVersion: z.number().int().positive().nullable(),
  currentAgreementVersion: z.number().int().positive().nullable(),
  milestoneCount: z.number().int().min(0),
  openChangeRequestCount: z.number().int().min(0),
  recordedPaymentIntentCount: z.number().int().min(0),
});

/**
 * Server-grounded, strictly read-only assistant response returned to Freelancer Dashboard
 * and verified Client Portal UIs.
 */
export const projectAssistantReplySchema = aiRawAssistantResponseSchema.extend({
  isAiGenerated: z.literal(true),
  readOnlyNotice: shortString(10, 400, "Read-only notice"),
  model: shortString(1, 120, "Model identifier"),
  participantRole: assistantParticipantRoleSchema,
  generatedAt: z.string().datetime(),
  contextStats: assistantContextStatsSchema,
});

export type ProjectAssistantReply = z.infer<typeof projectAssistantReplySchema>;

export const assistantConversationTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: shortString(1, 2000, "Conversation message"),
  })
  .strict();

export type AssistantConversationTurn = z.infer<typeof assistantConversationTurnSchema>;

const questionSchema = z
  .string()
  .trim()
  .min(2, "Question must be at least 2 characters.")
  .max(2000, "Question cannot exceed 2,000 characters.");

/**
 * Strict request body for Freelancer Dashboard assistant endpoint (`POST /api/ai/project-assistant`).
 * Rejects browser-supplied project context, roles, or payment state overrides.
 */
export const freelancerAssistantRequestSchema = z
  .object({
    projectId: z.string().uuid("Invalid project ID format"),
    question: questionSchema,
    history: z
      .array(assistantConversationTurnSchema)
      .max(8, "Conversation history cannot exceed 8 turns per request")
      .optional()
      .default([]),
  })
  .strict();

export type FreelancerAssistantRequest = z.infer<typeof freelancerAssistantRequestSchema>;

/**
 * Strict request body for verified Client Portal assistant endpoint
 * (`POST /api/public/portal/[token]/assistant`).
 * Project scope and participant identity come strictly from the verified portal token and session.
 */
export const portalAssistantRequestSchema = z
  .object({
    question: questionSchema,
    history: z
      .array(assistantConversationTurnSchema)
      .max(8, "Conversation history cannot exceed 8 turns per request")
      .optional()
      .default([]),
  })
  .strict();

export type PortalAssistantRequest = z.infer<typeof portalAssistantRequestSchema>;
