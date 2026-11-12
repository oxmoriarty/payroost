import "server-only";

import type { z } from "zod";
import type {
  AiGenerationOptions,
  AiGenerationResult,
  AiProvider,
} from "./types";

export interface ResilientAiProviderOptions {
  primary: AiProvider;
  fallback?: AiProvider;
  onFallback?: (primaryError: Error, fallbackProvider: AiProvider) => void;
}

/**
 * Resilient AI Provider implementing an automatic Primary -> Fallback failover strategy.
 * Attempts inference with the high-speed primary provider (e.g. Groq); if it encounters
 * rate limits, timeouts, server errors, or key rejections, it seamlessly switches to the
 * fallback provider (e.g. Gemini) so the user workflow is never interrupted.
 */
export class ResilientAiProvider implements AiProvider {
  readonly providerName: string;
  private primary: AiProvider;
  private fallback?: AiProvider;
  private onFallback?: (primaryError: Error, fallbackProvider: AiProvider) => void;

  constructor(options: ResilientAiProviderOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.onFallback = options.onFallback;
    const fallbackName = options.fallback?.providerName;
    this.providerName = fallbackName
      ? `${this.primary.providerName}->${fallbackName}`
      : this.primary.providerName;
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: AiGenerationOptions
  ): Promise<AiGenerationResult<T>> {
    if (!this.fallback) {
      return this.primary.generateStructured(prompt, schema, options);
    }

    try {
      return await this.primary.generateStructured(prompt, schema, options);
    } catch (primaryErr) {
      const error = primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr));
      console.warn(
        `[ResilientAiProvider] Primary provider '${this.primary.providerName}' failed. Executing fallback to '${this.fallback.providerName}'. Reason: ${error.message}`
      );
      this.onFallback?.(error, this.fallback);
      return await this.fallback.generateStructured(prompt, schema, options);
    }
  }
}
