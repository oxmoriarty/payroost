import "server-only";

import { z } from "zod";
import type { PayPalConfig } from "./types";

const paypalEnvSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox", {
    message: 'PAYPAL_ENV must be "sandbox". Live or production environments are strictly forbidden in Phase 3B.',
  }),

  PAYPAL_BASE_URL: z
    .string()
    .url("PAYPAL_BASE_URL must be a valid URL")
    .refine(
      (url) => url.replace(/\/$/, "") === "https://api-m.sandbox.paypal.com",
      { message: 'PAYPAL_BASE_URL must be "https://api-m.sandbox.paypal.com". Production endpoints are rejected.' }
    )
    .default("https://api-m.sandbox.paypal.com"),
  PAYPAL_CLIENT_ID: z.string().trim().min(1, "PAYPAL_CLIENT_ID is required and cannot be empty"),
  PAYPAL_CLIENT_SECRET: z.string().trim().min(1, "PAYPAL_CLIENT_SECRET is required and cannot be empty"),
  PAYPAL_EXPECTED_MERCHANT_ID: z
    .string()
    .trim()
    .min(3, "PAYPAL_EXPECTED_MERCHANT_ID must be at least 3 characters")
    .max(64, "PAYPAL_EXPECTED_MERCHANT_ID cannot exceed 64 characters"),
  PAYPAL_WEBHOOK_ID: z.string().trim().optional(),
});

/**
 * Validates and extracts server-side PayPal configuration.
 *
 * Security Invariants:
 * - Server-only module guard prevents accidental bundling in client components.
 * - Restricts environment strictly to "sandbox"; fails immediately if production is specified.
 * - Enforces valid HTTPS Sandbox base URL.
 * - Requires PAYPAL_EXPECTED_MERCHANT_ID (no email fallback).
 * - Masks and excludes secrets from validation error messages.
 */
export function getPayPalServerEnv(customSource?: Record<string, string | undefined>): PayPalConfig {
  const source = customSource ?? {
    PAYPAL_ENV: process.env.PAYPAL_ENV,
    PAYPAL_BASE_URL: process.env.PAYPAL_BASE_URL,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_EXPECTED_MERCHANT_ID: process.env.PAYPAL_EXPECTED_MERCHANT_ID,
    PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID,
  };

  const result = paypalEnvSchema.safeParse(source);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid PayPal configuration: ${errorDetails}`);
  }

  const data = result.data;

  return {
    environment: data.PAYPAL_ENV,
    baseUrl: data.PAYPAL_BASE_URL.replace(/\/$/, ""),
    clientId: data.PAYPAL_CLIENT_ID,
    clientSecret: data.PAYPAL_CLIENT_SECRET,
    expectedMerchantId: data.PAYPAL_EXPECTED_MERCHANT_ID,
    webhookId: data.PAYPAL_WEBHOOK_ID,
  };
}
