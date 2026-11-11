import "server-only";

import { getAiProvider } from "@/lib/ai/client";
import { recordAiAudit } from "@/lib/ai/audit";
import { AiError } from "@/lib/ai/errors";
import type { AiProvider } from "@/lib/ai/types";
import { structuredBriefSchema, type StructuredBrief } from "./schema";
import {
  BRIEF_STRUCTURING_SYSTEM_INSTRUCTION,
  buildBriefStructuringPrompt,
} from "./prompts";

export interface StructureProjectBriefInput {
  description: string;
  context?: {
    clientName?: string;
    existingTitle?: string;
  };
  projectId?: string;
  userId?: string;
}

export interface StructureProjectBriefOptions {
  provider?: AiProvider;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface StructuredBriefResult {
  brief: StructuredBrief;
  model: string;
  durationMs: number;
}

/**
 * Transforms an unstructured client project description into a structured, reviewable project brief.
 * Uses the configured PayRoost AI Foundation provider (Gemini 3.8 Flash Free Tier by default).
 */
export async function structureProjectBrief(
  input: StructureProjectBriefInput,
  options: StructureProjectBriefOptions = {}
): Promise<StructuredBriefResult> {
  const startTime = Date.now();
  const trimmedDescription = input.description?.trim() ?? "";

  if (trimmedDescription.length < 10) {
    throw new Error("Project description must be at least 10 characters long.");
  }
  if (trimmedDescription.length > 10000) {
    throw new Error("Project description cannot exceed 10,000 characters.");
  }

  const provider = options.provider ?? getAiProvider();
  const prompt = buildBriefStructuringPrompt(trimmedDescription, input.context);

  try {
    const result = await provider.generateStructured(prompt, structuredBriefSchema, {
      systemInstruction: BRIEF_STRUCTURING_SYSTEM_INSTRUCTION,
      timeoutMs: options.timeoutMs ?? 30000,
      signal: options.signal,
      temperature: 0.2,
    });

    const durationMs = Date.now() - startTime;

    // Record telemetry audit event without persisting sensitive data
    await recordAiAudit({
      feature: "project_brief_structuring",
      projectId: input.projectId,
      userId: input.userId,
      model: result.model,
      durationMs,
      tokenUsage: result.usage,
      outcome: "success",
      metadata: {
        descriptionLength: trimmedDescription.length,
        hasClientContext: Boolean(input.context?.clientName),
        deliverablesCount: result.data.deliverables.length,
        openQuestionsCount: result.data.openQuestions.length,
        assumptionsCount: result.data.assumptions.length,
      },
    });

    return {
      brief: result.data,
      model: result.model,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorCategory = error instanceof AiError ? error.name : "UNKNOWN_ERROR";

    await recordAiAudit({
      feature: "project_brief_structuring",
      projectId: input.projectId,
      userId: input.userId,
      model: provider.providerName,
      durationMs,
      outcome: "error",
      errorCategory,
      metadata: {
        descriptionLength: trimmedDescription.length,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }
}

import { formatBriefToMarkdown } from "./format";
export { formatBriefToMarkdown };
