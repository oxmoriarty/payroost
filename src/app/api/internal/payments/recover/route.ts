import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { createServiceClient } from "@/lib/supabase/service";
import { recoverPendingPayPalWebhookEvents } from "@/lib/paypal/webhook-processor";
import { reconcilePaymentIntentServerSide } from "@/lib/paypal/reconciliation-service";

const internalRecoverBodySchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    reconcileExpiredLeases: z.boolean().optional(),
  })
  .strict();

function verifyCronSecret(request: Request):
  | { ok: true }
  | { ok: false; code: "CRON_SECRET_NOT_CONFIGURED" | "UNAUTHORIZED"; status: 503 | 401 } {
  const configuredSecret = process.env.CRON_SECRET?.trim();
  if (!configuredSecret || configuredSecret.length < 16) {
    return { ok: false, code: "CRON_SECRET_NOT_CONFIGURED", status: 503 };
  }

  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, code: "UNAUTHORIZED", status: 401 };
  }

  const supplied = authHeader.slice("Bearer ".length).trim();
  if (!supplied) {
    return { ok: false, code: "UNAUTHORIZED", status: 401 };
  }

  const expectedDigest = createHash("sha256").update(configuredSecret).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
    return { ok: false, code: "UNAUTHORIZED", status: 401 };
  }

  return { ok: true };
}

/**
 * POST /api/internal/payments/recover
 *
 * Internal cron/scheduler-compatible endpoint to safely recover:
 * 1. Signature-verified PayPal webhook events in RETRY / expired PROCESSING state.
 * 2. Stale expired-lease payment intents in ORDER_CREATING / CAPTURING state.
 *
 * Strictly protected by fail-closed timing-safe CRON_SECRET bearer authentication.
 */
export async function POST(request: Request) {
  const auth = verifyCronSecret(request);
  if (!auth.ok) {
    return apiError(auth.code, auth.status);
  }

  let bodyInput: z.infer<typeof internalRecoverBodySchema> = {};
  const contentLength = request.headers.get("content-length");
  if (contentLength !== "0") {
    try {
      const rawText = await request.text();
      if (rawText.trim().length > 0) {
        const parsedJson = JSON.parse(rawText);
        const validated = internalRecoverBodySchema.safeParse(parsedJson);
        if (!validated.success) {
          return apiError("VALIDATION_ERROR", 400);
        }
        bodyInput = validated.data;
      }
    } catch {
      return apiError("INVALID_JSON", 400);
    }
  }

  const limit = bodyInput.limit ?? 20;
  const shouldReconcileLeases = bodyInput.reconcileExpiredLeases !== false;
  const serviceClient = createServiceClient();

  const webhookStats = await recoverPendingPayPalWebhookEvents({
    limit,
    injectedServiceClient: serviceClient,
  });

  const staleLeases = {
    checked: 0,
    recovered: 0,
    reconciliationRequired: 0,
    failed: 0,
  };

  if (shouldReconcileLeases) {
    const nowIso = new Date().toISOString();
    const { data: staleCreationIntents } = await serviceClient
      .from("payment_intents")
      .select("id")
      .eq("status", "ORDER_CREATING")
      .lt("order_creation_lease_expires_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(limit);

    const { data: staleCaptureIntents } = await serviceClient
      .from("payment_intents")
      .select("id")
      .eq("status", "CAPTURING")
      .lt("capture_lease_expires_at", nowIso)
      .order("updated_at", { ascending: true })
      .limit(limit);

    const candidateIds = Array.from(
      new Set([
        ...((staleCreationIntents || []) as Array<{ id: string }>).map((r) => r.id),
        ...((staleCaptureIntents || []) as Array<{ id: string }>).map((r) => r.id),
      ])
    ).slice(0, limit);

    for (const intentId of candidateIds) {
      staleLeases.checked += 1;
      try {
        const res = await reconcilePaymentIntentServerSide({
          intentId,
          actorLabel: "scheduled_recovery_sweep",
          injectedServiceClient: serviceClient,
        });
        if (res.recovered || res.resultingStatus === "COMPLETED") {
          staleLeases.recovered += 1;
        } else if (res.resultingStatus === "RECONCILIATION_REQUIRED") {
          staleLeases.reconciliationRequired += 1;
        } else {
          staleLeases.failed += 1;
        }
      } catch {
        staleLeases.failed += 1;
      }
    }
  }

  return NextResponse.json(
    {
      ok: true,
      webhooks: webhookStats,
      staleLeases,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
