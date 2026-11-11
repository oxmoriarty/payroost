import "server-only";

import type { z } from "zod";

/**
 * Token usage telemetry reported by the upstream AI provider.
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Generation options for AI provider requests.
 */
export interface AiGenerationOptions {
  temperature?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
}

/**
 * Standardized result returned by all AI providers.
 */
export interface AiGenerationResult<T> {
  data: T;
  rawText: string;
  model: string;
  usage?: TokenUsage;
  durationMs: number;
}

/**
 * Abstract interface for AI providers.
 * Decouples feature logic from specific models or vendors (e.g., Gemini).
 */
export interface AiProvider {
  readonly providerName: string;
  generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: AiGenerationOptions
  ): Promise<AiGenerationResult<T>>;
}
