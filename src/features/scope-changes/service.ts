import "server-only";

import { agreementDraftSchema, type AgreementDraft } from "@/features/agreements/schema";
import { recordAiAudit } from "@/lib/ai/audit";
import { getAiProvider } from "@/lib/ai/client";
import {
  AiConfigurationError,
  AiError,
  AiFinancialReconciliationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import type { AiProvider } from "@/lib/ai/types";
import { deriveDeterministicClassification } from "./classification";
import {
  SCOPE_CHANGE_SYSTEM_INSTRUCTION,
  buildScopeChangePrompt,
  type AuthoritativeMilestoneContext,
  type OpenChangeRequestContext,
} from "./prompts";
import {
  aiRawScopeChangeOutputSchema,
  type AiRawScopeChangeOutput,
  type ScopeChangeAnalysis,
  type ScopeChangeRequesterRole,
  type StoredScopeChangeAnalysis,
} from "./schema";
import {
  getSnapshotSigningSecret,
  signScopeChangeAnalysisSnapshot,
  SnapshotSigningConfigurationError,
} from "./snapshot";

export interface AnalyzeScopeChangeServiceInput {
  projectId: string;
  projectTitle: string;
  projectBrief: string;
  projectStatus: string;
  confirmedBudgetMinor: number | null;
  establishedCurrency: string | null;
  startDate: string | null;
  targetEndDate: string | null;
  agreementVersionId: string;
  agreementVersionNumber: number;
  agreementStatus: string;
  agreementContent: AgreementDraft | null;
  rawAgreementSummary: string | null;
  milestones: AuthoritativeMilestoneContext[];
  openChangeRequests: OpenChangeRequestContext[];
  requesterRole: ScopeChangeRequesterRole;
  requestText: string;
}

export interface AnalyzeScopeChangeOptions {
  provider?: AiProvider;
  timeoutMs?: number;
  signal?: AbortSignal;
  userId?: string;
}

export interface AnalyzeScopeChangeResult {
  analysis: StoredScopeChangeAnalysis;
  model: string;
  durationMs: number;
}

const HUMAN_REVIEW_NOTICE =
  "AI-generated financial and scope estimate only — requires mutual human review and an approved agreement revision before any contractual or payment obligation changes.";

function reconciliationError(
  message: string,
  details?: {
    expectedTotalMinor?: number;
    actualTotalMinor?: number;
    currency?: string | null;
  }
): AiFinancialReconciliationError {
  return new AiFinancialReconciliationError(message, {
    expectedTotalMinor: details?.expectedTotalMinor ?? 0,
    actualTotalMinor: details?.actualTotalMinor ?? 0,
    currency: details?.currency ?? "UNSET",
  });
}

function normalizeTitleKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function validateAndGroundScopeAnalysis(
  raw: AiRawScopeChangeOutput,
  input: AnalyzeScopeChangeServiceInput
): ScopeChangeAnalysis {
  const hasConfirmedBaseline =
    typeof input.confirmedBudgetMinor === "number" &&
    Number.isInteger(input.confirmedBudgetMinor) &&
    input.confirmedBudgetMinor > 0 &&
    typeof input.establishedCurrency === "string" &&
    /^[A-Z]{3}$/.test(input.establishedCurrency);

  const confirmedBudgetMinor = hasConfirmedBaseline ? input.confirmedBudgetMinor! : null;
  const establishedCurrency = hasConfirmedBaseline ? input.establishedCurrency! : null;

  if (!raw.financialImpact.reconcilesExistingMilestonesUnchanged) {
    throw reconciliationError(
      "Scope-change analysis must not redistribute existing milestone amounts.",
      {
        expectedTotalMinor: confirmedBudgetMinor ?? 0,
        actualTotalMinor: 0,
        currency: establishedCurrency,
      }
    );
  }

  // Build lookup map of authoritative milestones (DB milestones first, fallback agreement content milestones)
  const milestoneMap = new Map<
    string,
    {
      title: string;
      status: string;
      amountMinor: number | null;
      currency: string | null;
      isPaymentLinkedOrLocked: boolean;
      protectionReason: string | null;
    }
  >();

  for (const m of input.milestones) {
    milestoneMap.set(normalizeTitleKey(m.title), {
      title: m.title,
      status: m.status,
      amountMinor: m.amountMinor,
      currency: m.currency,
      isPaymentLinkedOrLocked: m.isPaymentLinkedOrLocked,
      protectionReason: m.protectionReason,
    });
  }

  if (input.agreementContent) {
    for (const m of input.agreementContent.milestones) {
      const key = normalizeTitleKey(m.title);
      if (!milestoneMap.has(key)) {
        milestoneMap.set(key, {
          title: m.title,
          status: input.agreementStatus === "APPROVED" ? "APPROVED" : input.agreementStatus,
          amountMinor: m.amountMinor,
          currency: m.currency,
          isPaymentLinkedOrLocked: input.agreementStatus === "APPROVED",
          protectionReason:
            input.agreementStatus === "APPROVED"
              ? "Milestone belongs to an approved immutable agreement version"
              : null,
        });
      }
    }
  }

  // Re-ground affected milestones so AI cannot downgrade payment locks or alter existing amounts
  const groundedAffectedMilestones = raw.affectedMilestones.map((m) => {
    const authM = milestoneMap.get(normalizeTitleKey(m.milestoneTitle));
    if (authM) {
      if (
        m.existingAmountMinor !== null &&
        authM.amountMinor !== null &&
        m.existingAmountMinor !== authM.amountMinor
      ) {
        throw reconciliationError(
          `Analysis misrepresented existing amount (${m.existingAmountMinor}) for milestone "${authM.title}" (authoritative ${authM.amountMinor}).`,
          {
            expectedTotalMinor: authM.amountMinor,
            actualTotalMinor: m.existingAmountMinor,
            currency: authM.currency,
          }
        );
      }
      if (m.currency !== null && authM.currency !== null && m.currency !== authM.currency) {
        throw reconciliationError(
          `Analysis currency "${m.currency}" does not match milestone "${authM.title}" currency "${authM.currency}".`,
          {
            expectedTotalMinor: authM.amountMinor ?? 0,
            actualTotalMinor: m.existingAmountMinor ?? 0,
            currency: authM.currency,
          }
        );
      }

      const protectionSuffix =
        authM.isPaymentLinkedOrLocked && authM.protectionReason
          ? ` [Protected Milestone: ${authM.protectionReason}]`
          : "";
      const hasLockNotice =
        !authM.isPaymentLinkedOrLocked ||
        /payment|locked|approved|contractual|immutable|revision/i.test(m.explanation);

      return {
        ...m,
        milestoneTitle: authM.title,
        currentStatus: authM.status,
        isPaymentLinkedOrLocked: authM.isPaymentLinkedOrLocked,
        existingAmountMinor: authM.amountMinor,
        currency: authM.currency,
        explanation: hasLockNotice ? m.explanation : `${m.explanation}${protectionSuffix}`,
      };
    }

    if (!hasConfirmedBaseline && (m.existingAmountMinor !== null || m.currency !== null)) {
      throw reconciliationError(
        `Analysis fabricated monetary details for milestone "${m.milestoneTitle}" without a confirmed project budget or currency.`,
        {
          expectedTotalMinor: 0,
          actualTotalMinor: m.existingAmountMinor ?? 0,
          currency: m.currency,
        }
      );
    }

    if (hasConfirmedBaseline && m.currency !== null && m.currency !== establishedCurrency) {
      throw reconciliationError(
        `Milestone "${m.milestoneTitle}" currency "${m.currency}" conflicts with project currency "${establishedCurrency}".`,
        {
          expectedTotalMinor: confirmedBudgetMinor!,
          actualTotalMinor: m.existingAmountMinor ?? 0,
          currency: establishedCurrency,
        }
      );
    }

    return m;
  });

  // Strict financial baseline checks (never invent budget or currency)
  const ctx = raw.originalAgreementContext;
  const fin = raw.financialImpact;
  let validatedDirection = fin.direction;
  let validatedDeltaMinor = fin.proposedCostDeltaMinor;
  let validatedRevisedTotalMinor = fin.proposedRevisedTotalMinor;

  if (!hasConfirmedBaseline) {
    if (ctx.confirmedBudgetMinor !== null || fin.existingAgreedBudgetMinor !== null) {
      throw reconciliationError(
        "Scope-change analysis invented an existing project budget when no confirmed budget exists.",
        {
          expectedTotalMinor: 0,
          actualTotalMinor:
            ctx.confirmedBudgetMinor ?? fin.existingAgreedBudgetMinor ?? 0,
          currency: ctx.currency ?? fin.currency,
        }
      );
    }
    if (ctx.currency !== null || fin.currency !== null) {
      throw reconciliationError(
        `Scope-change analysis invented currency "${ctx.currency ?? fin.currency}" when no project currency is established.`,
        { currency: ctx.currency ?? fin.currency }
      );
    }
    if (
      fin.direction !== "INSUFFICIENT_INFORMATION" ||
      fin.proposedCostDeltaMinor !== null ||
      fin.proposedRevisedTotalMinor !== null
    ) {
      throw reconciliationError(
        "Scope-change analysis must return INSUFFICIENT_INFORMATION with null financial amounts when agreed budget or currency is missing.",
        {
          expectedTotalMinor: 0,
          actualTotalMinor: fin.proposedCostDeltaMinor ?? fin.proposedRevisedTotalMinor ?? 0,
          currency: "UNSET",
        }
      );
    }

    for (const pm of raw.proposedChanges.proposedNewMilestones) {
      if (pm.proposedAdditionalAmountMinor !== null || pm.currency !== null) {
        throw reconciliationError(
          `Proposed additional milestone "${pm.title}" invented financial values without a confirmed project budget or currency.`,
          {
            expectedTotalMinor: 0,
            actualTotalMinor: pm.proposedAdditionalAmountMinor ?? 0,
            currency: pm.currency,
          }
        );
      }
    }

    validatedDirection = "INSUFFICIENT_INFORMATION";
    validatedDeltaMinor = null;
    validatedRevisedTotalMinor = null;
  } else {
    const budgetTotal = confirmedBudgetMinor!;
    const currency = establishedCurrency!;

    if (ctx.confirmedBudgetMinor !== null && ctx.confirmedBudgetMinor !== budgetTotal) {
      throw reconciliationError(
        `Agreement context budget (${ctx.confirmedBudgetMinor}) differs from authoritative budget (${budgetTotal}).`,
        { expectedTotalMinor: budgetTotal, actualTotalMinor: ctx.confirmedBudgetMinor, currency }
      );
    }
    if (fin.existingAgreedBudgetMinor !== null && fin.existingAgreedBudgetMinor !== budgetTotal) {
      throw reconciliationError(
        `Financial impact baseline (${fin.existingAgreedBudgetMinor}) differs from authoritative budget (${budgetTotal}).`,
        {
          expectedTotalMinor: budgetTotal,
          actualTotalMinor: fin.existingAgreedBudgetMinor,
          currency,
        }
      );
    }
    if (ctx.currency !== null && ctx.currency !== currency) {
      throw reconciliationError(
        `Agreement context currency "${ctx.currency}" differs from project currency "${currency}".`,
        { expectedTotalMinor: budgetTotal, actualTotalMinor: budgetTotal, currency }
      );
    }
    if (fin.currency !== null && fin.currency !== currency) {
      throw reconciliationError(
        `Financial impact currency "${fin.currency}" differs from project currency "${currency}".`,
        { expectedTotalMinor: budgetTotal, actualTotalMinor: budgetTotal, currency }
      );
    }

    if (fin.direction === "UNCHANGED") {
      if (fin.proposedCostDeltaMinor !== null && fin.proposedCostDeltaMinor !== 0) {
        throw reconciliationError(
          `Financial impact marked UNCHANGED cannot have non-zero delta (${fin.proposedCostDeltaMinor}).`,
          {
            expectedTotalMinor: 0,
            actualTotalMinor: fin.proposedCostDeltaMinor,
            currency,
          }
        );
      }
      if (
        fin.proposedRevisedTotalMinor !== null &&
        fin.proposedRevisedTotalMinor !== budgetTotal
      ) {
        throw reconciliationError(
          `Financial impact marked UNCHANGED cannot change revised total (${fin.proposedRevisedTotalMinor} vs ${budgetTotal}).`,
          {
            expectedTotalMinor: budgetTotal,
            actualTotalMinor: fin.proposedRevisedTotalMinor,
            currency,
          }
        );
      }
      for (const pm of raw.proposedChanges.proposedNewMilestones) {
        if (pm.proposedAdditionalAmountMinor !== null) {
          throw reconciliationError(
            `Proposed additional milestone "${pm.title}" cannot carry positive cost when financial impact is UNCHANGED.`,
            {
              expectedTotalMinor: 0,
              actualTotalMinor: pm.proposedAdditionalAmountMinor,
              currency,
            }
          );
        }
        if (pm.currency !== null && pm.currency !== currency) {
          throw reconciliationError(
            `Proposed additional milestone "${pm.title}" currency mismatch.`,
            { expectedTotalMinor: budgetTotal, actualTotalMinor: 0, currency }
          );
        }
      }
      validatedDeltaMinor = 0;
      validatedRevisedTotalMinor = budgetTotal;
    } else if (fin.direction === "INCREASE") {
      if (
        fin.proposedCostDeltaMinor === null ||
        !Number.isInteger(fin.proposedCostDeltaMinor) ||
        fin.proposedCostDeltaMinor <= 0
      ) {
        throw reconciliationError(
          "PROPOSED_INCREASE requires a positive integer proposedCostDeltaMinor.",
          {
            expectedTotalMinor: budgetTotal,
            actualTotalMinor: fin.proposedCostDeltaMinor ?? 0,
            currency,
          }
        );
      }
      if (!fin.costDriversJustification) {
        throw new AiOutputValidationError(
          "Financial increase proposals must include a costDriversJustification explaining added work."
        );
      }

      const expectedRevised = Number(BigInt(budgetTotal) + BigInt(fin.proposedCostDeltaMinor));
      if (
        fin.proposedRevisedTotalMinor !== null &&
        fin.proposedRevisedTotalMinor !== expectedRevised
      ) {
        throw reconciliationError(
          `Revised total (${fin.proposedRevisedTotalMinor}) does not reconcile with agreed budget (${budgetTotal}) + delta (${fin.proposedCostDeltaMinor}).`,
          {
            expectedTotalMinor: expectedRevised,
            actualTotalMinor: fin.proposedRevisedTotalMinor,
            currency,
          }
        );
      }

      // Check optional proposed milestone cost allocations without silently altering amounts
      let pricedCount = 0;
      let pricedSum = 0n;
      for (const pm of raw.proposedChanges.proposedNewMilestones) {
        if (pm.currency !== null && pm.currency !== currency) {
          throw reconciliationError(
            `Proposed milestone "${pm.title}" currency "${pm.currency}" conflicts with project currency "${currency}".`,
            { expectedTotalMinor: fin.proposedCostDeltaMinor, actualTotalMinor: 0, currency }
          );
        }
        if (pm.proposedAdditionalAmountMinor !== null) {
          pricedCount += 1;
          pricedSum += BigInt(pm.proposedAdditionalAmountMinor);
        }
      }

      if (pricedCount > 0) {
        const deltaBig = BigInt(fin.proposedCostDeltaMinor);
        if (pricedSum > deltaBig) {
          throw reconciliationError(
            `Proposed additional milestones total (${pricedSum.toString()} ${currency}) exceeds proposed cost delta (${deltaBig.toString()} ${currency}).`,
            {
              expectedTotalMinor: fin.proposedCostDeltaMinor,
              actualTotalMinor: Number(pricedSum),
              currency,
            }
          );
        }
        if (
          pricedCount === raw.proposedChanges.proposedNewMilestones.length &&
          pricedSum !== deltaBig
        ) {
          throw reconciliationError(
            `Fully itemized proposed additional milestones (${pricedSum.toString()} ${currency}) do not reconcile with proposed cost delta (${deltaBig.toString()} ${currency}).`,
            {
              expectedTotalMinor: fin.proposedCostDeltaMinor,
              actualTotalMinor: Number(pricedSum),
              currency,
            }
          );
        }
      }

      validatedDeltaMinor = fin.proposedCostDeltaMinor;
      validatedRevisedTotalMinor = expectedRevised;
    } else if (fin.direction === "DECREASE") {
      if (
        fin.proposedCostDeltaMinor === null ||
        !Number.isInteger(fin.proposedCostDeltaMinor) ||
        fin.proposedCostDeltaMinor >= 0
      ) {
        throw reconciliationError(
          "PROPOSED_DECREASE requires a negative integer proposedCostDeltaMinor.",
          {
            expectedTotalMinor: budgetTotal,
            actualTotalMinor: fin.proposedCostDeltaMinor ?? 0,
            currency,
          }
        );
      }
      if (!fin.costDriversJustification) {
        throw new AiOutputValidationError(
          "Financial decrease proposals must include a costDriversJustification explaining removed work."
        );
      }
      const revisedBig = BigInt(budgetTotal) + BigInt(fin.proposedCostDeltaMinor);
      if (revisedBig <= 0n) {
        throw reconciliationError(
          `Proposed cost reduction (${fin.proposedCostDeltaMinor}) would reduce agreed project budget (${budgetTotal}) to zero or below.`,
          {
            expectedTotalMinor: budgetTotal,
            actualTotalMinor: Number(revisedBig),
            currency,
          }
        );
      }
      const expectedRevised = Number(revisedBig);
      if (
        fin.proposedRevisedTotalMinor !== null &&
        fin.proposedRevisedTotalMinor !== expectedRevised
      ) {
        throw reconciliationError(
          `Revised total (${fin.proposedRevisedTotalMinor}) does not reconcile with agreed budget (${budgetTotal}) + negative delta (${fin.proposedCostDeltaMinor}).`,
          {
            expectedTotalMinor: expectedRevised,
            actualTotalMinor: fin.proposedRevisedTotalMinor,
            currency,
          }
        );
      }
      for (const pm of raw.proposedChanges.proposedNewMilestones) {
        if (pm.proposedAdditionalAmountMinor !== null) {
          throw reconciliationError(
            `Proposed milestone "${pm.title}" cannot carry a positive additional cost when net financial impact is DECREASE.`,
            {
              expectedTotalMinor: 0,
              actualTotalMinor: pm.proposedAdditionalAmountMinor,
              currency,
            }
          );
        }
      }
      validatedDeltaMinor = fin.proposedCostDeltaMinor;
      validatedRevisedTotalMinor = expectedRevised;
    } else {
      // INSUFFICIENT_INFORMATION
      if (fin.proposedCostDeltaMinor !== null || fin.proposedRevisedTotalMinor !== null) {
        throw reconciliationError(
          "Financial impact with direction INSUFFICIENT_INFORMATION must leave cost delta and revised total null.",
          {
            expectedTotalMinor: budgetTotal,
            actualTotalMinor: fin.proposedCostDeltaMinor ?? fin.proposedRevisedTotalMinor ?? 0,
            currency,
          }
        );
      }
      for (const pm of raw.proposedChanges.proposedNewMilestones) {
        if (pm.proposedAdditionalAmountMinor !== null) {
          throw reconciliationError(
            `Proposed milestone "${pm.title}" cannot carry an amount when overall financial impact is INSUFFICIENT_INFORMATION.`,
            {
              expectedTotalMinor: 0,
              actualTotalMinor: pm.proposedAdditionalAmountMinor,
              currency,
            }
          );
        }
      }
      validatedDeltaMinor = null;
      validatedRevisedTotalMinor = null;
    }
  }

  // Timeline invariants (never invent dates or inconsistent day ranges)
  const tl = raw.timelineImpact;
  if (tl.classification === "NO_MATERIAL_IMPACT") {
    if ((tl.estimatedAdditionalDaysMin ?? 0) > 0 || (tl.estimatedAdditionalDaysMax ?? 0) > 0) {
      throw new AiOutputValidationError(
        "Timeline marked NO_MATERIAL_IMPACT cannot specify positive additional days."
      );
    }
  } else if (tl.classification === "CANNOT_BE_ESTIMATED") {
    if (tl.estimatedAdditionalDaysMin !== null || tl.estimatedAdditionalDaysMax !== null) {
      throw new AiOutputValidationError(
        "Timeline marked CANNOT_BE_ESTIMATED must leave day estimates null."
      );
    }
  } else {
    // POTENTIAL_EXTENSION
    if (
      tl.estimatedAdditionalDaysMin === null ||
      tl.estimatedAdditionalDaysMax === null ||
      tl.estimatedAdditionalDaysMin < 1 ||
      tl.estimatedAdditionalDaysMax < tl.estimatedAdditionalDaysMin
    ) {
      throw new AiOutputValidationError(
        "Timeline marked POTENTIAL_EXTENSION must provide valid integer min/max day range (1 <= min <= max)."
      );
    }
  }

  const nextSteps = [...raw.recommendedNextSteps];
  const hasLockedMilestoneImpact = groundedAffectedMilestones.some(
    (m) => m.isPaymentLinkedOrLocked
  );
  if (
    hasLockedMilestoneImpact &&
    !nextSteps.some((step) =>
      /locked|payment-linked|modified in place|agreement revision/i.test(step)
    )
  ) {
    nextSteps.push(
      "Create a formal agreement revision (vN+1) for bilateral client OTP review; existing payment-linked or approved milestones must not be modified in place."
    );
  }

  const groundedBase = {
    ...raw,
    originalAgreementContext: {
      agreementVersionNumber: input.agreementVersionNumber,
      agreementStatus: input.agreementStatus,
      confirmedBudgetMinor,
      currency: establishedCurrency,
      summaryExcerpt: raw.originalAgreementContext.summaryExcerpt,
    },
    affectedMilestones: groundedAffectedMilestones,
    financialImpact: {
      direction: validatedDirection,
      existingAgreedBudgetMinor: confirmedBudgetMinor,
      currency: establishedCurrency,
      proposedCostDeltaMinor: validatedDeltaMinor,
      proposedRevisedTotalMinor: validatedRevisedTotalMinor,
      costDriversJustification: fin.costDriversJustification,
      reconcilesExistingMilestonesUnchanged: true as const,
      requiresHumanReviewNotice: HUMAN_REVIEW_NOTICE,
    },
    recommendedNextSteps: nextSteps.slice(0, 15),
  };

  const { overallClassification, classificationCriteria } = deriveDeterministicClassification({
    changeSummary: groundedBase.changeSummary,
    affectedDeliverables: groundedBase.affectedDeliverables,
    affectedMilestones: groundedBase.affectedMilestones,
    proposedChanges: groundedBase.proposedChanges,
    financialImpact: groundedBase.financialImpact,
    timelineImpact: groundedBase.timelineImpact,
    dependencyChanges: groundedBase.dependencyChanges,
    riskAssessment: groundedBase.riskAssessment,
    unresolvedQuestions: groundedBase.unresolvedQuestions,
  });

  return {
    ...groundedBase,
    overallClassification,
    classificationCriteria,
  };
}

/**
 * Generates and deterministically validates a conservative AI scope-change impact assessment
 * against the authoritative agreement version, deliverables, milestones, and open requests.
 *
 * Strictly read-only / preview-only: never writes to PostgreSQL domain tables or triggers payments.
 */
export async function analyzeScopeChange(
  input: AnalyzeScopeChangeServiceInput,
  options: AnalyzeScopeChangeOptions = {}
): Promise<AnalyzeScopeChangeResult> {
  const startTime = Date.now();
  const provider = options.provider ?? getAiProvider();
  const hasConfirmedBaseline =
    typeof input.confirmedBudgetMinor === "number" &&
    Number.isInteger(input.confirmedBudgetMinor) &&
    input.confirmedBudgetMinor > 0 &&
    typeof input.establishedCurrency === "string" &&
    /^[A-Z]{3}$/.test(input.establishedCurrency);

  const parsedAgreementContent = input.agreementContent
    ? agreementDraftSchema.safeParse(input.agreementContent).data ?? null
    : null;

  const prompt = buildScopeChangePrompt({
    projectTitle: input.projectTitle,
    projectBrief: input.projectBrief,
    projectStatus: input.projectStatus,
    confirmedBudgetMinor: hasConfirmedBaseline ? input.confirmedBudgetMinor : null,
    establishedCurrency: hasConfirmedBaseline ? input.establishedCurrency : null,
    startDate: input.startDate,
    targetEndDate: input.targetEndDate,
    agreementVersionNumber: input.agreementVersionNumber,
    agreementStatus: input.agreementStatus,
    agreementContent: parsedAgreementContent,
    rawAgreementSummary: input.rawAgreementSummary,
    milestones: input.milestones,
    openChangeRequests: input.openChangeRequests,
    requesterRole: input.requesterRole,
    requestText: input.requestText,
  });

  try {
    // Validate snapshot signing secret upfront before calling the AI provider.
    getSnapshotSigningSecret();

    const result = await provider.generateStructured(prompt, aiRawScopeChangeOutputSchema, {
      systemInstruction: SCOPE_CHANGE_SYSTEM_INSTRUCTION,
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
      temperature: 0.2,
    });

    const groundedAnalysis = validateAndGroundScopeAnalysis(result.data, input);
    const snapshot = signScopeChangeAnalysisSnapshot({
      analysis: groundedAnalysis,
      requestText: input.requestText,
      agreementVersionId: input.agreementVersionId,
      agreementVersionNumber: input.agreementVersionNumber,
      projectId: input.projectId,
      requesterRole: input.requesterRole,
      model: result.model,
    });

    const durationMs = Date.now() - startTime;
    const lockedMilestonesAffected = snapshot.affectedMilestones.filter(
      (m) => m.isPaymentLinkedOrLocked
    ).length;

    await recordAiAudit({
      feature: "scope_change_analysis",
      projectId: input.projectId,
      userId: options.userId,
      model: result.model,
      durationMs,
      tokenUsage: result.usage,
      outcome: "success",
      metadata: {
        requesterRole: input.requesterRole,
        agreementVersionNumber: input.agreementVersionNumber,
        overallClassification: snapshot.overallClassification,
        financialDirection: snapshot.financialImpact.direction,
        timelineClassification: snapshot.timelineImpact.classification,
        affectedDeliverablesCount: snapshot.affectedDeliverables.length,
        affectedMilestonesCount: snapshot.affectedMilestones.length,
        lockedMilestonesAffected,
        hasConfirmedBaseline,
        openChangeRequestsCount: input.openChangeRequests.length,
        requestLength: input.requestText.trim().length,
      },
    });

    return {
      analysis: snapshot,
      model: result.model,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorCategory = error instanceof AiError ? error.name : "UNKNOWN_ERROR";

    await recordAiAudit({
      feature: "scope_change_analysis",
      projectId: input.projectId,
      userId: options.userId,
      model: provider.providerName,
      durationMs,
      outcome: "error",
      errorCategory,
      metadata: {
        requesterRole: input.requesterRole,
        agreementVersionNumber: input.agreementVersionNumber,
        hasConfirmedBaseline,
        requestLength: input.requestText.trim().length,
      },
    });

    if (
      error instanceof SnapshotSigningConfigurationError ||
      error instanceof AiConfigurationError ||
      error instanceof AiRateLimitError ||
      error instanceof AiFinancialReconciliationError ||
      error instanceof AiOutputValidationError ||
      error instanceof AiUnavailableError
    ) {
      throw error;
    }

    throw new AiUnavailableError(
      error instanceof Error ? error.message : "Scope-change analysis failed unexpectedly.",
      { cause: error }
    );
  }
}
