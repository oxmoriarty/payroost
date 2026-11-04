import "server-only";

import {
  type CachedToken,
  type PayPalConfig,
  type PayPalOAuthTokenResponse,
  type PayPalApiErrorResponse,
  PayPalError,
} from "./types";

/**
 * Manages PayPal OAuth 2.0 Client Credentials token acquisition and caching.
 *
 * Invariants:
 * - Server-only execution.
 * - In-memory caching: Reuses valid tokens across requests.
 * - Safety margin: Refreshes tokens 60 seconds before actual expiration.
 * - Concurrent deduplication: Multiple simultaneous requests wait on a single in-flight token exchange.
 * - Credential protection: Client ID, secret, and authorization headers are never logged or exposed.
 */
export class PayPalAuthManager {
  private cachedToken: CachedToken | null = null;
  private inFlightTokenPromise: Promise<string> | null = null;
  private readonly safetyMarginMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: PayPalConfig,
    options?: { safetyMarginMs?: number; timeoutMs?: number }
  ) {
    this.safetyMarginMs = options?.safetyMarginMs ?? 60_000; // 1 minute safety buffer
    this.timeoutMs = options?.timeoutMs ?? 10_000; // 10 second timeout
  }

  /**
   * Retrieves a valid PayPal OAuth access token.
   * If a cached token is valid and outside the safety margin, it is returned immediately.
   * Concurrent callers share the same token request promise.
   */
  public async getAccessToken(): Promise<string> {
    const now = Date.now();

    // Check if current cached token is still valid with safety margin
    if (this.cachedToken && now < this.cachedToken.expiresAt - this.safetyMarginMs) {
      return this.cachedToken.accessToken;
    }

    // Deduplicate concurrent token requests
    if (this.inFlightTokenPromise) {
      return await this.inFlightTokenPromise;
    }

    this.inFlightTokenPromise = this.fetchNewToken();

    try {
      return await this.inFlightTokenPromise;
    } catch (err) {
      this.cachedToken = null;
      throw err;
    } finally {
      this.inFlightTokenPromise = null;
    }
  }

  /**
   * Executes the client_credentials grant against /v1/oauth2/token.
   */
  private async fetchNewToken(): Promise<string> {
    const url = `${this.config.baseUrl}/v1/oauth2/token`;
    const basicAuth = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`
    ).toString("base64");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new PayPalError({
          message: `PayPal OAuth token request timed out after ${this.timeoutMs}ms`,
          status: 408,
          errorName: "OAUTH_TIMEOUT",
        });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      this.cachedToken = null;
      let errorBody: PayPalApiErrorResponse | null = null;
      try {
        const text = await response.text();
        if (text) {
          errorBody = JSON.parse(text) as PayPalApiErrorResponse;
        }
      } catch {
        // Non-JSON error response
      }

      const debugId = response.headers.get("PayPal-Debug-Id") ?? errorBody?.debug_id ?? undefined;
      const message =
        errorBody?.error_description ||
        errorBody?.message ||
        errorBody?.name ||
        errorBody?.error ||
        `PayPal OAuth authorization failed with status ${response.status}`;

      throw new PayPalError({
        message,
        status: response.status,
        debugId,
        details: errorBody?.details,
        errorName: errorBody?.error ?? errorBody?.name ?? "OAUTH_AUTHENTICATION_FAILURE",
      });
    }

    let data: PayPalOAuthTokenResponse;
    try {
      data = (await response.json()) as PayPalOAuthTokenResponse;
    } catch {
      this.cachedToken = null;
      throw new PayPalError({
        message: "Failed to parse PayPal OAuth response as JSON",
        status: 502,
        errorName: "INVALID_OAUTH_RESPONSE",
      });
    }

    // SEC-3B1-04: Strict access_token validation
    if (!data.access_token || typeof data.access_token !== "string" || data.access_token.trim().length === 0) {
      this.cachedToken = null;
      throw new PayPalError({
        message: "PayPal OAuth response missing or empty access_token",
        status: 502,
        errorName: "MALFORMED_OAUTH_RESPONSE",
      });
    }

    // SEC-3B1-04: Strict expires_in validation (must be positive finite number)
    if (
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      this.cachedToken = null;
      throw new PayPalError({
        message: `PayPal OAuth response contains invalid expires_in: ${String(data.expires_in)}`,
        status: 502,
        errorName: "MALFORMED_OAUTH_RESPONSE",
      });
    }

    const expiresAt = Date.now() + data.expires_in * 1000;

    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt,
    };

    return data.access_token;
  }

  // Cache management for test isolation and administrative operations
  public clearCache(): void {
    this.cachedToken = null;
    this.inFlightTokenPromise = null;
  }

  public getCachedToken(): Readonly<CachedToken> | null {
    return this.cachedToken ? { ...this.cachedToken } : null;
  }

  public setCachedToken(token: CachedToken): void {
    this.cachedToken = { ...token };
  }
}
