import "server-only";

import type { z } from "zod";
import { DEFAULT_GROQ_MODEL, getGroqEnv, type GroqConfig } from "./env";
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

interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GroqChoice {
  message?: {
    content?: string;
    role?: string;
  };
  finish_reason?: string;
}

interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface GroqResponsePayload {
  choices?: GroqChoice[];
  usage?: GroqUsage;
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
}

export interface GroqProviderOptions {
  config?: Partial<GroqConfig>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

function stripMarkdownCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(trimmed);
  if (match && typeof match[1] === "string") {
    return match[1].trim();
  }
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/**
 * Groq AI Provider implementing the standardized AiProvider interface.
 * Connects to Groq's high-speed LPU inference endpoint via OpenAI-compatible chat completions.
 */
export class GroqProvider implements AiProvider {
  readonly providerName = "groq";
  private config: GroqConfig;
  private fetchFn: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(options: GroqProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn =
      options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    if (options.config?.apiKey) {
      this.config = {
        apiKey: options.config.apiKey,
        model: options.config.model ?? DEFAULT_GROQ_MODEL,
        timeoutMs: options.config.timeoutMs ?? 25000,
        maxRetries: options.config.maxRetries ?? 2,
        baseUrl: options.config.baseUrl ?? "https://api.groq.com/openai/v1",
      };
    } else {
      this.config = getGroqEnv(
        options.config
          ? (options.config as unknown as Record<string, string | undefined>)
          : undefined
      );
    }
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: AiGenerationOptions
  ): Promise<AiGenerationResult<T>> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const maxRetries = this.config.maxRetries;
    const deadline = startTime + timeoutMs;

    const messages: GroqMessage[] = [];
    if (options?.systemInstruction) {
      messages.push({ role: "system", content: options.systemInstruction });
    }
    messages.push({
      role: "user",
      content:
        prompt +
        "\n\nIMPORTANT: Return ONLY a valid JSON object matching the requested schema. Do not include markdown explanation, code blocks, or preamble outside the JSON object.",
    });

    const requestBody = {
      model: this.config.model,
      messages,
      response_format: { type: "json_object" },
      temperature: options?.temperature ?? 0.2,
      ...(options?.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const now = Date.now();
      const remainingMs = deadline - now;
      if (remainingMs <= 50) {
        throw new AiUnavailableError("Groq request timed out before attempt could start.", {
          isTimeout: true,
          cause: lastError,
        });
      }

      if (attempt > 0) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), remainingMs);
        if (backoffMs > 0) {
          await this.sleepFn(backoffMs);
        }
      }

      const attemptRemainingMs = Math.max(50, deadline - Date.now());
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort("timeout");
      }, attemptRemainingMs);

      const onCallerAbort = () => {
        controller.abort(options?.signal?.reason ?? "caller_aborted");
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeoutId);
          throw new AiUnavailableError("AI operation aborted by caller.", {
            cause: options.signal.reason,
          });
        }
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
      }

      try {
        const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errorPayload: GroqResponsePayload | null = null;
          let rawErrorText = "";
          try {
            rawErrorText = await response.text();
            errorPayload = JSON.parse(rawErrorText);
          } catch {
            // raw error remains in text
          }

          const status = response.status;
          const remoteMessage =
            errorPayload?.error?.message ??
            rawErrorText ??
            `Groq request failed with HTTP ${status}`;
          const cleanMessage = redactSensitiveData(remoteMessage);

          if (status === 401 || status === 403) {
            throw new AiConfigurationError(`Groq API key error: ${cleanMessage}`, { status });
          }

          if (status === 404) {
            throw new AiConfigurationError(`Groq model not found: ${cleanMessage}`, { status });
          }

          if (status === 429) {
            lastError = new AiRateLimitError(`Groq rate limit exceeded: ${cleanMessage}`);
            continue;
          }

          if (status >= 500 && status <= 599) {
            lastError = new AiUnavailableError(`Groq server error (${status}): ${cleanMessage}`, {
              status,
            });
            continue;
          }

          throw new AiConfigurationError(`Groq request rejected (${status}): ${cleanMessage}`, {
            status,
          });
        }

        const data = (await response.json()) as GroqResponsePayload;
        const rawContent = data.choices?.[0]?.message?.content;

        if (!rawContent || !rawContent.trim()) {
          throw new AiOutputValidationError("Groq returned an empty response body.");
        }

        const cleanedContent = stripMarkdownCodeFence(rawContent);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(cleanedContent);
        } catch (jsonErr) {
          throw new AiOutputValidationError(
            "Groq response could not be parsed as JSON: " +
              (jsonErr instanceof Error ? jsonErr.message : "Malformed"),
            { rawOutput: cleanedContent }
          );
        }

        const validation = schema.safeParse(parsedJson);
        if (!validation.success) {
          throw new AiOutputValidationError("Groq output failed schema validation", {
            zodError: validation.error,
            rawOutput: cleanedContent,
          });
        }

        const durationMs = Date.now() - startTime;
        const usage: TokenUsage | undefined = data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined;

        return {
          data: validation.data,
          rawText: cleanedContent,
          model: this.config.model,
          usage,
          durationMs,
        };
      } catch (err) {
        if (err instanceof AiConfigurationError || err instanceof AiOutputValidationError) {
          throw err;
        }

        const isTimeout =
          controller.signal.aborted &&
          (controller.signal.reason === "timeout" || controller.signal.reason === undefined);
        const isCallerAbort = options?.signal?.aborted;

        if (isTimeout) {
          throw new AiUnavailableError("Groq request timed out.", { isTimeout: true, cause: err });
        }
        if (isCallerAbort) {
          throw new AiUnavailableError("AI operation was aborted by the caller.", {
            cause: options.signal?.reason,
          });
        }

        lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timeoutId);
        if (options?.signal) {
          options.signal.removeEventListener("abort", onCallerAbort);
        }
      }
    }

    throw lastError ?? new AiUnavailableError("Groq request failed after maximum retries.");
  }
}
