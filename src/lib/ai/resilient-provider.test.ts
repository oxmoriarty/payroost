import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ResilientAiProvider } from "./resilient-provider";
import { MockAiProvider } from "./provider";
import { AiRateLimitError, AiUnavailableError } from "./errors";

const testSchema = z.object({
  status: z.string(),
});

describe("ResilientAiProvider (src/lib/ai/resilient-provider.ts)", () => {
  it("uses primary provider when primary succeeds", async () => {
    const primary = new MockAiProvider({
      modelName: "primary-groq",
      responses: [{ status: "ok_from_primary" }],
    });
    const fallback = new MockAiProvider({
      modelName: "fallback-gemini",
      responses: [{ status: "ok_from_fallback" }],
    });

    const resilient = new ResilientAiProvider({ primary, fallback });
    const result = await resilient.generateStructured("test prompt", testSchema);

    expect(result.data).toEqual({ status: "ok_from_primary" });
    expect(result.model).toBe("primary-groq");
    expect(primary.recordedCalls).toHaveLength(1);
    expect(fallback.recordedCalls).toHaveLength(0);
  });

  it("transparently fails over to fallback provider when primary fails", async () => {
    const primary = new MockAiProvider({
      modelName: "primary-groq",
      errorQueue: [new AiRateLimitError("Groq 429 rate limit exceeded")],
    });
    const fallback = new MockAiProvider({
      modelName: "fallback-gemini",
      responses: [{ status: "ok_from_fallback" }],
    });

    const onFallbackSpy = vi.fn();
    const resilient = new ResilientAiProvider({
      primary,
      fallback,
      onFallback: onFallbackSpy,
    });

    const result = await resilient.generateStructured("test prompt", testSchema);

    expect(result.data).toEqual({ status: "ok_from_fallback" });
    expect(result.model).toBe("fallback-gemini");
    expect(primary.recordedCalls).toHaveLength(1);
    expect(fallback.recordedCalls).toHaveLength(1);
    expect(onFallbackSpy).toHaveBeenCalledTimes(1);
  });

  it("throws fallback error if both primary and fallback fail", async () => {
    const primary = new MockAiProvider({
      modelName: "primary-groq",
      errorQueue: [new AiUnavailableError("Groq offline")],
    });
    const fallback = new MockAiProvider({
      modelName: "fallback-gemini",
      errorQueue: [new AiUnavailableError("Gemini timed out")],
    });

    const resilient = new ResilientAiProvider({ primary, fallback });

    await expect(resilient.generateStructured("test prompt", testSchema)).rejects.toThrow(
      "Gemini timed out"
    );
  });
});
