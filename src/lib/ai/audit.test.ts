import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAiAuditSinks,
  recordAiAudit,
  registerAiAuditSink,
  sanitizeAuditMetadata,
  type AiAuditRecord,
} from "./audit";

describe("AI Audit Utilities (src/lib/ai/audit.ts)", () => {
  afterEach(() => {
    clearAiAuditSinks();
  });

  it("creates a standardized audit record without database writes", async () => {
    const record = await recordAiAudit({
      feature: "brief_structuring",
      projectId: "proj-123",
      userId: "user-456",
      model: "gemini-3.8-flash",
      durationMs: 1450,
      tokenUsage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
      outcome: "success",
    });

    expect(record.feature).toBe("brief_structuring");
    expect(record.projectId).toBe("proj-123");
    expect(record.userId).toBe("user-456");
    expect(record.model).toBe("gemini-3.8-flash");
    expect(record.durationMs).toBe(1450);
    expect(record.outcome).toBe("success");
    expect(record.tokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
    });
    expect(record.timestamp).toBeDefined();
  });

  it("notifies registered sinks and unregisters cleanly", async () => {
    const sinkMock = vi.fn();
    const unregister = registerAiAuditSink(sinkMock);

    await recordAiAudit({
      feature: "agreement_generation",
      model: "gemini-3.8-flash",
      durationMs: 900,
      outcome: "success",
    });

    expect(sinkMock).toHaveBeenCalledTimes(1);
    const captured = sinkMock.mock.calls[0][0] as AiAuditRecord;
    expect(captured.feature).toBe("agreement_generation");

    unregister();

    await recordAiAudit({
      feature: "agreement_generation",
      model: "gemini-3.8-flash",
      durationMs: 900,
      outcome: "success",
    });

    expect(sinkMock).toHaveBeenCalledTimes(1); // Not called after unregistering
  });

  it("does not fail execution when a registered sink throws an error", async () => {
    const faultySink = vi.fn().mockImplementation(() => {
      throw new Error("Simulated sink crash (e.g. logging service down)");
    });

    registerAiAuditSink(faultySink);

    // Must resolve successfully without throwing
    const record = await recordAiAudit({
      feature: "scope_analysis",
      model: "gemini-3.8-flash",
      durationMs: 500,
      outcome: "success",
    });

    expect(faultySink).toHaveBeenCalledTimes(1);
    expect(record.feature).toBe("scope_analysis");
  });

  it("sanitizes metadata by stripping raw prompts and redacting secrets", () => {
    const rawMetadata = {
      milestonesCount: 3,
      promptText: "Confidential raw user prompt that must not be in audit logs",
      rawCompletion: "Raw completion text",
      apiKey: "AIzaSyTestKey1234567890123456789012345678",
      nested: {
        token: "Bearer ya29.secrettokenhere",
        tag: "project-1",
      },
    };

    const sanitized = sanitizeAuditMetadata(rawMetadata);
    expect(sanitized).toBeDefined();
    expect(sanitized?.milestonesCount).toBe(3);
    // Excluded fields
    expect(sanitized?.promptText).toBeUndefined();
    expect(sanitized?.rawCompletion).toBeUndefined();
    // Redacted fields
    expect(sanitized?.apiKey).not.toContain("AIzaSyTestKey1234567890123456789012345678");
    expect((sanitized?.nested as Record<string, unknown>)?.tag).toBe("project-1");
    expect((sanitized?.nested as Record<string, unknown>)?.token).not.toContain("secrettokenhere");
  });

  it("handles empty or undefined metadata safely", () => {
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
    expect(sanitizeAuditMetadata({})).toEqual({});
  });
});
