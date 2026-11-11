import "server-only";

import { recordAiAudit } from "@/lib/ai/audit";
import { getAiProvider } from "@/lib/ai/client";
import {
  AiError,
  AiOutputValidationError,
  redactSensitiveData,
} from "@/lib/ai/errors";
import type { AiProvider } from "@/lib/ai/types";
import type { AuthoritativeProjectAssistantContext } from "./context";
import {
  buildProjectAssistantPrompt,
  PROJECT_ASSISTANT_SYSTEM_INSTRUCTION,
} from "./prompts";
import {
  aiRawAssistantResponseSchema,
  type AiRawAssistantResponse,
  type AssistantConversationTurn,
  type ProjectAssistantReply,
  projectAssistantReplySchema,
} from "./schema";

export interface AskProjectAssistantInput {
  context: AuthoritativeProjectAssistantContext;
  question: string;
  history?: AssistantConversationTurn[];
  userId?: string;
}

export interface AskProjectAssistantOptions {
  provider?: AiProvider;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AskProjectAssistantResult {
  reply: ProjectAssistantReply;
  model: string;
  durationMs: number;
}

const READ_ONLY_NOTICE =
  "AI-generated read-only summary based on PayRoost project records. AI outputs do not constitute legal advice and cannot modify agreements, milestones, change requests, or payments.";

const EMAIL_MASK_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ISO_CURRENCY_AMOUNT_REGEX =
  /\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|NGN|INR|SGD|NZD)\s+(?:[0-9][0-9,.]*)\b|\b(?:[0-9][0-9,.]*)\s+(USD|EUR|GBP|CAD|AUD|JPY|CHF|NGN|INR|SGD|NZD)\b/g;

const NEGATION_LOOKBACK_REGEX =
  /\b(?:no|not|never|none|neither|without|unconfirmed|pending|unable|cannot|can't|hasn't|haven't|isn't|aren't|doesn't|didn't)\b/i;

function sanitizeOutputText(text: string): string {
  return redactSensitiveData(text).replace(EMAIL_MASK_REGEX, "[redacted-email]");
}

function containsSensitiveLeak(text: string): boolean {
  return (
    /AIza[0-9A-Za-z\-_]{20,}/.test(text) ||
    /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i.test(text) ||
    /PROJECT_ASSISTANT_SYSTEM_INSTRUCTION|<AUTHORITATIVE_PROJECT_CONTEXT>|<ALLOWED_SOURCE_REFS>|payroost-default-ai-snapshot/i.test(
      text
    ) ||
    /\b(?:expected_merchant_id|payee_merchant_id|paypal_merchant_id|session_token_hash|csrf_secret|capture_lease_token|tracking_id|partner_referral_id)\b/i.test(
      text
    )
  );
}

function containsUnqualifiedPositiveClaim(text: string, positivePattern: RegExp): boolean {
  const flags = positivePattern.flags.includes("g")
    ? positivePattern.flags
    : `${positivePattern.flags}g`;
  const globalPattern = new RegExp(positivePattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = globalPattern.exec(text)) !== null) {
    const start = Math.max(0, match.index - 32);
    const prefix = text.slice(start, match.index);
    if (!NEGATION_LOOKBACK_REGEX.test(prefix)) {
      return true;
    }
  }
  return false;
}

