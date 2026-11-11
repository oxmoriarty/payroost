import { createHash } from "node:crypto";
import { PayPalError, type PayPalConfig } from "./types";
import type { PayPalClient } from "./client";
import type { PayPalCaptureEntryShape, PayPalOrderShape } from "@/features/payments/capture-helpers";

export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024; // 512 KB

export const SUPPORTED_PAYPAL_WEBHOOK_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
] as const;

export type SupportedPayPalWebhookEventType =
  (typeof SUPPORTED_PAYPAL_WEBHOOK_EVENTS)[number];

export interface PayPalWebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

export interface PayPalWebhookEnvelope {
  id: string;
  event_type: string;
  event_version?: string;
  resource_type?: string;
  resource_version?: string;
  create_time?: string;
  summary?: string;
  resource: Record<string, unknown>;
}

export type ExtractHeadersResult =
  | { ok: true; headers: PayPalWebhookHeaders }
  | { ok: false; error: "MISSING_WEBHOOK_HEADERS" | "INVALID_WEBHOOK_HEADERS"; message: string };

export type ParseEnvelopeResult =
  | {
      ok: true;
      envelope: PayPalWebhookEnvelope;
      payloadSha256: string;
      eventCreatedAt: string | null;
    }
  | {
      ok: false;
      error: "PAYLOAD_TOO_LARGE" | "MALFORMED_JSON" | "INVALID_WEBHOOK_EVENT";
      httpStatus: number;
      message: string;
    };

export type VerifySignatureResult =
  | { verified: true }
  | { verified: false; transient: boolean; error: string; message: string };

const PRINTABLE_ASCII_REGEX = /^[\x21-\x7E\t ]+$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizeHeaderValue(value: string | null, maxLen: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  if (!PRINTABLE_ASCII_REGEX.test(trimmed)) return null;
  return trimmed;
}

function isAllowedPayPalCertUrl(certUrl: string): boolean {
  try {
    const parsed = new URL(certUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "paypal.com" ||
      host.endsWith(".paypal.com") ||
      host.endsWith(".paypalobjects.com")
    );
  } catch {
    return false;
  }
}

export function isSupportedPayPalWebhookEventType(
  eventType: string
): eventType is SupportedPayPalWebhookEventType {
  return (SUPPORTED_PAYPAL_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}

/**
 * Extracts and structurally validates the five mandatory PayPal webhook verification headers.
 */
export function extractPayPalWebhookHeaders(headers: Headers): ExtractHeadersResult {
  const rawTransmissionId = headers.get("paypal-transmission-id");
  const rawTransmissionTime = headers.get("paypal-transmission-time");
  const rawTransmissionSig = headers.get("paypal-transmission-sig");
  const rawCertUrl = headers.get("paypal-cert-url");
  const rawAuthAlgo = headers.get("paypal-auth-algo");

  if (
    !rawTransmissionId ||
    !rawTransmissionTime ||
    !rawTransmissionSig ||
    !rawCertUrl ||
    !rawAuthAlgo
  ) {
    return {
      ok: false,
      error: "MISSING_WEBHOOK_HEADERS",
      message: "Missing mandatory PayPal transmission verification headers.",
    };
  }

  const transmissionId = sanitizeHeaderValue(rawTransmissionId, 128);
  const transmissionTime = sanitizeHeaderValue(rawTransmissionTime, 64);
  const transmissionSig = sanitizeHeaderValue(rawTransmissionSig, 4096);
  const certUrl = sanitizeHeaderValue(rawCertUrl, 1024);
  const authAlgo = sanitizeHeaderValue(rawAuthAlgo, 64);

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    return {
      ok: false,
      error: "INVALID_WEBHOOK_HEADERS",
      message: "Malformed PayPal transmission verification header format.",
    };
  }

  if (Number.isNaN(Date.parse(transmissionTime))) {
    return {
      ok: false,
      error: "INVALID_WEBHOOK_HEADERS",
      message: "Invalid paypal-transmission-time timestamp.",
    };
  }

  if (!isAllowedPayPalCertUrl(certUrl)) {
    return {
      ok: false,
      error: "INVALID_WEBHOOK_HEADERS",
      message: "Untrusted or invalid paypal-cert-url domain.",
    };
  }

  return {
    ok: true,
    headers: {
      transmissionId,
      transmissionTime,
      transmissionSig,
      certUrl,
      authAlgo,
    },
  };
}

