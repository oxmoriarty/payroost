import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockAiProvider } from "./provider";
import { AiOutputValidationError, AiUnavailableError } from "./errors";

const sampleSchema = z.object({
  summary: z.string().min(5),
  count: z.number().int().positive(),
});

describe("MockAiProvider (src/lib/ai/provider.ts)", () => {
  it("records calls and returns validated structured objects", () => {
    const provider = new MockAiProvider({
      responses: [{ summary: "Valid Project Summary", count: 3 }],
      modelName: "test-mock-model",
      tokenUsage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
    });

    return provider
      .generateStructured("Test prompt", sampleSchema, { temperature: 0.5 })
      .then((result) => {
        expect(result.data).toEqual({ summary: "Valid Project Summary", count: 3 });
        expect(result.model).toBe("test-mock-model");
        expect(result.usage).toEqual({
          promptTokens: 50,
          completionTokens: 100,
          totalTokens: 150,
        });
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        expect(provider.recordedCalls).toHaveLength(1);
        expect(provider.recordedCalls[0].prompt).toBe("Test prompt");
        expect(provider.recordedCalls[0].options?.temperature).toBe(0.5);
      });
  });

  it("handles string JSON responses and parses them", async () => {
    const provider = new MockAiProvider();
    provider.enqueueResponse(JSON.stringify({ summary: "Parsed from JSON string", count: 10 }));

    const result = await provider.generateStructured("Prompt", sampleSchema);
    expect(result.data.summary).toBe("Parsed from JSON string");
    expect(result.data.count).toBe(10);
  });

  it("throws AiOutputValidationError when response is malformed JSON string", async () => {
    const provider = new MockAiProvider({
      responses: ["{ not_valid_json: "],
    });

    await expect(provider.generateStructured("Prompt", sampleSchema)).rejects.toThrow(
      AiOutputValidationError
    );
  });

  it("throws AiOutputValidationError when payload fails Zod schema validation", async () => {
    const provider = new MockAiProvider({
      responses: [{ summary: "Too short", count: -5 }], // count must be positive
    });

    await expect(provider.generateStructured("Prompt", sampleSchema)).rejects.toThrow(
      AiOutputValidationError
    );
  });

  it("throws AiUnavailableError when response queue is exhausted", async () => {
    const provider = new MockAiProvider({ responses: [] });

    await expect(provider.generateStructured("Prompt", sampleSchema)).rejects.toThrow(
      AiUnavailableError
    );
  });

  it("throws queued errors in FIFO order", async () => {
    const customError = new Error("Simulated upstream outage");
    const provider = new MockAiProvider({
      errorQueue: [customError],
      responses: [{ summary: "Fallback response", count: 1 }],
    });

    await expect(provider.generateStructured("Prompt", sampleSchema)).rejects.toThrow(
      "Simulated upstream outage"
    );

    // Next call succeeds with queued response
    const nextResult = await provider.generateStructured("Prompt 2", sampleSchema);
    expect(nextResult.data.summary).toBe("Fallback response");
  });

  it("respects abort signals during simulated latency", async () => {
    const provider = new MockAiProvider({
      latencyMs: 100,
      responses: [{ summary: "Delayed response", count: 2 }],
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(
      provider.generateStructured("Prompt", sampleSchema, { signal: controller.signal })
    ).rejects.toThrow(AiUnavailableError);
  });
});
