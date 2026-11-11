import "server-only";

import { getPayPalServerEnv } from "./env";
import { PayPalAuthManager } from "./auth";
import {
  type PayPalApiResponse,
  type PayPalApiErrorResponse,
  type PayPalConfig,
  type PayPalRequestOptions,
  type CreatePlatformOrderParams,
  type PlatformOrderResult,
  type PayPalOrderResource,
  PayPalError,
} from "./types";

/**
 * Reusable, server-only PayPal REST API Client.
 *
 * Scoped to PayPal Complete Payments Platform Sandbox environment.
 * Provides resilient HTTP interaction, explicit timeouts, sanitized error translation,
 * and automatic bearer token acquisition.
 */
export class PayPalClient {
  private readonly config: PayPalConfig;
  private readonly authManager: PayPalAuthManager;
  private readonly defaultTimeoutMs: number;

  constructor(config?: PayPalConfig, authManager?: PayPalAuthManager) {
    this.config = config ?? getPayPalServerEnv();
    this.authManager = authManager ?? new PayPalAuthManager(this.config);
    this.defaultTimeoutMs = this.config.timeoutMs ?? 15_000;
  }

  /**
   * Validates that a seller merchant/payer identifier is well-formed and distinct
   * from PayRoost platform credentials so platform identity is never conflated with a seller.
   */
  private validateSellerIdentifier(
    rawId: string | undefined,
    errorName: "INVALID_SELLER_PAYER_ID" | "INVALID_SELLER_MERCHANT_ID",
    fieldLabel: string
  ): { sellerId: string; platformClientId: string } {
    const sellerId = rawId?.trim() ?? "";
    const platformClientId = (this.config.platformClientId || this.config.clientId)?.trim() ?? "";
    const partnerMerchantId = this.config.partnerMerchantId?.trim();

    if (!platformClientId) {
      throw new PayPalError({
        message: "Missing platform client ID for multi-party PayPal operation",
        status: 500,
        errorName: "CONFIGURATION_ERROR",
      });
    }

    if (
      sellerId.length < 3 ||
      sellerId.length > 64 ||
      sellerId === platformClientId ||
      (partnerMerchantId && sellerId === partnerMerchantId)
    ) {
      throw new PayPalError({
        message: `Invalid ${fieldLabel}: must be a valid seller identifier and cannot equal the platform client ID or partner merchant ID`,
        status: 400,
        errorName,
      });
    }

    return { sellerId, platformClientId };
  }

  /**
   * Dispatches an authenticated request to the PayPal Sandbox API.
   *
   * Invariants:
   * - Injects Authorization: Bearer <token> from PayPalAuthManager.
   * - Never exposes credentials or bearer tokens in errors or logs.
   * - Enforces request timeout with AbortController.
   * - Accurately captures PayPal-Debug-Id header for auditability.
   * - Does not silently retry non-idempotent operations.
   */
  public async request<T = unknown>(options: PayPalRequestOptions): Promise<PayPalApiResponse<T>> {
    // SEC-3B1-03: Restrict PayPal request paths to relative paths starting with exactly one "/"
    if (
      typeof options.path !== "string" ||
      !options.path.startsWith("/") ||
      options.path.startsWith("//")
    ) {
      throw new PayPalError({
        message: `Invalid PayPal API path: "${options.path}". Path must be a relative path beginning with exactly one "/".`,
        status: 400,
        errorName: "INVALID_REQUEST_PATH",
      });
    }

    if (options.path.includes("\\")) {
      throw new PayPalError({
        message: `Invalid PayPal API path: "${options.path}". Backslashes are strictly prohibited.`,
        status: 400,
        errorName: "INVALID_REQUEST_PATH",
      });
    }

    const expectedOrigin = new URL(this.config.baseUrl).origin;
    let targetUrl: URL;
    try {
      targetUrl = new URL(options.path, this.config.baseUrl);
    } catch (urlErr) {
      throw new PayPalError({
        message: `Failed to construct target URL for path "${options.path}": ${urlErr instanceof Error ? urlErr.message : String(urlErr)}`,
        status: 400,
        errorName: "INVALID_REQUEST_PATH",
      });
    }

    if (targetUrl.origin !== expectedOrigin) {
      throw new PayPalError({
        message: `Target URL origin "${targetUrl.origin}" does not match configured base origin "${expectedOrigin}".`,
        status: 400,
        errorName: "ORIGIN_DIVERGENCE",
      });
    }

    const token = await this.authManager.getAccessToken();

    // SEC-3B1-05: Mandatory security headers strictly override caller-supplied headers
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");

    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    } else {
      headers.delete("Content-Type");
    }

