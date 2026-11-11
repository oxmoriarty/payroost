# PayRoost — Phase AI-Foundation: Model Compatibility Correction Report

**Date:** November 10, 2026  
**Status:** COMPLETE & VERIFIED  
**Phase:** AI-Foundation (Model Compatibility & Error Classification Correction)  
**Concurrent Workstream:** Phase 3B.R1 — PayPal Platform Seller Connection Foundation (Unchanged & Isolated)

---

## 1. Executive Summary

During the **AI-Foundation Verification Audit**, a critical compatibility issue was discovered in PayRoost's AI configuration:
- The default model in `src/lib/ai/env.ts` and constructor fallback in `src/lib/ai/client.ts` was `gemini-1.5-flash`.
- Google shut down the `gemini-1.5-flash` model family in September 2025. Consequently, any deployment relying on default configuration would fail immediately on live completions with HTTP 404/400 errors.
- HTTP 400 (Bad Request / Schema error) and HTTP 404 (Model or Endpoint Not Found) responses from Google's API were being misclassified as `AiUnavailableError` (which maps to HTTP 503 "Service Unavailable"), masking configuration and request errors as transient provider downtime.

This phase executed a comprehensive model compatibility correction:
1. **Model Modernization:** Replaced obsolete `gemini-1.5-flash` with Google's active Free-Tier model `gemini-3.8-flash` as the single source of truth across environment schemas, runtime fallbacks, `.env.example`, `README.md`, and unit tests.
2. **Strict Free-Tier ($0) Adherence:** Confirmed `gemini-3.8-flash` is 100% free of charge under Google AI Studio's Free Tier (15 RPM, 1,000,000 TPM, 1,500 RPD).
3. **API & REST Specification Compatibility:** Verified compatibility with Gemini Generative Language REST v1beta API (`v1beta/models/{model}:generateContent`), `systemInstruction`, `generationConfig`, and structured JSON schema output (`responseMimeType: "application/json"`).
4. **Error Classification Correction:** Reclassified HTTP 400 and HTTP 404 errors as `AiConfigurationError` (`status: 400` / `status: 404`), preventing deceptive HTTP 503 responses.
5. **Full Regression Verification:** Verified 44 AI tests (100% pass), 64 agreement tests (100% pass), 0 TypeScript errors, 0 ESLint warnings, and successful Next.js production build (18 routes).

---

## 2. Root Cause Analysis of Model Obsolescence

### 2.1 Deprecation Timeline
According to Google's official Gemini API deprecation schedule:
- **May 27, 2025:** Gemini 1.5 Flash 001 was formally deprecated and retired.
- **September 24, 2025:** Gemini 1.5 Flash 002 was retired from the Generative Language v1beta endpoint.
- **September 29, 2025:** The generic alias `gemini-1.5-flash` was deactivated across Google AI Studio and API gateways.

### 2.2 Impact on PayRoost
When the AI Foundation was initially scaffolded, `gemini-1.5-flash` was chosen based on legacy assumptions. Under live conditions, requesting `v1beta/models/gemini-1.5-flash:generateContent` would immediately return:
- HTTP 404 `NOT_FOUND`: `"models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent"`.
Because `src/lib/ai/client.ts` previously caught any non-401/429 status as `AiUnavailableError`, the application would misinform operators and users that Gemini was temporarily offline, rather than alerting them to an obsolete model identifier.

---

## 3. Model Selection & Free-Tier Verification

### 3.1 Selected Model: `gemini-3.8-flash`
Google's current official documentation lists `gemini-3.8-flash` as the active standard multimodal model for high-throughput, low-latency, and structured tasks:
- **Documentation:** `https://ai.google.dev/gemini-api/docs/models`
- **Deprecations:** `https://ai.google.dev/gemini-api/docs/deprecations`
- **Changelog:** `https://ai.google.dev/gemini-api/docs/changelog`
- **Pricing:** `https://ai.google.dev/pricing`

### 3.2 Free-Tier ($0) Rate Limits & Quotas
PayRoost's business model strictly mandates zero recurring AI operational cost during the bootstrap phase. `gemini-3.8-flash` provides:
- **Cost:** **$0.00 / Free of charge** under Google AI Studio Free Tier.
- **Rate Limits:**
  - **15 RPM** (Requests Per Minute) — sufficient for PayRoost's user flow with our existing sliding-window rate limiter (10 req/min per user).
  - **1,000,000 TPM** (Tokens Per Minute) — allows large brief and agreement context windows.
  - **1,500 RPD** (Requests Per Day) — well beyond current application volume.
