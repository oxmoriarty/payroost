import "server-only";

import type { z } from "zod";
import { DEFAULT_GEMINI_MODEL, getAiEnv, type AiConfig } from "./env";
import {
  AiConfigurationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
  redactSensitiveData,
} from "./errors";
import type {
  AiGenerationOptions,
  AiGenerationResult,
  AiProvider,
  TokenUsage,
} from "./types";

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
    role?: string;
  };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponsePayload {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export interface GeminiProviderOptions {
  config?: Partial<AiConfig>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Robust Google Gemini provider implementation.
 * Encapsulates direct REST communication, exponential backoff, timeouts, and Zod validation.
 */
export class GeminiProvider implements AiProvider {
  readonly providerName = "gemini";
  private config: AiConfig;
  private fetchFn: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(options: GeminiProviderOptions = {}) {
    const baseConfig = options.config?.apiKey
      ? {
          apiKey: options.config.apiKey,
          model: options.config.model ?? DEFAULT_GEMINI_MODEL,
          timeoutMs: options.config.timeoutMs ?? 25000,
          maxRetries: options.config.maxRetries ?? 2,
        }
      : getAiEnv(options.config ? (options.config as unknown as Record<string, string | undefined>) : undefined);

    this.config = baseConfig;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: AiGenerationOptions
  ): Promise<AiGenerationResult<T>> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const maxRetries = this.config.maxRetries;

    const bodyPayload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(options?.systemInstruction
        ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
        : {}),
      generationConfig: {
        responseMimeType: "application/json",
        temperature: options?.temperature ?? 0.2,
        ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options?.responseSchema ? { responseSchema: options.responseSchema } : {}),
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.config.model
    )}:generateContent`;

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= maxRetries) {
      if (options?.signal?.aborted) {
        throw new AiUnavailableError("Request was aborted before execution.", {
          isTimeout: true,
        });
      }

      const controller = new AbortController();
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const onCallerAbort = () => {
        controller.abort();
      };

      if (options?.signal) {
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
      }

      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.config.apiKey,
          },
          signal: controller.signal,
          body: JSON.stringify(bodyPayload),
        });

        if (response.ok) {
          const payload = (await response.json()) as GeminiResponsePayload;
          const rawText = payload.candidates?.[0]?.content?.parts
            ?.map((part) => part.text ?? "")
            .join("");

          if (!rawText || rawText.trim().length === 0) {
            throw new AiOutputValidationError("Gemini returned an empty response.", {
              rawOutput: "",
            });
          }

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawText);
          } catch {
            throw new AiOutputValidationError("Gemini returned malformed JSON.", {
              rawOutput: rawText,
            });
          }

          const validation = schema.safeParse(parsedJson);
          if (!validation.success) {
            throw new AiOutputValidationError("Gemini output failed schema validation.", {
              zodError: validation.error,
              rawOutput: rawText,
            });
          }

          const usage: TokenUsage = {
            promptTokens: payload.usageMetadata?.promptTokenCount,
            completionTokens: payload.usageMetadata?.candidatesTokenCount,
            totalTokens: payload.usageMetadata?.totalTokenCount,
          };

          return {
            data: validation.data,
            rawText,
            model: this.config.model,
            usage,
            durationMs: Date.now() - startTime,
          };
        }

        // Handle HTTP errors
        const status = response.status;
        let responseBodyText = "";
        try {
          responseBodyText = await response.text();
        } catch {
          // ignore read failure
        }

        // 429 Rate Limit
        if (status === 429) {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;

          if (attempt < maxRetries) {
            attempt++;
            const backoffMs = retryAfterSeconds && !Number.isNaN(retryAfterSeconds)
              ? Math.min(retryAfterSeconds * 1000, 10000)
              : Math.min(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200), 10000);
            await this.sleepFn(backoffMs);
            continue;
          }

          throw new AiRateLimitError("Gemini API rate limit exceeded (HTTP 429).", {
            retryAfterSeconds: Number.isNaN(retryAfterSeconds) ? undefined : retryAfterSeconds,
          });
        }

        // Retryable 5xx Server Errors (500, 502, 503, 504)
        if (status >= 500 && status <= 504) {
          if (attempt < maxRetries) {
            attempt++;
            const backoffMs = Math.min(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200), 10000);
            await this.sleepFn(backoffMs);
            continue;
          }

          throw new AiUnavailableError(`Gemini service is unavailable (HTTP ${status}).`, {
            status,
          });
        }

        // 401 / 403 Authentication / Authorization
        if (status === 401 || status === 403) {
          throw new AiConfigurationError(
            `Gemini API key rejected or unauthorized (HTTP ${status}). Check server configuration.`,
            { status }
          );
        }

        // 404 Model or endpoint not found
        if (status === 404) {
          throw new AiConfigurationError(
            `Gemini model or endpoint not found (HTTP 404). Check GEMINI_MODEL configuration: ${redactSensitiveData(responseBodyText.slice(0, 200))}`,
            { status: 404 }
          );
        }

        // 400 Bad Request / Unsupported configuration
        if (status === 400) {
          throw new AiConfigurationError(
            `Gemini API request invalid or unsupported (HTTP 400): ${redactSensitiveData(responseBodyText.slice(0, 200))}`,
            { status: 400 }
          );
        }

        // Other non-retryable 4xx client errors
        throw new AiConfigurationError(
          `Gemini API request rejected with HTTP ${status}: ${redactSensitiveData(responseBodyText.slice(0, 200))}`,
          { status }
        );
      } catch (err: unknown) {
        if (
          err instanceof AiConfigurationError ||
          err instanceof AiRateLimitError ||
          err instanceof AiOutputValidationError
        ) {
          throw err;
        }

        if (timedOut) {
          throw new AiUnavailableError("Gemini request timed out.", { isTimeout: true });
        }

        if (options?.signal?.aborted) {
          throw new AiUnavailableError("Gemini request was cancelled by caller.", { isTimeout: false });
        }

        // Network or fetch exceptions
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries) {
          attempt++;
          const backoffMs = Math.min(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200), 10000);
          await this.sleepFn(backoffMs);
          continue;
        }

        throw new AiUnavailableError("Gemini service is currently unreachable.", {
          cause: lastError,
        });
      } finally {
        clearTimeout(timeoutId);
        if (options?.signal) {
          options.signal.removeEventListener("abort", onCallerAbort);
        }
      }
    }

    throw lastError ?? new AiUnavailableError("Gemini request failed after maximum retries.");
  }
}

/**
 * Factory for creating the active AI provider based on environment configuration.
 */
export function getAiProvider(customConfig?: Partial<AiConfig>): AiProvider {
  return new GeminiProvider({ config: customConfig });
}
