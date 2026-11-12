import "server-only";

import type { z } from "zod";
import type { AgreementDraft } from "@/features/agreements/schema";
import type { StructuredBrief } from "@/features/briefs/schema";
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
import {
  MILESTONE_GENERATION_SYSTEM_INSTRUCTION,
  buildMilestonePlanPrompt,
} from "./prompts";
import { milestonePlanSchema, type MilestonePlan } from "./schema";

export interface GenerateMilestonePlanInput {
  projectTitle: string;
  projectBrief: string;
  structuredBrief?: StructuredBrief | null;
  existingAgreement?: AgreementDraft | null;
  existingMilestones?: Array<{
    title: string;
    status: string;
    amountMinor?: number;
    currency?: string;
  }>;
  confirmedBudgetMinor?: number | null;
  establishedCurrency?: string | null;
  allocateBudget?: boolean;
  startDate?: string | null;
  targetEndDate?: string | null;
  planningGoal?: string | null;
}

export interface GenerateMilestonePlanOptions {
  provider?: AiProvider;
  timeoutMs?: number;
  signal?: AbortSignal;
  projectId?: string;
  userId?: string;
}

export interface GenerateMilestonePlanResult {
  plan: MilestonePlan;
  model: string;
  durationMs: number;
}

/**
 * Coerces non-ISO date strings in LLM output to null without ever modifying financial values.
 */
function normalizeRawMilestonePlan(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...raw };

  if (Array.isArray(normalized.milestones)) {
    normalized.milestones = normalized.milestones.map((item) => {
      if (item && typeof item === "object") {
        const milestone = { ...(item as Record<string, unknown>) };
        if (typeof milestone.dueDate === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(milestone.dueDate)) {
          milestone.dueDate = null;
        }
        return milestone;
      }
      return item;
    });
  }

  return normalized;
}

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

/**
 * Deterministically validates structural, sequencing, dependency DAG, and financial invariants
 * on a parsed MilestonePlan. Never silently alters amounts to force reconciliation.
 */
