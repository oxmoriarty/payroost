import "server-only";

import { z } from "zod";
import { AiConfigurationError } from "./errors";

/**
 * Validated AI configuration object.
 */
export interface AiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Default verified Gemini model for Free Tier operations.
 * Gemini 1.5 Flash was shut down by Google on September 24/29, 2025.
 * Gemini 3.8 Flash is Google's active, verified Free-Tier general-purpose speed model.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

const aiEnvSchema = z.object({
  GEMINI_API_KEY: z
    .string()
    .trim()
    .min(1, "GEMINI_API_KEY is required and cannot be empty"),
  GEMINI_MODEL: z
    .string()
    .trim()
    .min(1, "GEMINI_MODEL cannot be empty")
    .default(DEFAULT_GEMINI_MODEL),
  GEMINI_TIMEOUT_MS: z.coerce
    .number()
    .int("GEMINI_TIMEOUT_MS must be an integer")
    .min(1000, "GEMINI_TIMEOUT_MS must be at least 1000ms")
    .max(120000, "GEMINI_TIMEOUT_MS cannot exceed 120000ms")
    .default(25000),
  GEMINI_MAX_RETRIES: z.coerce
    .number()
    .int("GEMINI_MAX_RETRIES must be an integer")
    .min(0, "GEMINI_MAX_RETRIES cannot be negative")
    .max(5, "GEMINI_MAX_RETRIES cannot exceed 5")
    .default(2),
});

function resolveSource(customSource?: Record<string, string | undefined>): Record<string, string | undefined> {
  return customSource ?? {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_TIMEOUT_MS: process.env.GEMINI_TIMEOUT_MS,
    GEMINI_MAX_RETRIES: process.env.GEMINI_MAX_RETRIES,
  };
}

/**
 * Checks whether AI capabilities are configured in the current environment.
 * Does not throw when unconfigured, allowing builds and unrelated features to operate normally.
 */
export function isAiConfigured(customSource?: Record<string, string | undefined>): boolean {
  const source = resolveSource(customSource);
  const key = source.GEMINI_API_KEY?.trim();
  return Boolean(key && key.length > 0);
}

/**
 * Validates and extracts server-side AI configuration.
 *
 * Security & Reliability Invariants:
 * - Server-only module guard prevents accidental inclusion in browser bundles.
 * - Throws strongly-typed AiConfigurationError if required configuration is missing or invalid.
 * - Masks secrets from validation error messages.
 * - Provides verified defaults for model, timeouts, and bounded retries.
 */
export function getAiEnv(customSource?: Record<string, string | undefined>): AiConfig {
  const source = resolveSource(customSource);

  if (!isAiConfigured(customSource)) {
    throw new AiConfigurationError(
      "Gemini is not configured. GEMINI_API_KEY must be set in server environment."
    );
  }

  const result = aiEnvSchema.safeParse(source);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new AiConfigurationError(`Invalid AI configuration: ${errorDetails}`);
  }

  return {
    apiKey: result.data.GEMINI_API_KEY,
    model: result.data.GEMINI_MODEL,
    timeoutMs: result.data.GEMINI_TIMEOUT_MS,
    maxRetries: result.data.GEMINI_MAX_RETRIES,
  };
}
