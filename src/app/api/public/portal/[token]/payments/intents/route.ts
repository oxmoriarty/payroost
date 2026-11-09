import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import { hashPortalToken } from "@/lib/security/tokens";
import { authenticatePortalSession } from "@/lib/security/portal-session";
import { checkRateLimit } from "@/lib/security/rate-limit";
import {
  getClientIp,
  getPortalTokenRateLimitKey,
  getPortalIpRateLimitKey,
} from "@/lib/security/client-ip";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import { apiError } from "@/lib/http";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * Active payment-intent states enforced by payment_intents_one_active_per_milestone_idx.
 */
export const ACTIVE_PAYMENT_INTENT_STATUSES = [
  "ORDER_CREATING",
  "ORDER_CREATED",
  "BUYER_APPROVED",
  "CAPTURING",
  "RECONCILING",
] as const;

export type ActivePaymentIntentStatus = (typeof ACTIVE_PAYMENT_INTENT_STATUSES)[number];

/**
 * Converts integer minor units (cents) to a canonical 2-decimal USD string using pure BigInt arithmetic.
 * Strictly rejects zero, negative, floating-point, NaN, and non-integer representations without floating-point math.
 */
export function formatMinorToCanonicalUsd(rawAmountMinor: unknown): string {
  let bi: bigint;
  try {
    if (typeof rawAmountMinor === "bigint") {
      bi = rawAmountMinor;
    } else if (typeof rawAmountMinor === "number") {
      if (!Number.isSafeInteger(rawAmountMinor)) {
        throw new Error("Invalid integer amount");
      }
      bi = BigInt(rawAmountMinor);
    } else if (typeof rawAmountMinor === "string") {
      const trimmed = rawAmountMinor.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        throw new Error("Invalid integer string");
      }
      bi = BigInt(trimmed);
    } else {
      throw new Error("Unsupported amount type");
    }
  } catch {
    throw new Error("INVALID_MILESTONE_AMOUNT");
  }

  if (bi <= 0n) {
    throw new Error("INVALID_MILESTONE_AMOUNT");
  }

  const dollars = bi / 100n;
  const cents = bi % 100n;
  const canonical = `${dollars.toString()}.${cents.toString().padStart(2, "0")}`;

  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(canonical)) {
    throw new Error("INVALID_MILESTONE_AMOUNT");
  }

  return canonical;
}

/**
 * Strict request payload schema:
 * Only milestoneId (UUID format) is accepted.
 * Extraneous properties (amount, currency, merchantId, projectId, status) are strictly forbidden.
 */
const createPaymentIntentSchema = z
  .object({
    milestoneId: z.string().uuid("Invalid milestone ID format"),
  })
  .strict();

