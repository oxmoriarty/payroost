import "server-only";

import type { z } from "zod";
import type {
  AiGenerationOptions,
  AiGenerationResult,
  AiProvider,
  TokenUsage,
} from "./types";
import {
  AiOutputValidationError,
  AiUnavailableError,
} from "./errors";

export type {
  AiGenerationOptions,
  AiGenerationResult,
  AiProvider,
  TokenUsage,
} from "./types";

export interface MockAiProviderOptions {
  modelName?: string;
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  responses?: unknown[];
  errorQueue?: Error[];
}

export interface RecordedAiCall {
  prompt: string;
  options?: AiGenerationOptions;
  timestamp: number;
}

/**
 * Deterministic Mock AI Provider for testing and local development.
 * Enables zero-network, reliable testing of all higher-level AI workflows.
 */
export class MockAiProvider implements AiProvider {
  readonly providerName = "mock";
  private modelName: string;
  private latencyMs: number;
  private tokenUsage: TokenUsage;
  private responseQueue: unknown[];
  private errorQueue: Error[];
  readonly recordedCalls: RecordedAiCall[] = [];

  constructor(options: MockAiProviderOptions = {}) {
    this.modelName = options.modelName ?? "mock-ai-model";
    this.latencyMs = options.latencyMs ?? 0;
    this.tokenUsage = options.tokenUsage ?? {
      promptTokens: 100,
      completionTokens: 250,
      totalTokens: 350,
    };
    this.responseQueue = options.responses ? [...options.responses] : [];
    this.errorQueue = options.errorQueue ? [...options.errorQueue] : [];
  }

  enqueueResponse(response: unknown): void {
    this.responseQueue.push(response);
  }

  enqueueError(error: Error): void {
    this.errorQueue.push(error);
  }

  clearCalls(): void {
    this.recordedCalls.length = 0;
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: AiGenerationOptions
  ): Promise<AiGenerationResult<T>> {
    const startTime = Date.now();

    this.recordedCalls.push({
      prompt,
      options,
      timestamp: startTime,
    });

    if (options?.signal?.aborted) {
      throw new AiUnavailableError("Request was aborted before execution.", {
        isTimeout: true,
      });
    }

    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, this.latencyMs);

        const onAbort = () => {
          clearTimeout(timer);
          reject(
            new AiUnavailableError("Request aborted during simulated latency.", {
              isTimeout: true,
            })
          );
        };

        if (options?.signal) {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }

    if (this.errorQueue.length > 0) {
      const error = this.errorQueue.shift()!;
      throw error;
    }

    if (this.responseQueue.length === 0) {
      throw new AiUnavailableError(
        "MockAiProvider response queue is empty. Enqueue a mock response before invocation."
      );
    }

    const nextResponse = this.responseQueue.shift();

    let rawText: string;
    let dataToValidate: unknown;

    if (typeof nextResponse === "string") {
      rawText = nextResponse;
      try {
        dataToValidate = JSON.parse(nextResponse);
      } catch {
        throw new AiOutputValidationError("AI returned malformed JSON.", {
          rawOutput: nextResponse,
        });
      }
    } else {
      rawText = JSON.stringify(nextResponse);
      dataToValidate = nextResponse;
    }

    const parsed = schema.safeParse(dataToValidate);
    if (!parsed.success) {
      throw new AiOutputValidationError("AI returned an incomplete or invalid payload.", {
        zodError: parsed.error,
        rawOutput: rawText,
      });
    }

    return {
      data: parsed.data,
      rawText,
      model: this.modelName,
      usage: this.tokenUsage,
      durationMs: Date.now() - startTime,
    };
  }
}
