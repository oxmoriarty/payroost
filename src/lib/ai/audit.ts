import "server-only";

import { redactSensitiveData } from "./errors";
import type { TokenUsage } from "./types";

/**
 * Standardized metadata record for AI operations.
 * Captures execution telemetry without persisting raw prompts or full model responses.
 */
export interface AiAuditRecord {
  feature: string;
  projectId?: string;
  userId?: string;
  model: string;
  durationMs: number;
  tokenUsage?: TokenUsage;
  outcome: "success" | "error";
  errorCategory?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type AiAuditSink = (record: AiAuditRecord) => Promise<void> | void;

const registeredSinks: Set<AiAuditSink> = new Set();

/**
 * Registers an audit sink listener (e.g. for structured loggers or future activity-event adapters).
 */
export function registerAiAuditSink(sink: AiAuditSink): () => void {
  registeredSinks.add(sink);
  return () => {
    registeredSinks.delete(sink);
  };
}

/**
 * Clears all registered audit sinks (primarily for isolated test environments).
 */
export function clearAiAuditSinks(): void {
  registeredSinks.clear();
}

/**
 * Sanitizes arbitrary metadata values to prevent credentials, secrets, or raw prompt leakage.
 */
export function sanitizeAuditMetadata(
  metadata?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    // Exclude raw prompts or full completion payloads from telemetry
    if (/prompt|completion|response|rawText|body/i.test(key)) {
      continue;
    }

    if (typeof value === "string") {
      sanitized[key] = redactSensitiveData(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeAuditMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Creates and records an AI execution audit event.
 * Dispatches to registered sinks without performing direct database writes.
 */
export async function recordAiAudit(params: {
  feature: string;
  projectId?: string;
  userId?: string;
  model: string;
  durationMs: number;
  tokenUsage?: TokenUsage;
  outcome: "success" | "error";
  errorCategory?: string;
  metadata?: Record<string, unknown>;
}): Promise<AiAuditRecord> {
  const record: AiAuditRecord = {
    feature: params.feature,
    projectId: params.projectId,
    userId: params.userId,
    model: params.model,
    durationMs: Math.max(0, params.durationMs),
    tokenUsage: params.tokenUsage,
    outcome: params.outcome,
    errorCategory: params.errorCategory,
    timestamp: new Date().toISOString(),
    metadata: sanitizeAuditMetadata(params.metadata),
  };

  for (const sink of registeredSinks) {
    try {
      await sink(record);
    } catch {
      // Sinks must never fail caller execution
    }
  }

  return record;
}
