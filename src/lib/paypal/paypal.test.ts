import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPayPalServerEnv } from "./env";
import { PayPalAuthManager } from "./auth";
import { PayPalClient } from "./client";
import { PayPalError, type PayPalConfig } from "./types";

describe("Phase 3B.1: PayPal Server Infrastructure & REST Client", () => {
  const validMockConfig: PayPalConfig = {
    environment: "sandbox",
    baseUrl: "https://api-m.sandbox.paypal.com",
    clientId: "TEST_CLIENT_ID_XYZ",
    clientSecret: "TEST_CLIENT_SECRET_SUPER_SECRET_123",
    expectedMerchantId: "TEST_MERCHANT_999",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Missing PayPal Credentials
  // ==========================================================================
  it("1. rejects missing PayPal credentials", () => {
    expect(() =>
      getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "",
        PAYPAL_CLIENT_SECRET: "some-secret",
        PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_123",
      })
    ).toThrow(/PAYPAL_CLIENT_ID/);

    expect(() =>
      getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client-id",
        PAYPAL_CLIENT_SECRET: "",
        PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_123",
      })
    ).toThrow(/PAYPAL_CLIENT_SECRET/);
  });

  // ==========================================================================
  // 2. Missing Expected Merchant ID
  // ==========================================================================
  it("2. rejects missing or malformed expected merchant ID", () => {
    expect(() =>
      getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client-id",
        PAYPAL_CLIENT_SECRET: "client-secret",
        PAYPAL_EXPECTED_MERCHANT_ID: "",
      })
    ).toThrow(/PAYPAL_EXPECTED_MERCHANT_ID/);

    // Too short (less than 3 chars)
    expect(() =>
      getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client-id",
        PAYPAL_CLIENT_SECRET: "client-secret",
        PAYPAL_EXPECTED_MERCHANT_ID: "AB",
      })
    ).toThrow(/PAYPAL_EXPECTED_MERCHANT_ID/);
  });

  // ==========================================================================
  // 3. Invalid Environment Configuration
  // ==========================================================================
  it("3. rejects invalid or live/production environment configuration", () => {
    expect(() =>
      getPayPalServerEnv({
        PAYPAL_ENV: "production",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client-id",
        PAYPAL_CLIENT_SECRET: "client-secret",
        PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_123",
      })
    ).toThrow(/PAYPAL_ENV/);

    expect(() =>
      getPayPalServerEnv({
        PAYPAL_ENV: "live",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client-id",
        PAYPAL_CLIENT_SECRET: "client-secret",
        PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_123",
      })
    ).toThrow(/PAYPAL_ENV/);
  });

  // ==========================================================================
  // 4. Sandbox Endpoint Selection
  // ==========================================================================
  it("4. strictly selects and enforces the Sandbox API base URL", () => {
    const config = getPayPalServerEnv({
      PAYPAL_ENV: "sandbox",
      PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
      PAYPAL_CLIENT_ID: "client-id",
      PAYPAL_CLIENT_SECRET: "client-secret",
      PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_123",
    });

    expect(config.baseUrl).toBe("https://api-m.sandbox.paypal.com");

    // Rejects production API endpoint
    expect(() =>
      getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.paypal.com",
        PAYPAL_CLIENT_ID: "client-id",
        PAYPAL_CLIENT_SECRET: "client-secret",
        PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_123",
      })
    ).toThrow(/Production endpoints are rejected/);
  });

  // ==========================================================================
  // 5. OAuth Token Acquisition
  // ==========================================================================
  it("5. obtains OAuth access token using client credentials flow", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "mock-access-token-111",
        token_type: "Bearer",
        expires_in: 32400,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth = new PayPalAuthManager(validMockConfig);
    const token = await auth.getAccessToken();

    expect(token).toBe("mock-access-token-111");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, requestInit] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers.Authorization).toBe(
      `Basic ${Buffer.from("TEST_CLIENT_ID_XYZ:TEST_CLIENT_SECRET_SUPER_SECRET_123").toString("base64")}`
    );
    expect(requestInit.body).toBe("grant_type=client_credentials");
  });

  // ==========================================================================
  // 6. OAuth Token Caching
  // ==========================================================================
  it("6. caches access token and reuses it for subsequent requests", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "cached-token-222",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth = new PayPalAuthManager(validMockConfig);

    const token1 = await auth.getAccessToken();
    const token2 = await auth.getAccessToken();
    const token3 = await auth.getAccessToken();

    expect(token1).toBe("cached-token-222");
    expect(token2).toBe("cached-token-222");
    expect(token3).toBe("cached-token-222");
    // Ensure fetch was only called ONCE due to caching
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 7. Token Refresh Before Expiry
  // ==========================================================================
  it("7. refreshes token before expiry with safety margin buffer", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "initial-token-333",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "refreshed-token-444",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const auth = new PayPalAuthManager(validMockConfig, { safetyMarginMs: 60_000 });
    const token1 = await auth.getAccessToken();
    expect(token1).toBe("initial-token-333");

    // Artificially age the cached token so it falls inside the 60-second safety margin
    auth.setCachedToken({
      accessToken: "initial-token-333",
      expiresAt: Date.now() + 30_000, // Expires in 30s, which is within the 60s safety margin!
    });

    const token2 = await auth.getAccessToken();
    expect(token2).toBe("refreshed-token-444");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // 8. Concurrent Token Acquisition
  // ==========================================================================
  it("8. deduplicates concurrent token acquisition requests", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      // Simulate small network delay
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "concurrent-token-555",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth = new PayPalAuthManager(validMockConfig);

    // Launch 5 concurrent calls simultaneously
    const results = await Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
    ]);

    expect(results).toEqual([
      "concurrent-token-555",
      "concurrent-token-555",
      "concurrent-token-555",
      "concurrent-token-555",
      "concurrent-token-555",
    ]);
    expect(callCount).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 9. OAuth Failure Handling
  // ==========================================================================
  it("9. safely handles OAuth failures without exposing secrets", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ "PayPal-Debug-Id": "debug-oauth-401" }),
      text: async () =>
        JSON.stringify({
          error: "invalid_client",
          error_description: "Client Authentication failed",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth = new PayPalAuthManager(validMockConfig);

    await expect(auth.getAccessToken()).rejects.toThrow(PayPalError);
    await expect(auth.getAccessToken()).rejects.toThrow(/Client Authentication failed/);
  });

  // ==========================================================================
  // 10. PayPal API Non-2xx Handling
  // ==========================================================================
  it("10. safely handles PayPal API non-2xx responses and captures debug ID", async () => {
    // 1st call is for auth token
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "valid-token-777",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      })
      // 2nd call is the API request that fails
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers({ "PayPal-Debug-Id": "debug-not-found-888" }),
        text: async () =>
          JSON.stringify({
            name: "RESOURCE_NOT_FOUND",
            message: "The specified resource does not exist.",
            debug_id: "debug-not-found-888",
            details: [{ issue: "INVALID_RESOURCE_ID", description: "Resource ID not found" }],
          }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const client = new PayPalClient(validMockConfig);

    try {
      await client.get("/v2/checkout/orders/NON_EXISTENT_ORDER");
      expect.unreachable("Should have thrown PayPalError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(PayPalError);
      const payPalErr = err as PayPalError;
      expect(payPalErr.status).toBe(404);
      expect(payPalErr.debugId).toBe("debug-not-found-888");
      expect(payPalErr.message).toBe("The specified resource does not exist.");
      expect(payPalErr.details).toEqual([
        { issue: "INVALID_RESOURCE_ID", description: "Resource ID not found" },
      ]);
    }
  });

  // ==========================================================================
  // 11. Request Timeout Handling
  // ==========================================================================
  it("11. handles request timeouts with AbortError and returns HTTP 408 error", async () => {
    // 1st call for auth token
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "valid-token-888",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      })
      // 2nd call simulates a hanging request that aborts
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            setTimeout(() => reject(error), 20);
          })
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new PayPalClient({ ...validMockConfig, timeoutMs: 10 });

    try {
      await client.get("/v2/checkout/orders/SLOW_ORDER", { timeoutMs: 10 });
      expect.unreachable("Should have timed out");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(PayPalError);
      const payPalErr = err as PayPalError;
      expect(payPalErr.status).toBe(408);
      expect(payPalErr.errorName).toBe("REQUEST_TIMEOUT");
      expect(payPalErr.message).toMatch(/timed out after 10ms/);
    }
  });

  // ==========================================================================
  // 12. Ensuring Secrets Are Not Exposed
  // ==========================================================================
  it("12. ensures secrets and access tokens are never exposed in errors or config getters", async () => {
    const client = new PayPalClient(validMockConfig);

    // 12a. getConfig() strips clientSecret
    const publicConfig = client.getConfig();
    expect(publicConfig).not.toHaveProperty("clientSecret");
    // @ts-expect-error verifying property does not exist on stripped object
    expect(publicConfig.clientSecret).toBeUndefined();

    // 12b. Errors do not leak clientSecret
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => JSON.stringify({ name: "VALIDATION_ERROR", message: "Malformed request" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      await client.post("/test-endpoint", { data: "test" });
    } catch (err: unknown) {
      const errStr = JSON.stringify(err) + String(err);
      expect(errStr).not.toContain("TEST_CLIENT_SECRET_SUPER_SECRET_123");
    }
  });

  // ==========================================================================
  // 13. Ensuring Server-Only Protection
  // ==========================================================================
  it("13. ensures PayPal client and auth modules cannot be imported in client-side code (static check)", () => {
    const clientFile = readFileSync(resolve(process.cwd(), "src/lib/paypal/client.ts"), "utf-8");
    const authFile = readFileSync(resolve(process.cwd(), "src/lib/paypal/auth.ts"), "utf-8");
    const envFile = readFileSync(resolve(process.cwd(), "src/lib/paypal/env.ts"), "utf-8");

    // Verify all modules begin with import "server-only"
    expect(clientFile).toMatch(/^import\s+["']server-only["'];/m);
    expect(authFile).toMatch(/^import\s+["']server-only["'];/m);
    expect(envFile).toMatch(/^import\s+["']server-only["'];/m);
  });

  // ==========================================================================
  // 14. Path Hardening & Origin Divergence Protection (SEC-3B1-03)
  // ==========================================================================
  it("14. restricts request paths to single-slash relative paths and prevents origin divergence", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v1/oauth2/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "token-14", expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ id: "ORDER_OK" }),
        json: async () => ({ id: "ORDER_OK" }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new PayPalClient(validMockConfig);

    // 14a. Valid relative path succeeds
    const res = await client.get("/v2/checkout/orders/ORDER_OK");
    expect(res.data).toEqual({ id: "ORDER_OK" });

    // 14b. Rejects path without leading slash
    await expect(client.get("v2/checkout/orders")).rejects.toThrow(
      /Path must be a relative path beginning with exactly one "\/"/
    );

    // 14c. Rejects double-slash protocol-relative path
    await expect(client.get("//evil.com/v2/checkout/orders")).rejects.toThrow(
      /Path must be a relative path beginning with exactly one "\/"/
    );

    // 14d. Rejects absolute external URLs
    await expect(client.get("https://evil.com/v2/checkout/orders")).rejects.toThrow(
      /Path must be a relative path beginning with exactly one "\/"/
    );
    await expect(client.get("http://evil.com/v2/checkout/orders")).rejects.toThrow(
      /Path must be a relative path beginning with exactly one "\/"/
    );

    // 14e. Rejects URI schemes
    await expect(client.get("javascript:alert(1)")).rejects.toThrow(
      /Path must be a relative path beginning with exactly one "\/"/
    );
    await expect(client.get("ftp://evil.com/exploit")).rejects.toThrow(
      /Path must be a relative path beginning with exactly one "\/"/
    );

    // 14f. Rejects backslash traversal attempts
    await expect(client.get("/\\evil.com")).rejects.toThrow(/Backslashes are strictly prohibited/);
  });

  // ==========================================================================
  // 15. Strict OAuth Expiry and Token Validation (SEC-3B1-04)
  // ==========================================================================
  it("15. strictly rejects missing, non-numeric, zero, negative, or non-finite expires_in with HTTP 502", async () => {
    const auth = new PayPalAuthManager(validMockConfig);

    const testInvalidExpiry = async (expiresInVal: unknown, description: string) => {
      auth.clearCache();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "test-token",
          token_type: "Bearer",
          expires_in: expiresInVal,
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      try {
        await auth.getAccessToken();
        expect.unreachable(`Should have thrown for ${description}`);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PayPalError);
        const pErr = err as PayPalError;
        expect(pErr.status).toBe(502);
        expect(pErr.errorName).toBe("MALFORMED_OAUTH_RESPONSE");
        expect(pErr.message).toMatch(/invalid expires_in/);
      }
      expect(auth.getCachedToken()).toBeNull();
    };

    // Missing (undefined)
    await testInvalidExpiry(undefined, "missing expires_in");
    // String number
    await testInvalidExpiry("3600", "string expires_in");
    // Zero
    await testInvalidExpiry(0, "zero expires_in");
    // Negative number
    await testInvalidExpiry(-100, "negative expires_in");
    // NaN
    await testInvalidExpiry(NaN, "NaN expires_in");
    // Infinity
    await testInvalidExpiry(Infinity, "Infinity expires_in");

    // Missing access_token
    auth.clearCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          token_type: "Bearer",
          expires_in: 3600,
        }),
      })
    );
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      status: 502,
      errorName: "MALFORMED_OAUTH_RESPONSE",
    });
    expect(auth.getCachedToken()).toBeNull();
  });

  // ==========================================================================
  // 16. OAuth Error Recovery and In-Flight Promise Clearing (SEC-3B1-05a)
  // ==========================================================================
  it("16. clears in-flight promise on OAuth failure and allows subsequent request to succeed and cache", async () => {
    const auth = new PayPalAuthManager(validMockConfig);

    // Call 1: Fails with 500 error
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => JSON.stringify({ message: "Internal server error" }),
      })
      // Call 2: Succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "recovered-token-999",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    // First attempt fails
    await expect(auth.getAccessToken()).rejects.toThrow(PayPalError);
    expect(auth.getCachedToken()).toBeNull();

    // Second attempt initiates a fresh fetch and succeeds
    const token = await auth.getAccessToken();
    expect(token).toBe("recovered-token-999");
    expect(auth.getCachedToken()?.accessToken).toBe("recovered-token-999");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Third attempt reuses cached token without additional fetch
    const cached = await auth.getAccessToken();
    expect(cached).toBe("recovered-token-999");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // 17. Mandatory Security Header Protection and Merge Order (SEC-3B1-05b)
  // ==========================================================================
  it("17. enforces security headers, overrides caller Authorization and Content-Type, and strips prohibited headers", async () => {
    const client = new PayPalClient(validMockConfig);

    let capturedHeaders: Headers | undefined;
    const mockFetch = vi
      .fn()
      // 1. Auth token
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "trusted-token-abc",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      })
      // 2. API Call with malicious caller headers
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({ success: true }),
        };
      });
    vi.stubGlobal("fetch", mockFetch);

    await client.request({
      path: "/v2/checkout/orders",
      method: "POST",
      body: { intent: "CAPTURE" },
      paypalRequestId: "canonical-request-id-123",
      headers: {
        // Attacker attempts to spoof authorization
        Authorization: "Bearer spoofed-attacker-token",
        // Attacker attempts to disrupt JSON serialization content-type
        "Content-Type": "application/x-www-form-urlencoded",
        // Attacker attempts to smuggle multiparty assertion
        "PayPal-Auth-Assertion": "jwt-assertion-spoof",
      },
    });

    expect(capturedHeaders).toBeDefined();
    // 17a. Authorization must strictly match genuine server token
    expect(capturedHeaders!.get("Authorization")).toBe("Bearer trusted-token-abc");
    // 17b. Content-Type must strictly be application/json when body is provided
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json");
    // 17c. Accept must be application/json
    expect(capturedHeaders!.get("Accept")).toBe("application/json");
    // 17d. PayPal-Request-Id must be set from canonical option
    expect(capturedHeaders!.get("PayPal-Request-Id")).toBe("canonical-request-id-123");
    // 17e. PayPal-Auth-Assertion must be stripped
    expect(capturedHeaders!.get("PayPal-Auth-Assertion")).toBeNull();

    // 17f. When body is undefined, Content-Type is deleted even if caller provided one
    mockFetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ success: true }),
      };
    });

    await client.request({
      path: "/v2/checkout/orders/SOME_ORDER",
      method: "GET",
      headers: {
        "Content-Type": "text/html",
        "PayPal-Request-Id": "unauthorized-request-id",
      },
    });

    expect(capturedHeaders!.get("Content-Type")).toBeNull();
    // PayPal-Request-Id deleted when not specified in options
    expect(capturedHeaders!.get("PayPal-Request-Id")).toBeNull();
  });
});
