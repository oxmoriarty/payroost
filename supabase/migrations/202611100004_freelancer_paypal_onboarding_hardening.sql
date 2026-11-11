-- PayRoost Phase 3B.R1.1: Freelancer PayPal Onboarding Contract Verification & Hardening
--
-- Security & Concurrency Enhancements:
-- 1. Updates onboarding_status check constraint to include 'PROCESSING' for atomic lease/claim fencing.
-- 2. Introduces public.claim_freelancer_paypal_onboarding_callback() RPC with row-level locking (FOR UPDATE)
--    to prevent concurrent callback processing races and replay attacks.
-- 3. Grants execution strictly to service_role (revoked from public, anon, authenticated).

-- 1. Update onboarding_status check constraint
alter table public.freelancer_paypal_accounts
  drop constraint if exists freelancer_paypal_accounts_onboarding_status_check;

alter table public.freelancer_paypal_accounts
  add constraint freelancer_paypal_accounts_onboarding_status_check
  check (onboarding_status in ('INITIATED', 'PROCESSING', 'COMPLETED', 'REVOKED', 'FAILED'));

-- 2. Atomic claim function for onboarding callback handling
create or replace function public.claim_freelancer_paypal_onboarding_callback(
  p_user_id uuid,
  p_tracking_id text
)
returns table (
  claimed boolean,
  account_id uuid,
  current_status text,
  current_merchant_id text,
  is_receivable boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.freelancer_paypal_accounts%rowtype;
begin
  -- Row-lock record for update to guarantee single-consumer serialization
  select * into v_account
  from public.freelancer_paypal_accounts
  where user_id = p_user_id and tracking_id = p_tracking_id
  for update;

  if not found then
    return query select false, null::uuid, 'NOT_FOUND'::text, null::text, false;
    return;
  end if;

  -- Replay prevention: only INITIATED attempts can be claimed
  if v_account.onboarding_status <> 'INITIATED' then
    return query select
      false,
      v_account.id,
      v_account.onboarding_status,
      v_account.paypal_merchant_id,
      v_account.payments_receivable;
    return;
  end if;

  -- Atomically claim onboarding attempt into PROCESSING state
  update public.freelancer_paypal_accounts
  set
    onboarding_status = 'PROCESSING',
    updated_at = now()
  where id = v_account.id;

  return query select
    true,
    v_account.id,
    'PROCESSING'::text,
    v_account.paypal_merchant_id,
    v_account.payments_receivable;
end;
$$;

-- Restrict execution strictly to service_role
revoke all on function public.claim_freelancer_paypal_onboarding_callback(uuid, text) from public;
revoke all on function public.claim_freelancer_paypal_onboarding_callback(uuid, text) from anon;
revoke all on function public.claim_freelancer_paypal_onboarding_callback(uuid, text) from authenticated;
grant execute on function public.claim_freelancer_paypal_onboarding_callback(uuid, text) to service_role;
