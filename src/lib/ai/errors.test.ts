import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AiConfigurationError,
  AiFinancialReconciliationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
  redactSensitiveData,
} from "./errors";

describe("AI Error Hierarchy & Normalization (src/lib/ai/errors.ts)", () => {
  describe("redactSensitiveData", () => {
    it("redacts Google AIza API keys", () => {
      const sensitive = "Failed with key AIzaSyA1234567890123456789012345678901 in url";
      expect(redactSensitiveData(sensitive)).toBe(
        "Failed with key [REDACTED_API_KEY] in url"
      );
    });

    it("redacts Bearer tokens", () => {
      const sensitive = "Authorization: Bearer ya29.a0AfH6SMAxyz12345";
      expect(redactSensitiveData(sensitive)).toBe("Authorization: Bearer [REDACTED_TOKEN]");
    });

    it("redacts key=value and secret=value parameters", () => {
      const sensitive = "https://api.example.com?apiKey=supersecretkey123&client_secret=anothersecret";
      const sanitized = redactSensitiveData(sensitive);
      expect(sanitized).not.toContain("supersecretkey123");
      expect(sanitized).not.toContain("anothersecret");
    });
  });

  describe("AiConfigurationError", () => {
    it("captures status code for provider configuration/request rejection", () => {
      const err = new AiConfigurationError("Model not found", { status: 404 });
      expect(err.status).toBe(404);
      expect(err.name).toBe("AiConfigurationError");
    });
  });

  describe("AiUnavailableError", () => {
    it("captures HTTP status and timeout flags", () => {
      const timeoutErr = new AiUnavailableError("Request timed out", { isTimeout: true });
      expect(timeoutErr.isTimeout).toBe(true);
      expect(timeoutErr.name).toBe("AiUnavailableError");

      const serverErr = new AiUnavailableError("Service 503", { status: 503 });
      expect(serverErr.status).toBe(503);
      expect(serverErr.isTimeout).toBe(false);
    });
  });

  describe("AiRateLimitError", () => {
    it("captures retry-after seconds", () => {
      const err = new AiRateLimitError("Rate limit exceeded", { retryAfterSeconds: 30 });
      expect(err.retryAfterSeconds).toBe(30);
      expect(err.name).toBe("AiRateLimitError");
    });
  });

  describe("AiOutputValidationError", () => {
    it("normalizes Zod errors into structured issues", () => {
      const testSchema = z.object({
        title: z.string().min(3),
        amount: z.number().positive(),
      });

      const parsed = testSchema.safeParse({ title: "ab", amount: -10 });
      expect(parsed.success).toBe(false);

      if (!parsed.success) {
        const err = new AiOutputValidationError("Validation failed", {
          zodError: parsed.error,
          rawOutput: '{"title":"ab","amount":-10}',
        });

        expect(err.issues).toHaveLength(2);
        expect(err.issues[0].path).toBe("title");
        expect(err.issues[1].path).toBe("amount");
        expect(err.rawOutputPreview).toBe('{"title":"ab","amount":-10}');
      }
    });

    it("bounds raw output preview to 200 characters", () => {
      const longOutput = "x".repeat(500);
      const err = new AiOutputValidationError("Failed", { rawOutput: longOutput });
      expect(err.rawOutputPreview?.length).toBe(200);
    });
  });

  describe("AiFinancialReconciliationError", () => {
    it("captures expected and actual minor unit totals with currency", () => {
      const err = new AiFinancialReconciliationError("Milestone sum mismatch", {
        expectedTotalMinor: 100000,
        actualTotalMinor: 99999,
        currency: "USD",
      });

      expect(err.expectedTotalMinor).toBe(100000);
      expect(err.actualTotalMinor).toBe(99999);
      expect(err.currency).toBe("USD");
      expect(err.name).toBe("AiFinancialReconciliationError");
    });
  });
});
