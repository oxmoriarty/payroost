-- PayRoost Phase 3B.R1: Freelancer PayPal Seller Account Foundation
-- Enables freelancers to connect their PayPal Sandbox seller accounts via Partner Referrals.
--
-- Security Invariants:
-- 1. RLS enabled: Authenticated freelancers can read strictly their own seller account record.
-- 2. Authenticated users CANNOT insert, update, or delete seller account records directly via PostgREST.
-- 3. All state mutations (onboarding status, merchant ID, readiness) must be executed by trusted server-side service role.
-- 4. Tracking ID is an opaque, non-reversible identifier (does NOT leak auth.users UUID).
-- 5. Does not alter or drop any existing payment tables or functions.

create table if not exists public.freelancer_paypal_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade unique,
  paypal_merchant_id text check (paypal_merchant_id is null or char_length(trim(paypal_merchant_id)) between 3 and 64),
  tracking_id text not null unique check (char_length(trim(tracking_id)) between 16 and 128),
  partner_referral_id text,
  action_url text,
  onboarding_status text not null default 'INITIATED' check (onboarding_status in ('INITIATED', 'COMPLETED', 'REVOKED', 'FAILED')),
  payments_receivable boolean not null default false,
  primary_email_confirmed boolean not null default false,
  seller_email text,
  oauth_permissions jsonb,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for performance and lookup integrity
create index if not exists freelancer_paypal_accounts_user_id_idx
  on public.freelancer_paypal_accounts(user_id);

create index if not exists freelancer_paypal_accounts_tracking_id_idx
  on public.freelancer_paypal_accounts(tracking_id);

create index if not exists freelancer_paypal_accounts_merchant_id_idx
  on public.freelancer_paypal_accounts(paypal_merchant_id)
  where paypal_merchant_id is not null;

-- Enable Row Level Security
alter table public.freelancer_paypal_accounts enable row level security;

-- Read-only policy for authenticated freelancers to view their own connection status
create policy "freelancers_select_own_paypal_account"
  on public.freelancer_paypal_accounts for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Explicitly disallow client-side mutations (service_role only writes)
-- No INSERT, UPDATE, or DELETE policies are granted to authenticated or anon.

-- Grant permissions explicitly
revoke all on public.freelancer_paypal_accounts from public;
grant select on public.freelancer_paypal_accounts to authenticated;
grant all on public.freelancer_paypal_accounts to service_role;

-- Attach set_updated_at trigger
create or replace trigger freelancer_paypal_accounts_set_updated_at
  before update on public.freelancer_paypal_accounts
  for each row execute procedure public.set_updated_at();
