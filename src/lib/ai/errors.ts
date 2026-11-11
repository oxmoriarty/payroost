import "server-only";

import type { z } from "zod";

/**
 * Sanitizes sensitive credentials, API keys, and tokens from error messages and logs.
 */
export function redactSensitiveData(message: string): string {
  if (!message || typeof message !== "string") return "";
  return message
    .replace(/(AIza[0-9A-Za-z\-_]{25,45})/g, "[REDACTED_API_KEY]")
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED_TOKEN]")
    .replace(
      /((?:api[_-]?key|client[_-]?secret|key|secret|password|token)\s*[:=]\s*)([^\s&,;"]+)/gi,
      "$1[REDACTED]"
    );
}

/**
 * Base abstract error class for all PayRoost AI domain errors.
 */
export abstract class AiError extends Error {
  readonly isAiError = true;

  constructor(message: string) {
    super(redactSensitiveData(message));
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when AI configuration is missing, invalid, unparseable, or rejected as invalid/unsupported (e.g. HTTP 400, 401, 403, 404).
 */
export class AiConfigurationError extends AiError {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message);
    this.status = options?.status;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when the AI provider is unreachable, times out, or encounters upstream server errors.
 */
export class AiUnavailableError extends AiError {
  readonly status?: number;
  readonly isTimeout: boolean;

  constructor(message: string, options?: { status?: number; isTimeout?: boolean; cause?: unknown }) {
    super(message);
    this.status = options?.status;
    this.isTimeout = Boolean(options?.isTimeout);
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when requests are rate-limited or throttled (HTTP 429).
 */
export class AiRateLimitError extends AiError {
  readonly retryAfterSeconds?: number;

  constructor(message: string, options?: { retryAfterSeconds?: number; cause?: unknown }) {
    super(message);
    this.retryAfterSeconds = options?.retryAfterSeconds;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Normalized validation issue representation.
 */
export interface NormalizedValidationIssue {
  path: string;
  message: string;
  code?: string;
}

/**
 * Thrown when AI response text is empty, malformed JSON, or fails Zod schema validation.
 */
export class AiOutputValidationError extends AiError {
  readonly issues: NormalizedValidationIssue[];
  readonly rawOutputPreview?: string;

  constructor(
    message: string,
    options?: {
      zodError?: z.ZodError;
      issues?: NormalizedValidationIssue[];
      rawOutput?: string;
    }
  ) {
    super(message);
    if (options?.zodError) {
      this.issues = options.zodError.issues.map((i) => ({
        path: i.path.join("."),
        message: redactSensitiveData(i.message),
        code: i.code,
      }));
    } else {
      this.issues = options?.issues ?? [];
    }

    if (options?.rawOutput) {
      // Safe, bounded preview (max 200 chars) without leaking large prompts or private data
      this.rawOutputPreview = redactSensitiveData(options.rawOutput.slice(0, 200));
    }
  }
}

/**
 * Thrown when AI-suggested milestone amounts fail exact minor currency unit reconciliation.
 */
export class AiFinancialReconciliationError extends AiError {
  readonly expectedTotalMinor: number;
  readonly actualTotalMinor: number;
  readonly currency: string;

  constructor(
    message: string,
    options: {
      expectedTotalMinor: number;
      actualTotalMinor: number;
      currency: string;
    }
  ) {
    super(message);
    this.expectedTotalMinor = options.expectedTotalMinor;
    this.actualTotalMinor = options.actualTotalMinor;
    this.currency = options.currency;
  }
}