/**
 * Validates raw request size, computes deterministic SHA-256 over the exact raw request body,
 * and parses the PayPal webhook JSON envelope cleanly before verification.
 */
export function parsePayPalWebhookEnvelope(rawBody: string): ParseEnvelopeResult {
  const byteLength = Buffer.byteLength(rawBody, "utf8");
  if (byteLength === 0) {
    return {
      ok: false,
      error: "MALFORMED_JSON",
      httpStatus: 400,
      message: "Webhook request body cannot be empty.",
    };
  }

  if (byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return {
      ok: false,
      error: "PAYLOAD_TOO_LARGE",
      httpStatus: 413,
      message: "Webhook request payload exceeds maximum allowed size.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      error: "MALFORMED_JSON",
      httpStatus: 400,
      message: "Webhook payload is not valid JSON.",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "INVALID_WEBHOOK_EVENT",
      httpStatus: 400,
      message: "Webhook payload must be a JSON object.",
    };
  }

  const record = parsed as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const eventType = typeof record.event_type === "string" ? record.event_type.trim() : "";
  const resource = record.resource;

  if (!id || id.length > 128 || !eventType || eventType.length > 128) {
    return {
      ok: false,
      error: "INVALID_WEBHOOK_EVENT",
      httpStatus: 400,
      message: "Webhook event is missing valid id or event_type.",
    };
  }

  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return {
      ok: false,
      error: "INVALID_WEBHOOK_EVENT",
      httpStatus: 400,
      message: "Webhook event is missing a valid resource object.",
    };
  }

  const rawCreateTime =
    typeof record.create_time === "string" ? record.create_time.trim() : "";
  const eventCreatedAt =
    rawCreateTime && !Number.isNaN(Date.parse(rawCreateTime))
      ? new Date(rawCreateTime).toISOString()
      : null;

  const payloadSha256 = createHash("sha256").update(rawBody, "utf8").digest("hex");

  return {
    ok: true,
    envelope: record as unknown as PayPalWebhookEnvelope,
    payloadSha256,
    eventCreatedAt,
  };
}

/**
 * Verifies a PayPal webhook delivery signature using POST /v1/notifications/verify-webhook-signature.
 * Strictly omits PayPal-Auth-Assertion and PayPal-Partner-Attribution-Id headers per PayPal API contract.
 */
export async function verifyPayPalWebhookSignature(params: {
  paypalClient: Pick<PayPalClient, "post">;
  config: PayPalConfig;
  webhookId: string;
  headers: PayPalWebhookHeaders;
  rawEnvelope: PayPalWebhookEnvelope;
}): Promise<VerifySignatureResult> {
  const { paypalClient, webhookId, headers, rawEnvelope } = params;

  try {
    const response = await paypalClient.post<{ verification_status?: string }>(
      "/v1/notifications/verify-webhook-signature",
      {
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
        webhook_event: rawEnvelope,
      },
      {
        skipPartnerAttribution: true,
      }
    );

    const status = response?.data?.verification_status?.trim().toUpperCase();
    if (status === "SUCCESS") {
      return { verified: true };
    }

    return {
      verified: false,
      transient: false,
      error: "INVALID_WEBHOOK_SIGNATURE",
      message: "PayPal webhook signature verification returned FAILURE.",
    };
  } catch (err: unknown) {
    if (err instanceof PayPalError) {
      if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 && err.status !== 429) {
        return {
          verified: false,
          transient: false,
          error: "INVALID_WEBHOOK_SIGNATURE",
          message: "PayPal rejected webhook signature verification payload.",
        };
      }
    }

    return {
      verified: false,
      transient: true,
      error: "WEBHOOK_VERIFICATION_UNAVAILABLE",
      message: "PayPal webhook signature verification service temporarily unavailable.",
    };
  }
}