function normalizeSourceRef(ref: string): string {
  return ref.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildValidSourceMatchers(context: AuthoritativeProjectAssistantContext): {
  exactRefs: Set<string>;
} {
  const exactRefs = new Set<string>();
  for (const ref of context.validSourceRefs) {
    exactRefs.add(normalizeSourceRef(ref));
  }
  return { exactRefs };
}

function isKnownSourceRef(ref: string, exactRefs: Set<string>): boolean {
  const normalized = normalizeSourceRef(ref);
  if (exactRefs.has(normalized)) {
    return true;
  }
  // Allow citing "Milestone #1" prefix or exact version prefix derived directly from validSourceRefs
  for (const valid of exactRefs) {
    if (normalized === valid) return true;
  }
  return false;
}

function collectKnownProjectCurrencies(context: AuthoritativeProjectAssistantContext): Set<string> {
  const currencies = new Set<string>();
  if (context.project.currency) currencies.add(context.project.currency.toUpperCase());
  for (const m of context.milestones) {
    if (m.currency) currencies.add(m.currency.toUpperCase());
  }
  for (const p of context.payments.records) {
    if (p.currency) currencies.add(p.currency.toUpperCase());
  }
  for (const cr of context.changeRequests) {
    if (cr.persistedAiAdvice?.currency) {
      currencies.add(cr.persistedAiAdvice.currency.toUpperCase());
    }
  }
  return currencies;
}

/**
 * Performs post-Zod deterministic verification of AI output against authoritative project
 * records: checks source citations, blocks fabricated agreements/milestones/payments/currencies,
 * blocks false seller settlement claims, blocks claimed write actions, redacts sensitive/PII
 * data, and preserves detected database conflicts.
 */
export function validateAndGroundAssistantReply(params: {
  raw: AiRawAssistantResponse;
  context: AuthoritativeProjectAssistantContext;
  model: string;
  question: string;
}): ProjectAssistantReply {
  const { raw, context, model, question } = params;

  const allTextFields: string[] = [
    raw.summary,
    ...(raw.aiInterpretation ? [raw.aiInterpretation] : []),
    ...raw.recordedFacts.map((f) => `${f.fact} ${f.sourceRef}`),
    ...raw.uncertaintiesAndGaps,
    ...raw.clarificationQuestions,
    ...raw.recommendedNextSteps,
  ];

  for (const text of allTextFields) {
    if (containsSensitiveLeak(text)) {
      throw new AiOutputValidationError(
        "Assistant response attempted to disclose protected internal identifiers or system context."
      );
    }
  }

  // Reject assistant claiming to have executed state mutations
  const claimedWriteRegex =
    /\b(?:i have|i've|i just|this assistant has|assistant has)\s+(?:approved|updated|created|modified|edited|deleted|submitted|accepted|rejected|withdrawn|resolved|initiated|captured|refunded|sent|emailed|triggered|connected|changed)\b/i;

  if (
    claimedWriteRegex.test(raw.summary) ||
    raw.recordedFacts.some((f) => claimedWriteRegex.test(f.fact))
  ) {
    throw new AiOutputValidationError(
      "Read-only assistant cannot claim to have modified PayRoost agreements, milestones, change requests, or payments."
    );
  }

  // Reject legal enforceability / legal advice claims
  const legalAdviceRegex =
    /\b(?:legally binding|legally enforceable|legal advice|enforceable contract under law|legally required to pay)\b/i;
  if (
    containsUnqualifiedPositiveClaim(raw.summary, legalAdviceRegex) ||
    raw.recordedFacts.some((f) => containsUnqualifiedPositiveClaim(f.fact, legalAdviceRegex))
  ) {
    throw new AiOutputValidationError(
      "Assistant cannot provide legal advice or assert legal enforceability."
    );
  }

  // Validate source citations & authoritative record existence
  const { exactRefs } = buildValidSourceMatchers(context);
  const knownCurrencies = collectKnownProjectCurrencies(context);

  const sanitizedFacts = raw.recordedFacts.map((claim) => {
    if (!isKnownSourceRef(claim.sourceRef, exactRefs)) {
      throw new AiOutputValidationError(
        `Assistant cited an unrecognized or nonexistent source reference: "${claim.sourceRef}".`
      );
    }

    if (
      claim.authorityLabel === "APPROVED_AGREEMENT" &&
      context.agreement.approvedVersionNumber === null
    ) {
      throw new AiOutputValidationError(
        "Assistant cited an APPROVED_AGREEMENT fact when no approved agreement exists."
      );
    }
    if (
      claim.authorityLabel === "CURRENT_DRAFT_OR_PENDING" &&
      context.agreement.currentVersionNumber === null
    ) {
      throw new AiOutputValidationError(
        "Assistant cited an agreement draft fact when no agreement versions exist."
      );
    }
    if (claim.authorityLabel === "MILESTONE_RECORD" && context.milestones.length === 0) {
      throw new AiOutputValidationError(
        "Assistant cited a MILESTONE_RECORD fact when no milestones exist."
      );
    }
    if (
      claim.authorityLabel === "SUBMITTED_CHANGE_REQUEST" &&
      context.changeRequests.length === 0
    ) {
      throw new AiOutputValidationError(
        "Assistant cited a SUBMITTED_CHANGE_REQUEST fact when no change requests exist."
      );
    }
    if (
      claim.authorityLabel === "AI_SCOPE_PROPOSAL" &&
      !context.changeRequests.some((cr) => cr.persistedAiAdvice !== null)
    ) {
      throw new AiOutputValidationError(
        "Assistant cited AI_SCOPE_PROPOSAL when no persisted AI scope-change analyses exist."
      );
    }
    if (
      claim.authorityLabel === "PAYMENT_RECORD" &&
      context.payments.records.length === 0
    ) {
      throw new AiOutputValidationError(
        "Assistant cited PAYMENT_RECORD when no payment intents or transactions exist."
      );
    }

    // Check against foreign fabricated currencies in factual claims
    let match: RegExpExecArray | null;
    ISO_CURRENCY_AMOUNT_REGEX.lastIndex = 0;
    while ((match = ISO_CURRENCY_AMOUNT_REGEX.exec(claim.fact)) !== null) {
      const code = (match[1] || match[2] || "").toUpperCase();
      if (code && !knownCurrencies.has(code)) {
        throw new AiOutputValidationError(
          `Assistant factual claim referenced foreign currency "${code}" not present in project records.`
        );
      }
    }

    return {
      fact: sanitizeOutputText(claim.fact),
      authorityLabel: claim.authorityLabel,
      sourceRef: sanitizeOutputText(claim.sourceRef),
    };
  });

  // Payment & settlement grounding guards
  const combinedFactualText = [raw.summary, ...sanitizedFacts.map((f) => f.fact)].join(" ");

  const falseSellerSettlementPattern =
    /\b(?:seller|freelancer)\s+(?:has\s+)?(?:already\s+)?(?:received|collected|withdrawn|settled)\s+(?:the\s+)?(?:funds|payout|money|payment)\b|\bbank\s+(?:payout|settlement|disbursement)\s+(?:is\s+)?(?:complete|completed|confirmed|settled)\b/i;

  if (containsUnqualifiedPositiveClaim(combinedFactualText, falseSellerSettlementPattern)) {
    throw new AiOutputValidationError(
      "Assistant cannot claim seller bank payout settlement occurred because PayRoost does not track downstream disbursement."
    );
  }

  if (!context.payments.hasAnyCompletedCapture) {
    const falseCompletedCapturePattern =
      /\b(?:payment\s+(?:is|has been)\s+(?:completed|captured|paid|settled)|funds\s+(?:have been|were)\s+(?:captured|settled)|milestone\s+(?:is|has been)\s+(?:paid|settled))\b/i;

    if (containsUnqualifiedPositiveClaim(combinedFactualText, falseCompletedCapturePattern)) {
      throw new AiOutputValidationError(
        "Assistant claimed a completed payment capture when no COMPLETED payment intent or capture transaction exists."
      );
    }
  }

  // Merge critical conflicts so the assistant never silently hides contradicting DB state
  const mergedUncertainties = raw.uncertaintiesAndGaps.map((u) => sanitizeOutputText(u));
  for (const conflict of context.detectedConflicts) {
    const alreadyMentioned = mergedUncertainties.some((u) =>
      u.toLowerCase().includes(conflict.slice(0, 24).toLowerCase())
    );
    if (!alreadyMentioned && mergedUncertainties.length < 10) {
      mergedUncertainties.push(conflict);
    }
  }

  const questionTouchesConflictTopics =
    /budget|total|milestone|agreement|version|pay|paid|payment|status|history|conflict|timeline/i.test(
      question
    );
  const finalStatus =
    context.detectedConflicts.length > 0 &&
    raw.answerStatus === "ANSWERED" &&
    questionTouchesConflictTopics
      ? "CONFLICTING_RECORDS"
      : raw.answerStatus;

  return projectAssistantReplySchema.parse({
    answerStatus: finalStatus,
    summary: sanitizeOutputText(raw.summary),
    recordedFacts: sanitizedFacts,
    aiInterpretation: raw.aiInterpretation ? sanitizeOutputText(raw.aiInterpretation) : null,
    uncertaintiesAndGaps: mergedUncertainties.slice(0, 10),
    clarificationQuestions: raw.clarificationQuestions.map((q) => sanitizeOutputText(q)),
    recommendedNextSteps: raw.recommendedNextSteps.map((s) => sanitizeOutputText(s)),
    isAiGenerated: true,
    readOnlyNotice: READ_ONLY_NOTICE,
    model,
    participantRole: context.participantRole,
    generatedAt: new Date().toISOString(),
    contextStats: context.stats,
  });
}

/**
 * Executes a context-aware, strictly read-only assistant turn against the AI Foundation
 * provider (Gemini 3.8 Flash Free Tier by default) and records sanitized telemetry.
 */
export async function askProjectAssistant(
  input: AskProjectAssistantInput,
  options: AskProjectAssistantOptions = {}
): Promise<AskProjectAssistantResult> {
  const startTime = Date.now();
  const provider = options.provider ?? getAiProvider();
  const trimmedQuestion = input.question.trim();
  const history = input.history ?? [];

  const prompt = buildProjectAssistantPrompt({
    context: input.context,
    question: trimmedQuestion,
    history,
  });

  try {
    const result = await provider.generateStructured(prompt, aiRawAssistantResponseSchema, {
      systemInstruction: PROJECT_ASSISTANT_SYSTEM_INSTRUCTION,
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
      temperature: 0.2,
    });

    const reply = validateAndGroundAssistantReply({
      raw: result.data,
      context: input.context,
      model: result.model,
      question: trimmedQuestion,
    });

    const durationMs = Date.now() - startTime;

    await recordAiAudit({
      feature: "project_assistant",
      projectId: input.context.project.id,
      userId: input.userId,
      model: result.model,
      durationMs,
      tokenUsage: result.usage,
      outcome: "success",
      metadata: {
        participantRole: input.context.participantRole,
        questionLength: trimmedQuestion.length,
        historyTurns: history.length,
        answerStatus: reply.answerStatus,
        factsCount: reply.recordedFacts.length,
        uncertaintiesCount: reply.uncertaintiesAndGaps.length,
      },
    });

    return {
      reply,
      model: result.model,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorCategory = error instanceof AiError ? error.name : "UnexpectedError";

    await recordAiAudit({
      feature: "project_assistant",
      projectId: input.context.project.id,
      userId: input.userId,
      model: provider.providerName,
      durationMs,
      outcome: "error",
      errorCategory,
      metadata: {
        participantRole: input.context.participantRole,
        questionLength: trimmedQuestion.length,
        historyTurns: history.length,
      },
    });

    throw error;
  }
}
