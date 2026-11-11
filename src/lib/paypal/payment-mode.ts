import type { PayPalConfig, PayPalPaymentMode } from "./types";

const SELLER_ID_REGEX = /^[A-Za-z0-9_-]{3,64}$/;
const ATTRIBUTION_ID_REGEX = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface PlatformModeConfigValidationSuccess {
  valid: true;
  mode: PayPalPaymentMode;
  effectivePlatformClientId: string;
  partnerMerchantId?: string;
  partnerAttributionId?: string;
}

export interface PlatformModeConfigValidationFailure {
  valid: false;
  mode: PayPalPaymentMode;
  reason: string;
}

export type PlatformModeConfigValidationResult =
  | PlatformModeConfigValidationSuccess
  | PlatformModeConfigValidationFailure;

/**
 * Resolves the server's explicit PayPal payment mode, defaulting fail-closed to PLATFORM.
 */
export function getServerPayPalPaymentMode(config: PayPalConfig): PayPalPaymentMode {
  return config.paymentMode ?? "PLATFORM";
}

/**
 * Validates that the server's active PayPal configuration is complete for its configured mode.
 * Fails closed on missing or half-configured Platform credentials or partner merchant ID.
 */
export function validatePayPalServerModeConfig(
  config: PayPalConfig
): PlatformModeConfigValidationResult {
  const mode = getServerPayPalPaymentMode(config);
  const partnerAttributionId = config.partnerAttributionId?.trim() || undefined;

  if (partnerAttributionId && !ATTRIBUTION_ID_REGEX.test(partnerAttributionId)) {
    return {
      valid: false,
      mode,
      reason: "INVALID_PARTNER_ATTRIBUTION_ID",
    };
  }

  if (mode === "PLATFORM") {
    const partnerMerchantId = config.partnerMerchantId?.trim();
    if (!partnerMerchantId || !SELLER_ID_REGEX.test(partnerMerchantId)) {
      return {
        valid: false,
        mode,
        reason: "MISSING_OR_INVALID_PARTNER_MERCHANT_ID",
      };
    }

    const hasPlatformId = Boolean(config.platformClientId?.trim());
    const hasPlatformSecret = Boolean(config.platformClientSecret?.trim());
    if (hasPlatformId !== hasPlatformSecret) {
      return {
        valid: false,
        mode,
        reason: "PARTIAL_PLATFORM_OAUTH_CREDENTIALS",
      };
    }

    const effectivePlatformClientId =
      config.platformClientId?.trim() || config.clientId?.trim() || "";
    const effectivePlatformClientSecret =
      config.platformClientSecret?.trim() || config.clientSecret?.trim() || "";

    if (!effectivePlatformClientId || !effectivePlatformClientSecret) {
      return {
        valid: false,
        mode,
        reason: "MISSING_PLATFORM_OAUTH_CREDENTIALS",
      };
    }

    return {
      valid: true,
      mode,
      effectivePlatformClientId,
      partnerMerchantId,
      partnerAttributionId,
    };
  }

  const expectedMerchantId = config.expectedMerchantId?.trim();
  if (!expectedMerchantId || !SELLER_ID_REGEX.test(expectedMerchantId)) {
    return {
      valid: false,
      mode,
      reason: "MISSING_OR_INVALID_EXPECTED_MERCHANT_ID",
    };
  }

  if (!config.clientId?.trim() || !config.clientSecret?.trim()) {
    return {
      valid: false,
      mode,
      reason: "MISSING_MERCHANT_OAUTH_CREDENTIALS",
    };
  }

  return {
    valid: true,
    mode,
    effectivePlatformClientId: config.clientId.trim(),
    partnerAttributionId,
  };
}

export interface ParsedIntentMetadataSuccess {
  valid: true;
  mode: PayPalPaymentMode;
  isLegacyWithoutMode: boolean;
  sellerMerchantId?: string;
  sellerPayerId?: string;
  purchaseUnitPayeeMerchantId?: string;
  purchaseUnits?: unknown[];
}