function validateMilestonePlanInvariants(
  plan: MilestonePlan,
  params: {
    hasConfirmedBudget: boolean;
    shouldAllocateBudget: boolean;
    confirmedBudgetMinor: number | null;
    establishedCurrency: string | null;
  }
): MilestonePlan {
  if (plan.milestoneCount !== plan.milestones.length) {
    throw new AiOutputValidationError(
      `Invalid milestone plan: milestoneCount (${plan.milestoneCount}) does not match returned milestones (${plan.milestones.length}).`
    );
  }

  // Validate unique IDs and contiguous 1..N positions
  const seenIds = new Set<string>();
  const positionById = new Map<string, number>();
  const seenPositions = new Set<number>();

  for (const m of plan.milestones) {
    if (seenIds.has(m.id)) {
      throw new AiOutputValidationError(
        `Invalid milestone plan: duplicate milestone ID "${m.id}".`
      );
    }
    seenIds.add(m.id);

    if (seenPositions.has(m.position) || m.position < 1 || m.position > plan.milestones.length) {
      throw new AiOutputValidationError(
        `Invalid milestone plan: position ${m.position} is duplicated or out of 1..${plan.milestones.length} range.`
      );
    }
    seenPositions.add(m.position);
    positionById.set(m.id, m.position);
  }

  // Validate dependencies reference real earlier milestones with zero cycles
  for (const m of plan.milestones) {
    for (const depId of m.dependsOn) {
      if (depId === m.id) {
        throw new AiOutputValidationError(
          `Invalid milestone dependency: milestone "${m.id}" cannot depend on itself.`
        );
      }
      const depPos = positionById.get(depId);
      if (depPos === undefined) {
        throw new AiOutputValidationError(
          `Invalid milestone dependency: milestone "${m.id}" depends on unknown milestone "${depId}".`
        );
      }
      if (depPos >= m.position) {
        throw new AiOutputValidationError(
          `Invalid milestone dependency ordering: milestone "${m.id}" (position ${m.position}) depends on "${depId}" (position ${depPos}), which does not precede it.`
        );
      }
    }
  }

  // Enforce strict no-invention & integer minor-unit financial reconciliation
  const { shouldAllocateBudget, confirmedBudgetMinor, establishedCurrency } = params;

  if (!shouldAllocateBudget) {
    if (plan.allocatesFullBudget) {
      throw reconciliationError(
        "Milestone plan cannot claim allocatesFullBudget=true without a confirmed budget allocation.",
        { currency: establishedCurrency }
      );
    }
    if (plan.totalProposedAmountMinor !== null) {
      throw reconciliationError(
        "Milestone plan cannot invent totalProposedAmountMinor without a confirmed budget.",
        { actualTotalMinor: plan.totalProposedAmountMinor, currency: establishedCurrency }
      );
    }
    if (!establishedCurrency && plan.currency !== null) {
      throw reconciliationError(
        `Milestone plan invented currency "${plan.currency}" without an established project currency.`,
        { currency: plan.currency }
      );
    }
    if (establishedCurrency && plan.currency !== null && plan.currency !== establishedCurrency) {
      throw reconciliationError(
        `Milestone plan currency "${plan.currency}" does not match established currency "${establishedCurrency}".`,
        { currency: establishedCurrency }
      );
    }

    for (const m of plan.milestones) {
      if (m.proposedAmountMinor !== null) {
        throw reconciliationError(
          `Milestone "${m.title}" fabricated proposedAmountMinor=${m.proposedAmountMinor} when no confirmed budget is allocated.`,
          { actualTotalMinor: m.proposedAmountMinor, currency: establishedCurrency }
        );
      }
      if (!establishedCurrency && m.currency !== null) {
        throw reconciliationError(
          `Milestone "${m.title}" invented currency "${m.currency}" when no project currency is established.`,
          { currency: m.currency }
        );
      }
      if (establishedCurrency && m.currency !== null && m.currency !== establishedCurrency) {
        throw reconciliationError(
          `Milestone "${m.title}" currency "${m.currency}" does not match established currency "${establishedCurrency}".`,
          { currency: establishedCurrency }
        );
      }
    }
  } else {
    const budgetTotal = confirmedBudgetMinor!;
    const currency = establishedCurrency!;

    if (plan.currency !== null && plan.currency !== currency) {
      throw reconciliationError(
        `Milestone plan currency "${plan.currency}" does not match project currency "${currency}".`,
        { expectedTotalMinor: budgetTotal, actualTotalMinor: 0, currency }
      );
    }

    let allocatedSum = 0;
    let assignedCount = 0;

    for (const m of plan.milestones) {
      if (m.proposedAmountMinor !== null) {
        if (!Number.isInteger(m.proposedAmountMinor) || m.proposedAmountMinor <= 0) {
          throw reconciliationError(
            `Milestone "${m.title}" has invalid amount ${m.proposedAmountMinor}; amounts must be positive integer minor units.`,
            { expectedTotalMinor: budgetTotal, actualTotalMinor: m.proposedAmountMinor, currency }
          );
        }
        if (m.currency !== currency) {
          throw reconciliationError(
            `Milestone "${m.title}" currency "${m.currency ?? "null"}" does not match project currency "${currency}".`,
            { expectedTotalMinor: budgetTotal, actualTotalMinor: m.proposedAmountMinor, currency }
          );
        }
        allocatedSum += m.proposedAmountMinor;
        assignedCount += 1;
      } else if (m.currency !== null && m.currency !== currency) {
        throw reconciliationError(
          `Milestone "${m.title}" currency "${m.currency}" does not match project currency "${currency}".`,
          { expectedTotalMinor: budgetTotal, actualTotalMinor: allocatedSum, currency }
        );
      }
    }

    if (plan.allocatesFullBudget) {
      if (assignedCount !== plan.milestones.length) {
        throw reconciliationError(
          "Milestone plan with allocatesFullBudget=true must assign positive amounts to every milestone.",
          { expectedTotalMinor: budgetTotal, actualTotalMinor: allocatedSum, currency }
        );
      }
      if (allocatedSum !== budgetTotal) {
        throw reconciliationError(
          `Proposed milestones sum to ${allocatedSum} ${currency}, which does not reconcile with confirmed budget ${budgetTotal} ${currency}.`,
          { expectedTotalMinor: budgetTotal, actualTotalMinor: allocatedSum, currency }
        );
      }
      if (plan.totalProposedAmountMinor !== budgetTotal) {
        throw reconciliationError(
          `Plan totalProposedAmountMinor (${plan.totalProposedAmountMinor ?? "null"}) must equal confirmed budget (${budgetTotal}).`,
          { expectedTotalMinor: budgetTotal, actualTotalMinor: allocatedSum, currency }
        );
      }
    } else {
      if (allocatedSum > budgetTotal) {
        throw reconciliationError(
          `Proposed milestones sum (${allocatedSum} ${currency}) exceeds confirmed budget (${budgetTotal} ${currency}).`,
          { expectedTotalMinor: budgetTotal, actualTotalMinor: allocatedSum, currency }
        );
      }
      if (assignedCount > 0 && plan.totalProposedAmountMinor !== null && plan.totalProposedAmountMinor !== allocatedSum) {
        throw reconciliationError(
          `Plan totalProposedAmountMinor (${plan.totalProposedAmountMinor}) does not match assigned milestone sum (${allocatedSum}).`,
          { expectedTotalMinor: budgetTotal, actualTotalMinor: allocatedSum, currency }
        );
      }
      if (assignedCount === 0 && plan.totalProposedAmountMinor !== null) {
        throw reconciliationError(
          "Plan totalProposedAmountMinor cannot be set when no milestones have assigned amounts.",
          { expectedTotalMinor: budgetTotal, actualTotalMinor: plan.totalProposedAmountMinor, currency }
        );
      }
    }
  }

  return {
    ...plan,
    milestones: [...plan.milestones].sort((a, b) => a.position - b.position),
  };
}

