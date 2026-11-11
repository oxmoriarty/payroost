/**
 * PayPal API & Client Type Definitions
 *
 * Scoped specifically for PayPal Complete Payments Platform Sandbox integration.
 * Provider implementation details are kept strictly typed and isolated from core domain models.
 */

export type PayPalPaymentMode = "PLATFORM" | "MERCHANT";

export interface PayPalConfig {
  environment: "sandbox";
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  expectedMerchantId: string;
  webhookId?: string;
  timeoutMs?: number;
  platformClientId?: string;
  platformClientSecret?: string;
  partnerMerchantId?: string;
  partnerAttributionId?: string;
  paymentMode?: PayPalPaymentMode;
}

export interface PayPalOAuthTokenResponse {
  scope?: string;
  access_token: string;
  token_type: string;
  app_id?: string;
  expires_in: number;
  nonce?: string;
}

export interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

export interface PayPalErrorIssue {
  issue?: string;
  description?: string;
  field?: string;
  location?: string;
}

export interface PayPalApiErrorResponse {
  name?: string;
  message?: string;
  debug_id?: string;
  error?: string;
  error_description?: string;
  details?: PayPalErrorIssue[];
  links?: Array<{ href: string; rel: string; method?: string }>;
}

export class PayPalError extends Error {
  public readonly status: number;
  public readonly debugId?: string;
  public readonly details?: PayPalErrorIssue[];
  public readonly errorName?: string;

  constructor(params: {
    message: string;
    status: number;
    debugId?: string;
    details?: PayPalErrorIssue[];
    errorName?: string;
  }) {
    super(params.message);
    this.name = "PayPalError";
    this.status = params.status;
    this.debugId = params.debugId;
    this.details = params.details;
    this.errorName = params.errorName;

    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, PayPalError.prototype);
  }
}

export interface PayPalRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  paypalRequestId?: string;
  partnerAttributionId?: string;
  authAssertion?: { payerId: string };
}

export interface PayPalApiResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
}

export interface CreatePlatformOrderParams {
  sellerMerchantId: string;
  sellerPayerId: string;
  milestoneId: string;
  paymentIntentId: string;
  amountCanonical: string;
  currency?: string;
  idempotencyKey: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PlatformOrderResult {
  orderId: string;
  status: string;
  approvalUrl: string | null;
  sellerMerchantId: string;
  sellerPayerId?: string;
  rawResponse?: PayPalOrderResource;
}

export interface PayPalOrderResource {
  id: string;
  status: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: {
      currency_code?: string;
      value?: string;
    };
    payee?: {
      merchant_id?: string;
      email_address?: string;
    };
  }>;
  links?: Array<{ href: string; rel: string; method?: string }>;
}
