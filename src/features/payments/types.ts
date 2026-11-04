export type PaymentIntentStatus =
  | "ORDER_CREATING"
  | "ORDER_CREATED"
  | "BUYER_APPROVED"
  | "CAPTURING"
  | "RECONCILING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "RECONCILIATION_REQUIRED";

export type PaymentTransactionType = "CAPTURE" | "REFUND" | "REVERSAL";

export type PaymentTransactionStatus = "COMPLETED" | "PENDING" | "FAILED" | "REFUNDED";

export interface PaymentIntent {
  id: string;
  project_id: string;
  milestone_id: string;
  agreement_version_id: string;
  environment: "SANDBOX";
  is_sandbox_demo: boolean;
  status: PaymentIntentStatus;
  expected_merchant_id: string;
  expected_currency: "USD";
  expected_amount_canonical: string;
  expected_amount_cents: number | bigint;
  provider: "PAYPAL";
  provider_order_id: string | null;
  order_idempotency_key: string;
  capture_idempotency_key: string;
  canonical_payload_json: Record<string, unknown>;
  order_creation_lease_expires_at: string | null;
  capture_lease_expires_at: string | null;
  buyer_approved_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentTransaction {
  id: string;
  payment_intent_id: string;
  parent_transaction_id: string | null;
  transaction_type: PaymentTransactionType;
  provider: "PAYPAL";
  provider_reference_id: string;
  status: PaymentTransactionStatus;
  amount_cents: number | bigint;
  currency: "USD";
  payee_merchant_id: string;
  raw_response: Record<string, unknown>;
  captured_at: string;
  created_at: string;
}

export interface ClientPortalToken {
  id: string;
  project_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ClientPortalSession {
  id: string;
  project_id: string;
  client_email: string;
  session_token_hash: string;
  csrf_secret: string;
  created_at: string;
  last_active_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface ReconciliationRecoveryParams {
  intentId: string;
  providerCaptureId: string;
  rawCaptureResponse: Record<string, unknown>;
  rawOrderResponse: Record<string, unknown>;
  resolutionNotes?: string;
  amountCents?: bigint | number;
  payeeMerchantId?: string;
}

