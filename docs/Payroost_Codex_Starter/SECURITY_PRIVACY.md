# Payroost — Security and Privacy Requirements

## 1. Secrets
- Keep PayPal client secret, Gemini API key, Supabase service role key, and webhook configuration server-side.
- Commit `.env.example`, never `.env.local`.
- Add `.env*` to `.gitignore` except `.env.example`.
- Never print secrets in logs, errors, screenshots, video, or client responses.
- Rotate any secret accidentally exposed.

## 2. Authentication and authorization
- Require authentication for owner workspace routes.
- Verify ownership server-side for every project read/write.
- Public client review/payment routes use high-entropy random tokens.
- Store only token hashes in database.
- Expire and revoke tokens.
- Rate-limit public token endpoints.
- Do not use predictable sequential IDs as access credentials.

## 3. Supabase
- Enable RLS for all user data tables.
- Keep service role key server-only.
- Use least privilege.
- Add SQL constraints and unique indexes for critical invariants.
- Do not rely on frontend filtering for access control.

## 4. Payment security
- Server calculates amount and currency from database.
- Server creates and captures PayPal orders.
- Verify webhook signatures.
- Deduplicate webhook event IDs.
- Validate order/capture IDs, amount, currency, and expected payee.
- Use idempotency keys for retries.
- Do not mark payment completed based only on a browser callback.
- Do not store card numbers, CVV, or payment credentials.
- Do not claim escrow, conditional release or seller payout unless the selected provider confirms the capability and the legal/commercial arrangement has been reviewed.

## 5. AI safety
- Treat all user/project content as untrusted input.
- Do not pass secrets or unrelated project data to model.
- Validate structured output.
- Human approval required for agreement, scope change, price, dates, and payment actions.
- No legal, financial, or dispute outcome guarantees.
- Add rate limits and sensible input length limits.

## 6. Data minimisation
- Collect only project/client information required for the workflow.
- Avoid storing full PayPal payer details unless required.
- Provide a clear privacy notice in the app.
- Define a retention/deletion approach before production use.
- Hackathon demo data must be fictional.

## 7. Application hardening
- Validate inputs with Zod on the server.
- Use safe output rendering; avoid injecting untrusted HTML.
- Apply CSRF protections appropriate to the chosen auth/session model.
- Configure secure cookies and production HTTPS.
- Rate-limit AI endpoints, login-sensitive actions, and public token routes.
- Set request size limits.
- Avoid open redirects.
- Return generic errors to unauthenticated callers.
- Add security headers where compatible with the PayPal SDK.