/**
 * Generates an AI-proposed standalone milestone plan without mutating persistent storage.
 */
export async function generateMilestonePlan(
  input: GenerateMilestonePlanInput,
  options: GenerateMilestonePlanOptions = {}
): Promise<GenerateMilestonePlanResult> {
  const startTime = Date.now();
  const title = input.projectTitle?.trim() ?? "";
  const brief = input.projectBrief?.trim() ?? "";

  if (title.length < 2) {
    throw new AiOutputValidationError("Project title must be at least 2 characters to generate milestones.");
  }

  const hasSufficientContext =
    brief.length >= 10 || Boolean(input.structuredBrief) || Boolean(input.existingAgreement);
  if (!hasSufficientContext) {
    throw new AiOutputValidationError(
      "Insufficient project context: provide a brief of at least 10 characters, a structured brief, or an existing agreement."
    );
  }

  const establishedCurrency =
    input.establishedCurrency != null && input.establishedCurrency.trim().length > 0
      ? input.establishedCurrency.trim().toUpperCase()
      : null;

  if (establishedCurrency !== null && !/^[A-Z]{3}$/.test(establishedCurrency)) {
    throw reconciliationError(
      `Invalid currency code: "${input.establishedCurrency}". Currency must be a 3-letter ISO code.`,
      { currency: establishedCurrency }
    );
  }

  const hasBudgetInput =
    input.confirmedBudgetMinor !== undefined && input.confirmedBudgetMinor !== null;
  if (hasBudgetInput) {
    if (
      typeof input.confirmedBudgetMinor !== "number" ||
      !Number.isSafeInteger(input.confirmedBudgetMinor) ||
      input.confirmedBudgetMinor <= 0
    ) {
      throw reconciliationError(
        `Invalid confirmed budget: expected positive integer minor units, received ${input.confirmedBudgetMinor}.`,
        { currency: establishedCurrency }
      );
    }
    if (!establishedCurrency) {
      throw reconciliationError(
        "Established 3-letter currency is required when a confirmed budget is provided.",
        { expectedTotalMinor: input.confirmedBudgetMinor ?? 0 }
      );
    }
  }

  const hasConfirmedBudget = Boolean(hasBudgetInput && establishedCurrency);
  const allocateBudget = input.allocateBudget ?? hasConfirmedBudget;

  if (allocateBudget && !hasConfirmedBudget) {
    throw reconciliationError(
      "Cannot allocate milestone amounts because the project does not have a confirmed budget and currency.",
      { currency: establishedCurrency }
    );
  }

  const provider = options.provider ?? getAiProvider();
  const prompt = buildMilestonePlanPrompt({
    projectTitle: title,
    projectBrief: brief,
    structuredBrief: input.structuredBrief,
    existingAgreement: input.existingAgreement,
    existingMilestones: input.existingMilestones,
    confirmedBudgetMinor: hasConfirmedBudget ? input.confirmedBudgetMinor : null,
    establishedCurrency,
    allocateBudget,
    startDate: input.startDate ?? null,
    targetEndDate: input.targetEndDate ?? null,
    planningGoal: input.planningGoal ?? null,
  });

  try {
    const result = await provider.generateStructured(
      prompt,
      {
        safeParse: (val: unknown) => {
          if (val && typeof val === "object") {
            return milestonePlanSchema.safeParse(
              normalizeRawMilestonePlan(val as Record<string, unknown>)
            );
          }
          return milestonePlanSchema.safeParse(val);
        },
      } as unknown as z.ZodType<MilestonePlan>,
      {
        systemInstruction: MILESTONE_GENERATION_SYSTEM_INSTRUCTION,
        timeoutMs: options.timeoutMs ?? 48000,
        signal: options.signal,
        temperature: 0.2,
      }
    );

    const validatedPlan = validateMilestonePlanInvariants(result.data, {
      hasConfirmedBudget,
      shouldAllocateBudget: allocateBudget,
      confirmedBudgetMinor: hasConfirmedBudget ? (input.confirmedBudgetMinor ?? null) : null,
      establishedCurrency,
    });

    const durationMs = Date.now() - startTime;

    await recordAiAudit({
      feature: "milestone_generation",
      projectId: options.projectId,
      userId: options.userId,
      model: result.model,
      durationMs,
      tokenUsage: result.usage,
      outcome: "success",
      metadata: {
        milestoneCount: validatedPlan.milestoneCount,
        hasStructuredBrief: Boolean(input.structuredBrief),
        hasExistingAgreement: Boolean(input.existingAgreement),
        existingMilestonesCount: input.existingMilestones?.length ?? 0,
        hasConfirmedBudget,
        allocateBudget,
        allocatesFullBudget: validatedPlan.allocatesFullBudget,
      },
    });

    return {
      plan: validatedPlan,
      model: result.model,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorCategory = error instanceof AiError ? error.name : "UNKNOWN_ERROR";

    await recordAiAudit({
      feature: "milestone_generation",
      projectId: options.projectId,
      userId: options.userId,
      model: provider.providerName,
      durationMs,
      outcome: "error",
      errorCategory,
      metadata: {
        hasStructuredBrief: Boolean(input.structuredBrief),
        hasExistingAgreement: Boolean(input.existingAgreement),
        hasConfirmedBudget,
        allocateBudget,
      },
    });

    if (
      error instanceof AiConfigurationError ||
      error instanceof AiRateLimitError ||
      error instanceof AiFinancialReconciliationError ||
      error instanceof AiOutputValidationError ||
      error instanceof AiUnavailableError
    ) {
      throw error;
    }

    throw new AiUnavailableError(
      error instanceof Error ? error.message : "AI milestone generation failed unexpectedly.",
      { cause: error }
    );
  }
}
