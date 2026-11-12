import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { GroqProvider } from "./groq";
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

describe("GroqProvider (src/lib/ai/groq.ts)", () => {
  const baseConfig = {
    apiKey: "gsk_test_1234567890abcdef",
    model: "llama-3.3-70b-versatile",
    timeoutMs: 5000,
    maxRetries: 1,
    baseUrl: "https://api.groq.com/openai/v1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates and validates structured output successfully", async () => {
    const mockPayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({ title: "Groq Fast Project", milestonesCount: 4 }),
          },
        },
      ],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 80,
        total_tokens: 120,
      },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPayload), { status: 200 })
    );

    const provider = new GroqProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.generateStructured("Brief input", testSchema, {
      systemInstruction: "You are a brief architect.",
    });

    expect(result.data).toEqual({ title: "Groq Fast Project", milestonesCount: 4 });
    expect(result.model).toBe("llama-3.3-70b-versatile");
    expect(result.usage).toEqual({
      promptTokens: 40,
      completionTokens: 80,
      totalTokens: 120,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("strips markdown code fences from Groq responses", async () => {
    const fenced = "```json\n" + JSON.stringify({ title: "Fenced Project", milestonesCount: 2 }) + "\n```";
    const mockPayload = {
      choices: [{ message: { content: fenced } }],
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPayload), { status: 200 })
    );

    const provider = new GroqProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await provider.generateStructured("Prompt", testSchema);
    expect(result.data).toEqual({ title: "Fenced Project", milestonesCount: 2 });
  });

  it("throws AiConfigurationError on HTTP 401 without leaking API keys", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API Key gsk_secret_123" } }), {
        status: 401,
      })
    );

    const provider = new GroqProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiConfigurationError
    );
  });

  it("throws AiRateLimitError on HTTP 429 when maxRetries exhausted", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
        status: 429,
      })
    );

    const provider = new GroqProvider({
      config: { ...baseConfig, maxRetries: 0 },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiRateLimitError
    );
  });

  it("throws AiOutputValidationError when response is malformed JSON", async () => {
    const mockPayload = {
      choices: [{ message: { content: "This is not json {{" } }],
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockPayload), { status: 200 })
    );

    const provider = new GroqProvider({
      config: baseConfig,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiOutputValidationError
    );
  });

  it("handles request timeouts properly", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Promise((resolve) => setTimeout(resolve, 5000));
    });

    const provider = new GroqProvider({
      config: { ...baseConfig, timeoutMs: 20 },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.generateStructured("Prompt", testSchema)).rejects.toThrow(
      AiUnavailableError
    );
  });
});
