import { describe, expect, it } from "vitest";
import { DEFAULT_GEMINI_MODEL, getAiEnv, isAiConfigured } from "./env";
import { AiConfigurationError } from "./errors";

describe("AI Environment Configuration (src/lib/ai/env.ts)", () => {
  it("detects when AI is not configured without throwing", () => {
    expect(isAiConfigured({})).toBe(false);
    expect(isAiConfigured({ GEMINI_API_KEY: "" })).toBe(false);
    expect(isAiConfigured({ GEMINI_API_KEY: "   " })).toBe(false);
  });

  it("detects when AI is configured with a valid key", () => {
    expect(isAiConfigured({ GEMINI_API_KEY: "AIzaSyTestKey123" })).toBe(true);
  });

  it("throws AiConfigurationError when calling getAiEnv without GEMINI_API_KEY", () => {
    expect(() => getAiEnv({})).toThrow(AiConfigurationError);
    expect(() => getAiEnv({})).toThrow(/GEMINI_API_KEY must be set/);
  });

  it("exports verified default Free-Tier model gemini-3.8-flash", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.8-flash");
  });

  it("provides verified defaults for model, timeout, and max retries", () => {
    const config = getAiEnv({
      GEMINI_API_KEY: "AIzaSyTestKey123",
    });

    expect(config.apiKey).toBe("AIzaSyTestKey123");
    expect(config.model).toBe("gemini-3.8-flash");
    expect(config.timeoutMs).toBe(25000);
    expect(config.maxRetries).toBe(2);
  });

  it("accepts valid custom overrides for model, timeout, and retries", () => {
    const config = getAiEnv({
      GEMINI_API_KEY: "AIzaSyTestKey123",
      GEMINI_MODEL: "gemini-2.0-flash",
      GEMINI_TIMEOUT_MS: "30000",
      GEMINI_MAX_RETRIES: "3",
    });

    expect(config.apiKey).toBe("AIzaSyTestKey123");
    expect(config.model).toBe("gemini-2.0-flash");
    expect(config.timeoutMs).toBe(30000);
    expect(config.maxRetries).toBe(3);
  });

  it("rejects timeout values below minimum (1000ms)", () => {
    expect(() =>
      getAiEnv({
        GEMINI_API_KEY: "AIzaSyTestKey123",
        GEMINI_TIMEOUT_MS: "500",
      })
    ).toThrow(AiConfigurationError);
  });

  it("rejects timeout values exceeding maximum (120000ms)", () => {
    expect(() =>
      getAiEnv({
        GEMINI_API_KEY: "AIzaSyTestKey123",
        GEMINI_TIMEOUT_MS: "150000",
      })
    ).toThrow(AiConfigurationError);
  });

  it("rejects negative max retries and retries exceeding maximum (5)", () => {
    expect(() =>
      getAiEnv({
        GEMINI_API_KEY: "AIzaSyTestKey123",
        GEMINI_MAX_RETRIES: "-1",
      })
    ).toThrow(AiConfigurationError);

    expect(() =>
      getAiEnv({
        GEMINI_API_KEY: "AIzaSyTestKey123",
        GEMINI_MAX_RETRIES: "10",
      })
    ).toThrow(AiConfigurationError);
  });

  it("never leaks the API key in thrown error messages", () => {
    const testSecretKey = "AIzaSyTestSecretKeyToVerifyRedaction99";
    try {
      getAiEnv({
        GEMINI_API_KEY: testSecretKey,
        GEMINI_TIMEOUT_MS: "invalid_timeout",
      });
      expect.unreachable("Should have thrown AiConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(AiConfigurationError);
      expect((error as Error).message).not.toContain(testSecretKey);
    }
  });
});