export function isValidUuid(candidate: unknown): candidate is string {
  return typeof candidate === "string" && UUID_REGEX.test(candidate.trim());
}

/**
 * Strips unnecessary PII (emails, names, billing/shipping addresses, links) while preserving
 * verification fields required for ledger reconciliation and replay audits.
 */
export function sanitizePayPalCaptureSnapshot(
  capture: PayPalCaptureEntryShape & {
    supplementary_data?: { related_ids?: { order_id?: string } };
    final_capture?: boolean;
    create_time?: string;
    update_time?: string;
  }
): Record<string, unknown> {
  return {
    id: capture.id ?? null,
    status: capture.status ?? null,
    final_capture: capture.final_capture ?? null,
    amount: capture.amount
      ? {
          currency_code: capture.amount.currency_code ?? null,
          value: capture.amount.value ?? null,
        }
      : null,
    custom_id: capture.custom_id ?? null,
    payee: capture.payee?.merchant_id
      ? { merchant_id: capture.payee.merchant_id }
      : null,
    supplementary_data: capture.supplementary_data?.related_ids?.order_id
      ? {
          related_ids: {
            order_id: capture.supplementary_data.related_ids.order_id,
          },
        }
      : null,
    create_time: capture.create_time ?? null,
    update_time: capture.update_time ?? null,
  };
}

/**
 * Strips unnecessary payer/shipping PII from a PayPal Order response while preserving exact
 * contract fields checked by TypeScript and reconcile_and_complete_payment_intent().
 */
export function sanitizePayPalOrderSnapshot(
  order: PayPalOrderShape
): Record<string, unknown> {
  return {
    id: order.id ?? null,
    status: order.status ?? null,
    intent: order.intent ?? null,
    purchase_units: Array.isArray(order.purchase_units)
      ? order.purchase_units.map((pu) => ({
          reference_id: pu.reference_id ?? null,
          custom_id: pu.custom_id ?? null,
          amount: pu.amount
            ? {
                currency_code: pu.amount.currency_code ?? null,
                value: pu.amount.value ?? null,
              }
            : null,
          payee: pu.payee?.merchant_id
            ? { merchant_id: pu.payee.merchant_id }
            : null,
          payments: Array.isArray(pu.payments?.captures)
            ? {
                captures: pu.payments!.captures!.map((cap) =>
                  sanitizePayPalCaptureSnapshot(cap)
                ),
              }
            : undefined,
        }))
      : [],
  };
}

/**
 * Produces a PII-minimized representation of a verified PayPal webhook envelope
 * safe to persist in provider_webhook_events.payload without storing buyer PII or secrets.
 */
