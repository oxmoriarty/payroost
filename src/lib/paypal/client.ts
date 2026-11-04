import "server-only";

import { getPayPalServerEnv } from "./env";
import { PayPalAuthManager } from "./auth";
import {
  type PayPalApiResponse,
  type PayPalApiErrorResponse,
  type PayPalConfig,
  type PayPalRequestOptions,
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

    // SEC-3B1-02: Strictly strip unsupported multiparty headers
    headers.delete("PayPal-Auth-Assertion");

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

  public getConfig(): Readonly<Omit<PayPalConfig, "clientSecret">> {
    return {
      environment: this.config.environment,
      baseUrl: this.config.baseUrl,
      clientId: this.config.clientId,
      expectedMerchantId: this.config.expectedMerchantId,
      webhookId: this.config.webhookId,
      timeoutMs: this.config.timeoutMs,
    };
  }
}