/**
 * POST /api/public/portal/[token]/payments/intents
 *
 * Authenticated client endpoint to initialize a payment intent for an approved milestone,
 * with safe retry idempotency and concurrency resilience.
 *
 * Security Invariants & Protections:
 * 1. Enforces mandatory token-based rate limiting (10 requests / 15 minutes) and optional
 *    independent IP rate limiting when explicit proxy trust is enabled.
 * 2. Authenticates client session via HttpOnly cookie and validates CSRF token in constant time.
 * 3. Enforces cryptographic and relational binding to the project associated with the URL token.
 * 4. Never trusts client input for amounts, currency, status, project, or merchant identity.
 * 5. Resolves milestone amount and currency strictly from authoritative server-side database records.
 * 6. Resolves payee merchant identity strictly from server-side PayPal configuration.
 * 7. Enforces single-purchase-unit contract and BigInt integer-cents arithmetic (no floating-point math).
 * 8. Safe retry resolution: preflight checks for existing active intent for the milestone, returning
 *    200 OK with the existing intent ID instead of creating duplicates or failing with unrecoverable conflict.
 * 9. Concurrency resolution: if concurrent requests race, the losing request handles the 23505 unique
 *    index conflict by retrieving and returning the winning active intent (200 OK).
 * 10. Terminal and ambiguous states: COMPLETED returns 409 MILESTONE_ALREADY_COMPLETED;
 *     RECONCILIATION_REQUIRED returns 409 RECONCILIATION_REQUIRED.
 * 11. Does not initiate PayPal order creation, buyer approval, or capture (reserved for Phase 3B.4).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;

  // 1. Validate portal invitation token format
  if (!token || !TOKEN_REGEX.test(token)) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 2. Hash portal invitation token
  const tokenHash = hashPortalToken(token);

  // 3. Mandatory primary rate limit: Token-based (independent of client IP headers)
  const tokenLimitKey = getPortalTokenRateLimitKey("portal-payment-intent", tokenHash);
  const tokenLimit = await checkRateLimit(tokenLimitKey, 10, 900_000, {
    failClosedInProduction: true,
  });

  if (!tokenLimit.allowed) {
    if (tokenLimit.status === "service_unavailable") {
      return apiError("RATE_LIMITER_UNAVAILABLE", 503, {
        "Cache-Control": "no-store",
      });
    }
    return apiError("RATE_LIMITED", 429, {
      "Cache-Control": "no-store",
    });
  }

  // 4. Optional secondary rate limit: IP-based (only when proxy trust is explicitly enabled)
  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimitKey = getPortalIpRateLimitKey("portal-payment-intent", clientIp);
    const ipLimit = await checkRateLimit(ipLimitKey, 10, 900_000, {
      failClosedInProduction: true,
    });

    if (!ipLimit.allowed) {
      if (ipLimit.status === "service_unavailable") {
        return apiError("RATE_LIMITER_UNAVAILABLE", 503, {
          "Cache-Control": "no-store",
        });
      }
      return apiError("RATE_LIMITED", 429, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 5. Validate CSRF header presence
  const csrfToken = request.headers.get("x-csrf-token");
  if (!csrfToken) {
    return apiError("INVALID_CSRF_TOKEN", 403, {
      "Cache-Control": "no-store",
    });
  }

  // 6. Strict request body validation
  let payload: z.infer<typeof createPaymentIntentSchema>;
  try {
    const bodyText = await request.text();
    if (!bodyText || bodyText.trim().length === 0) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    const rawJson = JSON.parse(bodyText);
    const parseResult = createPaymentIntentSchema.safeParse(rawJson);
    if (!parseResult.success) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    payload = parseResult.data;
  } catch {
    return apiError("VALIDATION_ERROR", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 7. Initialize service-role database client
  let serviceClient: ReturnType<typeof createServiceClient>;
  try {
    serviceClient = createServiceClient();
  } catch {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 8. Resolve portal token and bound project context
  const { data: portalToken, error: tokenError } = await serviceClient
    .from("client_portal_tokens")
    .select("project_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (!portalToken || portalToken.revoked_at !== null) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 9. Authenticate portal session with timing-safe CSRF and project binding
  const authResult = await authenticatePortalSession({
    csrfToken,
    requireCsrf: true,
    expectedProjectId: portalToken.project_id,
    supabaseClient: serviceClient,
  });

  if (!authResult.success) {
    return apiError(authResult.error, authResult.status, {
      "Cache-Control": "no-store",
    });
  }

  // 10. Retrieve authoritative milestone data server-side
  const { data: milestone, error: milestoneError } = await serviceClient
    .from("milestones")
    .select("id, project_id, agreement_version_id, title, amount_minor, currency, status")
    .eq("id", payload.milestoneId)
    .maybeSingle();

  if (milestoneError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (!milestone || milestone.project_id !== authResult.projectId) {
    return apiError("MILESTONE_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // Invariant: Milestone must be payable (APPROVED, IN_PROGRESS, or SUBMITTED)
  if (!["APPROVED", "IN_PROGRESS", "SUBMITTED"].includes(milestone.status)) {
    return apiError("MILESTONE_NOT_PAYABLE", 400, {
      "Cache-Control": "no-store",
    });
  }

  // Invariant: USD only in Phase 3
  if (milestone.currency !== "USD") {
    return apiError("UNSUPPORTED_CURRENCY", 400, {
      "Cache-Control": "no-store",
    });
  }

  // Invariant: Positive milestone amount with BigInt conversion
  let canonicalAmount: string;
  try {
    canonicalAmount = formatMinorToCanonicalUsd(milestone.amount_minor);
  } catch {
    return apiError("INVALID_MILESTONE_AMOUNT", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 11. Idempotency preflight: Check for existing active, completed, or reconciliation-required payment intent
  const { data: existingIntent, error: lookupError } = await serviceClient
    .from("payment_intents")
    .select("id, project_id, milestone_id, status")
    .eq("milestone_id", milestone.id)
    .in("status", [
      ...ACTIVE_PAYMENT_INTENT_STATUSES,
      "RECONCILIATION_REQUIRED",
      "COMPLETED",
    ])
    .maybeSingle();

  if (lookupError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (existingIntent) {
    // Assert project binding
    if (existingIntent.project_id !== authResult.projectId) {
      return apiError("FORBIDDEN", 403, {
        "Cache-Control": "no-store",
      });
    }

    // Terminal completed state
    if (existingIntent.status === "COMPLETED") {
      return apiError("MILESTONE_ALREADY_COMPLETED", 409, {
        "Cache-Control": "no-store",
      });
    }

    // Ambiguous reconciliation state
    if (existingIntent.status === "RECONCILIATION_REQUIRED") {
      return apiError("RECONCILIATION_REQUIRED", 409, {
        "Cache-Control": "no-store",
      });
    }

    // Active eligible state: Return existing intent with 200 OK
    return NextResponse.json(
      {
        success: true,
        paymentIntentId: existingIntent.id,
        status: existingIntent.status,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  // 12. Retrieve trusted merchant configuration
  let expectedMerchantId: string;
  try {
    const paypalEnv = getPayPalServerEnv();
    expectedMerchantId = paypalEnv.expectedMerchantId;
  } catch {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  if (
    !expectedMerchantId ||
    expectedMerchantId.length < 3 ||
    expectedMerchantId.length > 64
  ) {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 13. Build canonical purchase unit payload and generate idempotency keys
  const intentId = crypto.randomUUID();
  const orderIdempotencyKey = crypto.randomUUID();
  const captureIdempotencyKey = crypto.randomUUID();

  const canonicalPayload = {
    purchase_units: [
      {
        reference_id: milestone.id,
        custom_id: intentId,
        amount: {
          currency_code: "USD",
          value: canonicalAmount,
        },
        payee: {
          merchant_id: expectedMerchantId,
        },
      },
    ],
  };

  // 14. Create payment intent via privileged service-role RPC
  const { data: createdIntentId, error: rpcError } = await serviceClient.rpc(
    "create_client_payment_intent",
    {
      p_session_token_hash: authResult.sessionTokenHash,
      p_milestone_id: milestone.id,
      p_expected_merchant_id: expectedMerchantId,
      p_order_idempotency_key: orderIdempotencyKey,
      p_capture_idempotency_key: captureIdempotencyKey,
      p_canonical_payload: canonicalPayload,
    }
  );

  // 15. Handle RPC errors, concurrency conflicts, and database invariants
  if (rpcError) {
    const errorMsg = rpcError.message || "";
    const errorCode = (rpcError as { code?: string }).code;

    // Concurrency conflict / duplicate intent handling
    const isCompletedConflict =
      errorMsg.includes("payment_intents_one_completed_per_milestone_idx") ||
      errorMsg.includes("already completed");

    const isActiveConflict =
      errorCode === "23505" ||
      errorMsg.includes("payment_intents_one_active_per_milestone_idx") ||
      errorMsg.includes("active payment intent");

    if (isCompletedConflict) {
      return apiError("MILESTONE_ALREADY_COMPLETED", 409, {
        "Cache-Control": "no-store",
      });
    }

    if (isActiveConflict) {
      // Re-query for the winning concurrent intent
      const { data: winningIntent, error: winLookupError } = await serviceClient
        .from("payment_intents")
        .select("id, project_id, milestone_id, status")
        .eq("milestone_id", milestone.id)
        .in("status", [
          ...ACTIVE_PAYMENT_INTENT_STATUSES,
          "RECONCILIATION_REQUIRED",
          "COMPLETED",
        ])
        .maybeSingle();

      if (!winLookupError && winningIntent) {
        if (winningIntent.project_id !== authResult.projectId) {
          return apiError("FORBIDDEN", 403, {
            "Cache-Control": "no-store",
          });
        }

        if (winningIntent.status === "COMPLETED") {
          return apiError("MILESTONE_ALREADY_COMPLETED", 409, {
            "Cache-Control": "no-store",
          });
        }

        if (winningIntent.status === "RECONCILIATION_REQUIRED") {
          return apiError("RECONCILIATION_REQUIRED", 409, {
            "Cache-Control": "no-store",
          });
        }

        // Return the winning active intent with 200 OK
        return NextResponse.json(
          {
            success: true,
            paymentIntentId: winningIntent.id,
            status: winningIntent.status,
          },
          {
            status: 200,
            headers: {
              "Cache-Control": "no-store",
            },
          }
        );
      }

      return apiError("PAYMENT_INTENT_CONFLICT", 409, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("Milestone not found")) {
      return apiError("MILESTONE_NOT_FOUND", 404, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("Project not found")) {
      return apiError("PROJECT_NOT_FOUND", 404, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("is not payable")) {
      return apiError("MILESTONE_NOT_PAYABLE", 400, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("approved agreement version")) {
      return apiError("AGREEMENT_NOT_APPROVED", 400, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("does not belong to this project")) {
      return apiError("FORBIDDEN", 403, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("client email is not verified")) {
      return apiError("CLIENT_EMAIL_UNVERIFIED", 403, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("Client email has changed")) {
      return apiError("AUTHENTICATION_FAILED", 401, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("absolute timeout")) {
      return apiError("SESSION_EXPIRED", 401, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("idle timeout")) {
      return apiError("SESSION_IDLE_TIMEOUT", 401, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("session is invalid or revoked")) {
      return apiError("UNAUTHORIZED", 401, {
        "Cache-Control": "no-store",
      });
    }

    if (errorMsg.includes("Invalid expected merchant ID")) {
      return apiError("CONFIGURATION_ERROR", 500, {
        "Cache-Control": "no-store",
      });
    }

    return apiError("SERVER_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 16. Return newly created intent response (201 Created)
  return NextResponse.json(
    {
      success: true,
      paymentIntentId: createdIntentId || intentId,
      status: "ORDER_CREATING",
    },
    {
      status: 201,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