export function sanitizePayPalWebhookPayload(
  envelope: PayPalWebhookEnvelope
): Record<string, unknown> {
  const res = envelope.resource;
  const rawSupplementary = res.supplementary_data as
    | { related_ids?: { order_id?: unknown } }
    | undefined;
  const relatedOrderId =
    typeof rawSupplementary?.related_ids?.order_id === "string"
      ? rawSupplementary.related_ids.order_id.trim()
      : undefined;

  const rawPayee = res.payee as { merchant_id?: unknown } | undefined;
  const payeeMerchantId =
    typeof rawPayee?.merchant_id === "string" ? rawPayee.merchant_id.trim() : undefined;

  const rawAmount = res.amount as
    | { currency_code?: unknown; value?: unknown }
    | undefined;

  const sanitizedPurchaseUnits = Array.isArray(res.purchase_units)
    ? (res.purchase_units as Array<Record<string, unknown>>).map((pu) => {
        const puPayee = pu.payee as { merchant_id?: unknown } | undefined;
        const puAmount = pu.amount as
          | { currency_code?: unknown; value?: unknown }
          | undefined;
        return {
          reference_id:
            typeof pu.reference_id === "string" ? pu.reference_id.trim() : undefined,
          custom_id:
            typeof pu.custom_id === "string" ? pu.custom_id.trim() : undefined,
          payee:
            typeof puPayee?.merchant_id === "string"
              ? { merchant_id: puPayee.merchant_id.trim() }
              : undefined,
          amount: puAmount
            ? {
                currency_code:
                  typeof puAmount.currency_code === "string"
                    ? puAmount.currency_code.trim()
                    : undefined,
                value:
                  typeof puAmount.value === "string" ? puAmount.value.trim() : undefined,
              }
            : undefined,
        };
      })
    : undefined;

  return {
    id: envelope.id.trim(),
    event_type: envelope.event_type.trim(),
    event_version:
      typeof envelope.event_version === "string" ? envelope.event_version.trim() : undefined,
    resource_type:
      typeof envelope.resource_type === "string" ? envelope.resource_type.trim() : undefined,
    create_time:
      typeof envelope.create_time === "string" ? envelope.create_time.trim() : undefined,
    resource: {
      id: typeof res.id === "string" ? res.id.trim() : undefined,
      status: typeof res.status === "string" ? res.status.trim() : undefined,
      intent: typeof res.intent === "string" ? res.intent.trim() : undefined,
      custom_id: typeof res.custom_id === "string" ? res.custom_id.trim() : undefined,
      payee: payeeMerchantId ? { merchant_id: payeeMerchantId } : undefined,
      amount: rawAmount
        ? {
            currency_code:
              typeof rawAmount.currency_code === "string"
                ? rawAmount.currency_code.trim()
                : undefined,
            value:
              typeof rawAmount.value === "string" ? rawAmount.value.trim() : undefined,
          }
        : undefined,
      supplementary_data: relatedOrderId
        ? { related_ids: { order_id: relatedOrderId } }
        : undefined,
      purchase_units: sanitizedPurchaseUnits,
    },
  };
}

export interface WebhookResourceIdentifiers {
  eventType: string;
  resourceId: string | null;
  orderId: string | null;
  captureId: string | null;
  customId: string | null;
}

/**
 * Extracts untrusted candidate resource identifiers from a verified webhook envelope.
 * These are used ONLY to look up server-side database records prior to authoritative PayPal GET checks.
 */
export function extractWebhookCandidateIdentifiers(
  envelope: PayPalWebhookEnvelope
): WebhookResourceIdentifiers {
  const eventType = envelope.event_type.trim();
  const res = envelope.resource;
  const resourceId = typeof res.id === "string" && res.id.trim() ? res.id.trim() : null;

  let orderId: string | null = null;
  let captureId: string | null = null;
  let customId: string | null =
    typeof res.custom_id === "string" && res.custom_id.trim() ? res.custom_id.trim() : null;

  if (eventType.startsWith("CHECKOUT.ORDER.")) {
    orderId = resourceId;
    if (!customId && Array.isArray(res.purchase_units) && res.purchase_units.length === 1) {
      const firstPu = res.purchase_units[0] as Record<string, unknown> | undefined;
      if (firstPu && typeof firstPu.custom_id === "string" && firstPu.custom_id.trim()) {
        customId = firstPu.custom_id.trim();
      }
    }
  } else if (eventType.startsWith("PAYMENT.CAPTURE.")) {
    captureId = resourceId;
    const rawSupp = res.supplementary_data as
      | { related_ids?: { order_id?: unknown } }
      | undefined;
    if (
      rawSupp?.related_ids &&
      typeof rawSupp.related_ids.order_id === "string" &&
      rawSupp.related_ids.order_id.trim()
    ) {
      orderId = rawSupp.related_ids.order_id.trim();
    }
  }

  return {
    eventType,
    resourceId,
    orderId,
    captureId,
    customId,
  };
}

export function extractWebhookSanitizedMetadata(
  envelope: PayPalWebhookEnvelope
): Record<string, unknown> {
  const candidates = extractWebhookCandidateIdentifiers(envelope);
  return {
    eventType: candidates.eventType,
    resourceType:
      typeof envelope.resource_type === "string" ? envelope.resource_type.trim() : null,
    resourceId: candidates.resourceId,
    relatedOrderId: candidates.orderId,
    captureId: candidates.captureId,
  };
}
