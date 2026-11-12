import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GeminiProvider } from "./client";
import {
  AiConfigurationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "./errors";

const testSchema = z.object({
  title: z.string().min(2),
  milestonesCount: z.number().int().positive(),
});

describe("GeminiProvider (src/lib/ai/client.ts)", () => {
  const baseConfig = {
    apiKey: "AIzaSyTestKey123",
    model: "gemini-3.8-flash",
    timeoutMs: 5000,
    maxRetries: 2,
  };

  it("constructs correct REST request with headers, systemInstruction, and generationConfig", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ title: "Valid Project", milestonesCount: 4 }) }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 55,
            candidatesTokenCount: 120,
            totalTokenCount: 175,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const provider = new GeminiProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.generateStructured("Draft project agreement", testSchema, {
      systemInstruction: "You are a professional project assistant.",
      temperature: 0.1,
      responseSchema: { type: "OBJECT" },
    });

    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    );
    expect(capturedOptions?.method).toBe("POST");
    expect((capturedOptions?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "AIzaSyTestKey123"
    );

    const parsedBody = JSON.parse(capturedOptions?.body as string);
    expect(parsedBody.contents[0].parts[0].text).toBe("Draft project agreement");
    expect(parsedBody.systemInstruction.parts[0].text).toBe(
      "You are a professional project assistant."
    );
    expect(parsedBody.generationConfig.responseMimeType).toBe("application/json");
    expect(parsedBody.generationConfig.temperature).toBe(0.1);
    expect(parsedBody.generationConfig.responseSchema).toEqual({ type: "OBJECT" });

    expect(result.data).toEqual({ title: "Valid Project", milestonesCount: 4 });
    expect(result.model).toBe("gemini-3.8-flash");
    expect(result.usage).toEqual({
      promptTokens: 55,
      completionTokens: 120,
      totalTokens: 175,
    });
  });

  it("throws AiOutputValidationError when response text is empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "" }] } }],
        }),
        { status: 200 }
      )
    );

    const provider = new GeminiProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiOutputValidationError
    );
  });

  it("throws AiOutputValidationError when response is malformed JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Invalid JSON text {{" }] } }],
        }),
        { status: 200 }
      )
    );

    const provider = new GeminiProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiOutputValidationError
    );
  });

  it("throws AiOutputValidationError when JSON fails Zod schema validation", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                // title is too short (< 2) and milestonesCount is negative
                parts: [{ text: JSON.stringify({ title: "a", milestonesCount: -1 }) }],
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    const provider = new GeminiProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    try {
      await provider.generateStructured("Prompt", testSchema);
      expect.unreachable("Should have thrown AiOutputValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(AiOutputValidationError);
      const valErr = err as AiOutputValidationError;
      expect(valErr.issues.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("retries on HTTP 429 rate limit up to maxRetries and respects backoff", async () => {
    let callCount = 0;
    const sleptTimes: number[] = [];

    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ title: "Success", milestonesCount: 2 }) }] } },
          ],
        }),
        { status: 200 }
      );
    });

    const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
      sleptTimes.push(ms);
    });

    const provider = new GeminiProvider({
      config: { ...baseConfig, maxRetries: 2 },
      fetchFn: mockFetch as unknown as typeof fetch,
      sleepFn: mockSleep,
    });

    const result = await provider.generateStructured("Prompt", testSchema);
    expect(callCount).toBe(3); // Initial + 2 retries
    expect(sleptTimes).toHaveLength(2);
    expect(result.data.title).toBe("Success");
  });

  it("throws AiRateLimitError when HTTP 429 exceeds maxRetries", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "5" },
      })
    );

    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const provider = new GeminiProvider({
      config: { ...baseConfig, maxRetries: 1 },
      fetchFn: mockFetch as unknown as typeof fetch,
      sleepFn: mockSleep,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiRateLimitError
    );
  });

  it("retries on retryable HTTP 503 server errors", async () => {
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ title: "Recovered", milestonesCount: 1 }) }] } },
          ],
        }),
        { status: 200 }
      );
    });

    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const provider = new GeminiProvider({
      config: { ...baseConfig, maxRetries: 2 },
      fetchFn: mockFetch as unknown as typeof fetch,
      sleepFn: mockSleep,
    });

    const result = await provider.generateStructured("Prompt", testSchema);
    expect(callCount).toBe(2);
    expect(result.data.title).toBe("Recovered");
  });

  it("does not retry on 401/403 authentication errors and throws AiConfigurationError", async () => {
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response("Invalid API Key", { status: 401 });
    });

    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const provider = new GeminiProvider({
      config: { ...baseConfig, maxRetries: 2 },
      fetchFn: mockFetch as unknown as typeof fetch,
      sleepFn: mockSleep,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiConfigurationError
    );
    expect(callCount).toBe(1); // No retries attempted
  });

  it("does not retry on 400 Bad Request and throws AiConfigurationError", async () => {
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response("Bad Request: unsupported parameter", { status: 400 });
    });

    const provider = new GeminiProvider({
      config: { ...baseConfig, maxRetries: 2 },
      fetchFn: mockFetch as unknown as typeof fetch,
      sleepFn: vi.fn(),
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiConfigurationError
    );
    expect(callCount).toBe(1);
  });

  it("does not retry on 404 Model Not Found and throws AiConfigurationError", async () => {
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response("models/unknown-model not found", { status: 404 });
    });

    const provider = new GeminiProvider({
      config: { ...baseConfig, maxRetries: 2 },
      fetchFn: mockFetch as unknown as typeof fetch,
      sleepFn: vi.fn(),
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiConfigurationError
    );
    expect(callCount).toBe(1);
  });

  it("falls back to DEFAULT_GEMINI_MODEL (gemini-3.8-flash) when model is omitted", async () => {
    let capturedUrl = "";

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ title: "Fallback Model", milestonesCount: 1 }) }] } },
          ],
        }),
        { status: 200 }
      );
    });

    const provider = new GeminiProvider({
      config: { apiKey: "AIzaSyTestKey123" },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.generateStructured("Prompt", testSchema);
    expect(capturedUrl).toContain("gemini-3.8-flash");
    expect(result.model).toBe("gemini-3.8-flash");
  });

  it("handles caller abort signals", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new GeminiProvider({
      config: baseConfig,
      fetchFn: vi.fn(),
    });

    await expect(
      provider.generateStructured("Prompt", testSchema, { signal: controller.signal })
    ).rejects.toThrow(AiUnavailableError);
  });

  it("handles request timeouts properly", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      // Simulate never-resolving fetch
      return new Promise((resolve) => setTimeout(resolve, 5000));
    });

    const provider = new GeminiProvider({
      config: { ...baseConfig, timeoutMs: 20 },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiUnavailableError
    );
  });

  it("strips markdown json code fences before Zod parsing", async () => {
    const fencedText = [
      "```json",
      JSON.stringify({ title: "Fenced Project", milestonesCount: 3 }),
      "```",
    ].join("\n");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: fencedText }] } }],
        }),
        { status: 200 }
      )
    );

    const provider = new GeminiProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.generateStructured("Prompt", testSchema);
    expect(result.data).toEqual({ title: "Fenced Project", milestonesCount: 3 });
  });

  it("respects an overall timeout deadline across retry attempts", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Service busy", { status: 503 })
    );

    const provider = new GeminiProvider({
      config: { ...baseConfig, timeoutMs: 25, maxRetries: 4 },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const start = Date.now();
    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiUnavailableError
    );
    const elapsed = Date.now() - start;

    // Without overall deadline gating, 4 exponential backoff retries would exceed 2s+.
    expect(elapsed).toBeLessThan(1000);
  });
});