    if (options.paypalRequestId) {
      headers.set("PayPal-Request-Id", options.paypalRequestId);
    } else {
      headers.delete("PayPal-Request-Id");
    }

    // Endpoint-specific Partner Attribution ID (BN Code)
    const partnerAttributionId =
      options.partnerAttributionId ||
      options.headers?.["PayPal-Partner-Attribution-Id"] ||
      this.config.partnerAttributionId;
    if (partnerAttributionId) {
      headers.set("PayPal-Partner-Attribution-Id", partnerAttributionId);
    } else {
      headers.delete("PayPal-Partner-Attribution-Id");
    }

    // Endpoint-specific PayPal-Auth-Assertion
    // Only attached when explicitly requested for authorized third-party partner calls.
    if (options.authAssertion !== undefined) {
      const { sellerId: payerId, platformClientId } = this.validateSellerIdentifier(
        options.authAssertion.payerId,
        "INVALID_SELLER_PAYER_ID",
        "PayPal-Auth-Assertion seller payer_id"
      );

      const jwtHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
      const jwtPayload = Buffer.from(
        JSON.stringify({
          iss: platformClientId,
          payer_id: payerId,
        })
      ).toString("base64url");
      headers.set("PayPal-Auth-Assertion", `${jwtHeader}.${jwtPayload}.`);
    } else {
      // SEC-3B1-02: Strictly strip unsupported multiparty assertion headers when unrequested
      headers.delete("PayPal-Auth-Assertion");
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(targetUrl.toString(), {
        method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new PayPalError({
          message: `PayPal API request to ${targetUrl.pathname} timed out after ${timeoutMs}ms`,
          status: 408,
          errorName: "REQUEST_TIMEOUT",
        });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    // Handle non-2xx responses safely
    if (!response.ok) {
      let errorBody: PayPalApiErrorResponse | null = null;
      try {
        const text = await response.text();
        if (text) {
          errorBody = JSON.parse(text) as PayPalApiErrorResponse;
        }
      } catch {
        // Non-JSON response
      }

      const debugId = response.headers.get("PayPal-Debug-Id") ?? errorBody?.debug_id ?? undefined;
      const message =
        errorBody?.message ||
        errorBody?.name ||
        `PayPal API request failed with HTTP ${response.status}`;

      throw new PayPalError({
        message,
        status: response.status,
        debugId,
        details: errorBody?.details,
        errorName: errorBody?.name ?? "API_ERROR",
      });
    }

    // 204 No Content
    if (response.status === 204) {
      return { data: {} as T, status: 204, headers: response.headers };
    }

    const rawText = await response.text();
    if (!rawText || rawText.trim().length === 0) {
      return { data: {} as T, status: response.status, headers: response.headers };
    }

    try {
      const data = JSON.parse(rawText) as T;
      return { data, status: response.status, headers: response.headers };
    } catch {
      throw new PayPalError({
        message: "Failed to parse PayPal API response as JSON",
        status: response.status,
        errorName: "INVALID_JSON_RESPONSE",
      });
    }
  }

  public get<T = unknown>(path: string, options?: Omit<PayPalRequestOptions, "path" | "method">) {
    return this.request<T>({ ...options, path, method: "GET" });
  }

  public post<T = unknown>(
    path: string,
    body: unknown,
    options?: Omit<PayPalRequestOptions, "path" | "method" | "body">
  ) {
    return this.request<T>({ ...options, path, method: "POST", body });
  }

  public getAuthManager(): PayPalAuthManager {
    return this.authManager;
  }

  public getConfig(): Readonly<Omit<PayPalConfig, "clientSecret" | "platformClientSecret">> {
    return {
      environment: this.config.environment,
      baseUrl: this.config.baseUrl,
      clientId: this.config.clientId,
      expectedMerchantId: this.config.expectedMerchantId,
      webhookId: this.config.webhookId,
      timeoutMs: this.config.timeoutMs,
      platformClientId: this.config.platformClientId,
      partnerMerchantId: this.config.partnerMerchantId,
      partnerAttributionId: this.config.partnerAttributionId,
      paymentMode: this.config.paymentMode,
    };
  }

  /**
   * Creates a multi-party PayPal Platform order routing payment directly to a connected seller.
   *
   * Security & Multi-Party Routing Invariants:
   * 1. Direct payee routing: purchase_units[0].payee.merchant_id is set to verified seller merchant ID.
   * 2. Platform Authentication: Signs PayPal-Auth-Assertion header scoping request to seller payer ID.
   * 3. BN Attribution: Attaches PayPal-Partner-Attribution-Id header if configured (omits if absent).
   * 4. Idempotency: Enforces PayPal-Request-Id header with persisted intent UUID.
   * 5. Experience context: Sets return_url, cancel_url, brand_name, NO_SHIPPING, and PAY_NOW action.
   * 6. Approval link extraction: Extracts the buyer approval URL from HATEOAS links.
   */
  public async createPlatformOrder(params: CreatePlatformOrderParams): Promise<PlatformOrderResult> {
    if (this.config.paymentMode !== "PLATFORM") {
      throw new PayPalError({
        message: "Refusing to create Platform multi-party order when paymentMode is not PLATFORM",
        status: 500,
        errorName: "INVALID_PAYMENT_MODE",
      });
    }

    const currency = params.currency || "USD";
    const { sellerId: validatedSellerMerchantId } = this.validateSellerIdentifier(
      params.sellerMerchantId,
      "INVALID_SELLER_MERCHANT_ID",
      "seller merchant_id"
    );

    if (params.sellerPayerId === undefined || params.sellerPayerId === null) {
      throw new PayPalError({
        message: "Missing required seller payer_id for Platform Auth Assertion",
        status: 400,
        errorName: "INVALID_SELLER_PAYER_ID",
      });
    }

    const { sellerId: sellerPayerId } = this.validateSellerIdentifier(
      params.sellerPayerId,
      "INVALID_SELLER_PAYER_ID",
      "seller payer_id"
    );

    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: params.milestoneId,
          custom_id: params.paymentIntentId,
          amount: {
            currency_code: currency,
            value: params.amountCanonical,
          },
          payee: {
            merchant_id: validatedSellerMerchantId,
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "PayRoost",
            locale: "en-US",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: params.returnUrl,
            cancel_url: params.cancelUrl,
          },
        },
      },
    };

    const response = await this.post<PayPalOrderResource>(
      "/v2/checkout/orders",
      body,
      {
        paypalRequestId: params.idempotencyKey,
        ...(this.config.partnerAttributionId
          ? { partnerAttributionId: this.config.partnerAttributionId }
          : {}),
        authAssertion: { payerId: sellerPayerId },
        headers: {
          Prefer: "return=representation",
        },
      }
    );

    const orderData = response.data;
    if (!orderData || typeof orderData.id !== "string" || orderData.id.trim().length === 0) {
      throw new PayPalError({
        message: "Malformed PayPal order response: missing or invalid order ID",
        status: 502,
        errorName: "MALFORMED_PROVIDER_RESPONSE",
      });
    }

    const approvalLink = orderData.links?.find(
      (link) => link.rel === "payer-action" || link.rel === "approve"
    );

    return {
      orderId: orderData.id.trim(),
      status: orderData.status,
      approvalUrl: approvalLink?.href ?? null,
      sellerMerchantId: validatedSellerMerchantId,
      sellerPayerId,
      rawResponse: orderData,
    };
  }
}
