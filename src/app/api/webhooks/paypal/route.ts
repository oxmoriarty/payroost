import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/client-ip";
import {
  MAX_WEBHOOK_BODY_BYTES,
} from "@/lib/paypal/webhooks";
import { handleIncomingPayPalWebhook } from "@/lib/paypal/webhook-processor";

export const dynamic = "force-dynamic";

const WEBHOOK_RATE_LIMIT = 120;
const WEBHOOK_RATE_WINDOW_MS = 60_000;

/**
 * Public PayPal Platform Webhook Ingestion Endpoint.
 *
 * Security invariants:
 * - Reads exact unmodified raw body text prior to JSON parsing or verification.
 * - Fails closed before storing or mutating state until PayPal verifies the cryptographic
 *   transmission headers + webhook_id + unmodified webhook_event payload.
 * - Never injects PayPal-Auth-Assertion or unrelated attribution headers on verification calls.
 * - Never exposes secrets, tokens, stack traces, or full PII payloads in HTTP responses.
 */
export async function POST(request: Request) {
  const clientIp = getClientIp(request);
  const rateLimitKey = clientIp
    ? `webhook:paypal:ip:${clientIp}`
    : "webhook:paypal:global";

  const rl = await checkRateLimit(rateLimitKey, WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_MS);
  if (rl.isUnavailable) {
    return NextResponse.json(
      { received: false, error: "SERVICE_UNAVAILABLE" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "15" },
      }
    );
  }

  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { received: false, error: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
      }
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const parsedLen = Number(contentLengthHeader);
    if (Number.isFinite(parsedLen) && parsedLen > MAX_WEBHOOK_BODY_BYTES) {
      return NextResponse.json(
        { received: false, error: "PAYLOAD_TOO_LARGE" },
        { status: 413, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { received: false, error: "INVALID_REQUEST_BODY" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const result = await handleIncomingPayPalWebhook({
    headers: request.headers,
    rawBody,
  });

  return NextResponse.json(result.body, {
    status: result.httpStatus,
    headers: {
      "Cache-Control": "no-store",
      ...(result.headers ?? {}),
    },
  });
}