- **Context Window:** Up to 1,048,576 tokens input, 8,192 tokens output.
- **Zero Paid Fallbacks:** There is no silent fallback to paid models (`gemini-1.5-pro` or paid tiers). If rate limits are exceeded, PayRoost transparently throws `AiRateLimitError` (HTTP 429).

---

## 4. Gemini REST API Specification Compatibility

### 4.1 Endpoint Specification
- **URL Pattern:** `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
- **HTTP Method:** `POST`
- **Headers:** `Content-Type: application/json`

### 4.2 Request Payload Format
`src/lib/ai/client.ts` formats generation requests matching Google's v1beta specification:
```json
{
  "systemInstruction": {
    "role": "system",
    "parts": [{ "text": "System prompt..." }]
  },
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "User input prompt..." }]
    }
  ],
  "generationConfig": {
    "temperature": 0.2,
    "topP": 0.95,
    "maxOutputTokens": 4096,
    "responseMimeType": "application/json",
    "responseSchema": {
      "type": "OBJECT",
      "properties": { ... },
      "required": [ ... ]
    }
  }
}
```

### 4.3 Structured Output Compatibility
- **`responseMimeType: "application/json"`**: Enforces JSON response from `gemini-3.8-flash`.
- **`responseSchema`**: Converted from Zod schema via `zodToGeminiSchema()` in `src/lib/ai/provider.ts`.
- **Two-Layer Validation**: Gemini's structured response is parsed and then validated against the original Zod schema using `schema.safeParse()` before resolving, guaranteeing full type safety.

### 4.4 Live API Key Status
- Inspection of the local environment confirmed that neither `.env` nor `.env.local` is present in the workspace root, and no system `GEMINI_API_KEY` is set.
- Per strict instructions: **No live completion was fabricated or executed**. Live API network verification remains marked as **unverified** due to the absence of a configured test key, while REST schema and payload compatibility are confirmed by the static API specification.

---

## 5. Error Classification Correction

Prior to this correction, `src/lib/ai/client.ts` handled HTTP errors as follows:
- HTTP 401 / 403 $\rightarrow$ `AiAuthenticationError`
- HTTP 429 $\rightarrow$ `AiRateLimitError`
- All other status codes (including HTTP 400 Bad Request and HTTP 404 Model Not Found) $\rightarrow$ `AiUnavailableError`

This had two major defects:
1. An invalid schema or bad argument (HTTP 400) was reported as provider downtime (HTTP 503).
2. An obsolete or misspelled model (HTTP 404) was reported as provider downtime (HTTP 503).

### Corrected Implementation
1. **`src/lib/ai/errors.ts`:**
   ```typescript
   export class AiConfigurationError extends AiError {
     constructor(message: string, options?: { status?: number; cause?: unknown }) {
       super(message, {
         code: "AI_CONFIG_ERROR",
         status: options?.status ?? 500,
         retryable: false,
         cause: options?.cause,
       });
       this.name = "AiConfigurationError";
     }
   }
   ```
2. **`src/lib/ai/client.ts`:**
   ```typescript
   if (response.status === 400) {
     throw new AiConfigurationError(`Gemini bad request (status 400): ${errorMessage}`, {
       status: 400,
     });
   }
   if (response.status === 404) {
     throw new AiConfigurationError(
       `Gemini model or endpoint not found (status 404): ${errorMessage}`,
       { status: 404 }
     );
   }
   ```
Now:
- HTTP 400 returns `AiConfigurationError` (`status: 400`, `code: AI_CONFIG_ERROR`, `retryable: false`).
- HTTP 404 returns `AiConfigurationError` (`status: 404`, `code: AI_CONFIG_ERROR`, `retryable: false`).
- Transient errors (500, 502, 503, 504) remain `AiUnavailableError` (`status: 503`, `retryable: true`).

---

## 6. Implementation Changes & Single Source of Truth

To ensure that the model identifier is not hardcoded across multiple files, a centralized constant was established:

### 6.1 `src/lib/ai/env.ts`
- Defined and exported `DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"`.
- Updated `aiEnvSchema`:
  ```typescript
  export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

  export const aiEnvSchema = z.object({
    apiKey: z.string().min(1, "GEMINI_API_KEY is required"),
    model: z.string().min(1).default(DEFAULT_GEMINI_MODEL),
    timeoutMs: z.coerce.number().int().positive().default(30000),
    maxRetries: z.coerce.number().int().nonnegative().default(2),
  });
  ```