export interface ParsedIntentMetadataFailure {
  valid: false;
  reason: "CORRUPTED_CANONICAL_PAYLOAD" | "INVALID_PAYMENT_MODE";
}

export type ParsedIntentMetadataResult =
  | ParsedIntentMetadataSuccess
  | ParsedIntentMetadataFailure;

/**
 * Extracts explicit payment mode and persisted seller identity from canonical_payload_json.
 * Never infers PLATFORM mode from merchant ID comparisons.
 * Historical pre-R2 records lacking payment_mode are explicitly tagged as legacy MERCHANT only.
 */
export function parseIntentPaymentMetadata(
  canonicalPayloadJson: unknown
): ParsedIntentMetadataResult {
  if (canonicalPayloadJson === null || canonicalPayloadJson === undefined) {
    return {
      valid: true,
      mode: "MERCHANT",
      isLegacyWithoutMode: true,
    };
  }

  if (typeof canonicalPayloadJson !== "object" || Array.isArray(canonicalPayloadJson)) {
    return {
      valid: false,
      reason: "CORRUPTED_CANONICAL_PAYLOAD",
    };
  }

  const payload = canonicalPayloadJson as Record<string, unknown>;
  const rawMode = payload.payment_mode;

  let mode: PayPalPaymentMode;
  let isLegacyWithoutMode = false;

  if (rawMode === undefined || rawMode === null) {
    mode = "MERCHANT";
    isLegacyWithoutMode = true;
  } else if (rawMode === "PLATFORM" || rawMode === "MERCHANT") {
    mode = rawMode;
  } else {
    return {
      valid: false,
      reason: "INVALID_PAYMENT_MODE",
    };
  }

  const purchaseUnits = Array.isArray(payload.purchase_units)
    ? payload.purchase_units
    : undefined;

  let purchaseUnitPayeeMerchantId: string | undefined;
  if (purchaseUnits && purchaseUnits.length === 1) {
    const firstPu = purchaseUnits[0];
    if (firstPu && typeof firstPu === "object" && !Array.isArray(firstPu)) {
      const payee = (firstPu as { payee?: unknown }).payee;
      if (payee && typeof payee === "object" && !Array.isArray(payee)) {
        const merchantId = (payee as { merchant_id?: unknown }).merchant_id;
        if (typeof merchantId === "string" && merchantId.trim().length > 0) {
          purchaseUnitPayeeMerchantId = merchantId.trim();
        }
      }
    }
  }

  const sellerMerchantId =
    typeof payload.seller_merchant_id === "string" && payload.seller_merchant_id.trim().length > 0
      ? payload.seller_merchant_id.trim()
      : undefined;

  const sellerPayerId =
    typeof payload.seller_payer_id === "string" && payload.seller_payer_id.trim().length > 0
      ? payload.seller_payer_id.trim()
      : undefined;

  return {
    valid: true,
    mode,
    isLegacyWithoutMode,
    sellerMerchantId,
    sellerPayerId,
    purchaseUnitPayeeMerchantId,
    purchaseUnits,
  };
}

/**
 * Validates that a candidate seller payer_id is well-formed and cannot be confused
 * with PayRoost's own Platform client or partner merchant credentials.
 */
export function isValidDistinctSellerIdentifier(
  candidate: unknown,
  config: PayPalConfig
): candidate is string {
  if (typeof candidate !== "string") return false;
  const trimmed = candidate.trim();
  if (!SELLER_ID_REGEX.test(trimmed)) return false;

  const platformClientId = config.platformClientId?.trim() || config.clientId?.trim();
  const partnerMerchantId = config.partnerMerchantId?.trim();

  if (platformClientId && trimmed === platformClientId) return false;
  if (partnerMerchantId && trimmed === partnerMerchantId) return false;

  return true;
}
