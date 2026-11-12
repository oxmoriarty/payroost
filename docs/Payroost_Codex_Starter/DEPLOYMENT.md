# Payroost — Environment and Deployment

## 1. Required accounts
- GitHub (public repository for submission)
- Supabase project
- Gemini API access
- PayPal Developer account with Sandbox app
- Vercel project
- YouTube account for public demo video

## 2. Environment variables

Create `.env.local` locally and configure the same values in Vercel.

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Gemini (server only)
GEMINI_API_KEY=
GEMINI_MODEL=

# PayPal Sandbox
PAYPAL_ENV=sandbox
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
NEXT_PUBLIC_PAYPAL_CLIENT_ID=

# Application
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

The public PayPal client ID is not a secret. The PayPal client secret, Gemini key, and Supabase service-role key are secrets. Never prefix server secrets with `NEXT_PUBLIC_`.

## 3. Supabase setup
1. Create project.
2. Copy URL and anon key.
3. Store service role key server-side only.
4. Apply migrations in order.
5. Verify RLS is enabled and policies behave correctly.
6. Configure authentication redirect URLs for localhost and deployed domain.
7. Add fictional seed data only.

## 4. PayPal Sandbox setup
1. Create/login to PayPal Developer account.
2. Create a Sandbox REST app.
3. Copy Sandbox client ID and secret.
4. Configure the PayPal Multiparty Sandbox platform app and the buyer/seller Sandbox accounts required by the selected official integration guide. Confirm seller onboarding and country/account eligibility before testing checkout.
5. Create/confirm Sandbox Personal buyer account.
6. Configure app with required webhook events and deployed HTTPS endpoint.
7. Save webhook ID securely.
8. Test buyer approval using the Sandbox Personal account.

Use Sandbox endpoints and accounts only. Do not put live credentials in the hackathon prototype.

## 5. Gemini setup
1. Create an API key through the provider's official developer console.
2. Add it as `GEMINI_API_KEY`.
3. Choose a currently available model and set `GEMINI_MODEL`.
4. Confirm server-only usage and rate limits.
5. Test invalid output and provider failure paths.

## 6. Vercel deployment
1. Push code to GitHub.
2. Import repository into Vercel.
3. Set all environment variables.
4. Set `NEXT_PUBLIC_APP_URL` to deployed HTTPS origin.
5. Deploy.
6. Apply database migrations.
7. Configure Supabase auth URLs.
8. Register PayPal webhook against deployed HTTPS endpoint.
9. Redeploy if required.
10. Run full deployed end-to-end test.

## 7. Submission readiness
- Hosted demo URL works without developer tools.
- Public source repository contains code, assets, instructions, and license.
- README includes setup, environment variables, migration, and run commands.
- Demo video is public on YouTube and under 3 minutes.
- Video shows actual running project on the device/platform built for.
- No third-party copyrighted music/material without permission.
- Explain which AI model/service was used and exactly what it does.
- Explain PayPal integration and Sandbox limitation accurately.