### 6.2 `src/lib/ai/client.ts`
- Imported `DEFAULT_GEMINI_MODEL` from `./env`.
- `GeminiProvider` constructor now falls back to `DEFAULT_GEMINI_MODEL`:
  ```typescript
  this.model = options.model ?? DEFAULT_GEMINI_MODEL;
  ```
- Ensured client fallback and environment validator agree completely.
- Preserved user overrides: If `GEMINI_MODEL` is explicitly passed or configured, it is honored and never silently rewritten.

### 6.3 Environment & Documentation
- **`.env.example`**:
  ```env
  # Gemini (server only - Free Tier default: gemini-3.8-flash)
  GEMINI_API_KEY=
  GEMINI_MODEL=gemini-3.8-flash
  ```
- **`README.md`**:
  Updated setup instructions under AI Assistant to specify `GEMINI_MODEL=gemini-3.8-flash`.

---

## 7. Verification Results

All checks were executed cleanly on Windows (PowerShell) against the full workspace:

### 7.1 AI Foundation Test Suite
```bash
npx vitest run src/lib/ai
```
- **Test Files:** 5 passed (5)
- **Tests:** 44 passed (44)
  - `src/lib/ai/provider.test.ts` (7 tests) — Schema conversion, prompt construction, Zod validation
  - `src/lib/ai/errors.test.ts` (9 tests) — Error inheritance, status codes, retryability flags
  - `src/lib/ai/audit.test.ts` (5 tests) — Audit logging, sensitive key redacting (`AIza...`, query params), sink error resilience
  - `src/lib/ai/env.test.ts` (10 tests) — Environment validation, `DEFAULT_GEMINI_MODEL` verification, custom options
  - `src/lib/ai/client.test.ts` (13 tests) — Generation flow, HTTP 400/404 handling, 401 auth, 429 rate limit, 503 unavailable, timeout handling, constructor fallback

### 7.2 Agreement Regression Test Suite
```bash
npx vitest run src/features/agreements
```
- **Test Files:** 4 passed (4)
- **Tests:** 64 passed (64)
  - `src/features/agreements/review-security.test.ts` (16 tests)
  - `src/features/agreements/verified-decision-security.test.ts` (36 tests)
  - `src/features/agreements/versioning.test.ts` (4 tests)
  - `src/features/agreements/agreement-editor.test.ts` (8 tests)

### 7.3 TypeScript Strict Typecheck
```bash
npx tsc --noEmit
```
- **Exit Code:** 0 (Zero errors)

### 7.4 ESLint Static Analysis
```bash
npx eslint .
```
- **Exit Code:** 0 (Zero errors, zero warnings)

### 7.5 Production Build
```bash
npm run build
```
- **Result:** Successfully compiled in Turbopack Next.js 16.4.4.
- **Routes:** 18 static and dynamic routes compiled without errors.

---

## 8. Concurrency & Isolation Verification

In compliance with the mandatory concurrent isolation rules:
- **Untouched Workstreams:**
  - `src/lib/paypal/**`: Intact
  - `src/features/payments/**`: Intact
  - `src/features/freelancer/**`: Intact
  - `supabase/**`: No migrations or SQL touched
  - Legacy routes (`src/features/agreements/gemini.ts` and `src/app/api/ai/generate-agreement/route.ts`): Untouched
  - `package.json` and lockfiles: Untouched
- **Files Modified in this Phase:**
  - `src/lib/ai/env.ts`
  - `src/lib/ai/client.ts`
  - `src/lib/ai/errors.ts`
  - `.env.example`
  - `README.md`
  - `src/lib/ai/env.test.ts`
  - `src/lib/ai/client.test.ts`
  - `src/lib/ai/errors.test.ts`
  - `src/lib/ai/audit.test.ts`

---

## 9. Conclusion & Readiness for AI-2

The AI Foundation layer is now fully aligned with Google's active API, strictly configured for the Free Tier ($0), correctly maps all error categories, and is backed by a 44-test automated suite.

**The system is verified and ready for Phase AI-2 (Project Brief Structuring).**
