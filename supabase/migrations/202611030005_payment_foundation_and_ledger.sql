-- Payroost Phase 3A.1: Database Foundation and Security Enforcement
-- Enforces:
-- 1. Client portal tokens, OTP challenges, and sessions with atomic state transitions and single-use consumption.
-- 2. Persistent OTP attempt counting that is NOT rolled back upon failed verification.
-- 3. Payment intents with immutable financial amounts, USD-only constraints, single active/completed per milestone,
--    and database-enforced state transitions.
-- 4. Append-only payment_transactions financial ledger with parent-child refund validation and concurrency protection.
-- 5. Provider webhook events queue with worker claim index.
-- 6. Immediate invalidation of portal tokens and sessions upon client email change.
-- 7. Strict RLS policies and granular privilege lockdown.

-- ============================================================================
-- 1. CLIENT PORTAL ACCESS & SESSIONS
-- ============================================================================

create table if not exists public.client_portal_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  token_hash text not null unique check (char_length(token_hash) = 64),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

-- Partial unique index: exactly ONE active (unrevoked and unconsumed) token per project
create unique index if not exists client_portal_tokens_one_active_idx
  on public.client_portal_tokens(project_id)
  where (revoked_at is null and consumed_at is null);

create index if not exists client_portal_tokens_lookup_idx
  on public.client_portal_tokens(token_hash)
  where (revoked_at is null and consumed_at is null);

create table if not exists public.client_portal_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  portal_token_id uuid not null references public.client_portal_tokens(id) on delete restrict,
  client_email text not null check (char_length(client_email) <= 320),
  otp_hmac text not null check (char_length(otp_hmac) = 64),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 5),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists client_portal_otp_challenges_active_idx
  on public.client_portal_otp_challenges(portal_token_id)
  where (consumed_at is null);

create table if not exists public.client_portal_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  client_email text not null check (char_length(client_email) <= 320),
  session_token_hash text not null unique check (char_length(session_token_hash) = 64),
  csrf_secret text not null check (char_length(csrf_secret) = 64),
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  expires_at timestamptz not null, -- Absolute 12-hour expiration limit
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index if not exists client_portal_sessions_active_idx
  on public.client_portal_sessions(session_token_hash)
  where (revoked_at is null);

-- ============================================================================
-- 2. PAYMENT INTENTS & AUDIT LEDGER
-- ============================================================================

create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  milestone_id uuid not null references public.milestones(id) on delete restrict,
  agreement_version_id uuid not null references public.agreement_versions(id) on delete restrict,
  environment text not null default 'SANDBOX' check (environment = 'SANDBOX'),
  is_sandbox_demo boolean not null default false,
  status text not null default 'ORDER_CREATING' check (
    status in (
      'ORDER_CREATING',
      'ORDER_CREATED',
      'BUYER_APPROVED',
      'CAPTURING',
      'RECONCILING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'RECONCILIATION_REQUIRED'
    )
  ),
  expected_merchant_id text not null check (char_length(trim(expected_merchant_id)) between 3 and 64),
  expected_currency text not null check (expected_currency = 'USD'),
  expected_amount_canonical text not null check (expected_amount_canonical ~ '^(0|[1-9]\d*)\.\d{2}$'),
  expected_amount_cents bigint not null check (expected_amount_cents > 0),
  provider text not null default 'PAYPAL' check (provider = 'PAYPAL'),
  provider_order_id text unique,
  order_idempotency_key uuid not null unique,
  capture_idempotency_key uuid not null unique,
  canonical_payload_json jsonb not null,
  order_creation_lease_expires_at timestamptz,
  capture_lease_expires_at timestamptz,
  buyer_approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Ensure canonical USD string and integer cents agree exactly
  check (
    expected_amount_cents = (
      (split_part(expected_amount_canonical, '.', 1)::bigint * 100) +
      (split_part(expected_amount_canonical, '.', 2)::bigint)
    )
  )
);

create unique index if not exists payment_intents_one_active_per_milestone_idx
  on public.payment_intents(milestone_id)
  where (status in (
    'ORDER_CREATING',
    'ORDER_CREATED',
    'BUYER_APPROVED',
    'CAPTURING',
    'RECONCILING',
    'RECONCILIATION_REQUIRED'
  ));

create unique index if not exists payment_intents_one_completed_per_milestone_idx
  on public.payment_intents(milestone_id)
  where (status = 'COMPLETED');

create index if not exists payment_intents_project_idx on public.payment_intents(project_id);
create index if not exists payment_intents_milestone_idx on public.payment_intents(milestone_id);

-- Append-Only Financial Transactions Ledger
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  payment_intent_id uuid not null references public.payment_intents(id) on delete restrict,
  parent_transaction_id uuid references public.payment_transactions(id) on delete restrict,
  transaction_type text not null default 'CAPTURE' check (transaction_type in ('CAPTURE', 'REFUND', 'REVERSAL')),
  provider text not null default 'PAYPAL' check (provider = 'PAYPAL'),
  provider_reference_id text not null unique check (char_length(trim(provider_reference_id)) > 0),
  status text not null check (status in ('COMPLETED', 'PENDING', 'FAILED', 'REFUNDED')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null check (currency = 'USD'),
  payee_merchant_id text not null check (char_length(trim(payee_merchant_id)) between 3 and 64),
  raw_response jsonb not null,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- At most one successful or pending capture per payment intent
create unique index if not exists payment_transactions_one_capture_per_intent_idx
  on public.payment_transactions(payment_intent_id)
  where (transaction_type = 'CAPTURE' and status in ('COMPLETED', 'PENDING'));

create index if not exists payment_transactions_intent_idx on public.payment_transactions(payment_intent_id);
create index if not exists payment_transactions_parent_idx on public.payment_transactions(parent_transaction_id)
  where (parent_transaction_id is not null);

-- Provider Webhook Events Queue
create table if not exists public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'PAYPAL' check (provider = 'PAYPAL'),
  provider_event_id text not null unique check (char_length(trim(provider_event_id)) > 0),
  event_type text not null check (char_length(trim(event_type)) > 0),
  resource_type text not null check (char_length(trim(resource_type)) > 0),
  payload_sha256 text not null check (char_length(payload_sha256) = 64),
  summary text,
  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'RETRY')),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  payload jsonb not null,
  error_details text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists provider_webhook_events_claim_idx
  on public.provider_webhook_events(created_at)
  where (status in ('RECEIVED', 'RETRY', 'PROCESSING'));

-- ============================================================================
-- 3. FINANCIAL IMMUTABILITY & TRANSITION TRIGGERS
-- ============================================================================

-- Immutability and state transition protection for payment_intents
create or replace function public.protect_payment_intent_immutability()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- 1. Immutable attribute protection
  if (old.project_id <> new.project_id or
      old.milestone_id <> new.milestone_id or
      old.agreement_version_id <> new.agreement_version_id or
      old.environment <> new.environment or
      old.is_sandbox_demo <> new.is_sandbox_demo or
      old.provider <> new.provider or
      old.expected_merchant_id <> new.expected_merchant_id or
      old.expected_currency <> new.expected_currency or
      old.expected_amount_canonical <> new.expected_amount_canonical or
      old.expected_amount_cents <> new.expected_amount_cents or
      old.canonical_payload_json <> new.canonical_payload_json or
      old.order_idempotency_key <> new.order_idempotency_key or
      old.capture_idempotency_key <> new.capture_idempotency_key or
      (old.provider_order_id is not null and old.provider_order_id <> new.provider_order_id)) then
    raise exception 'Payment intent immutable financial, relational, and identity attributes cannot be modified';
  end if;

  -- 2. State transition validation
  if old.status <> new.status then
    -- Terminal states cannot transition
    if old.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
      raise exception 'Terminal payment intent state % cannot transition to %', old.status, new.status;
    end if;

    -- Ambiguous state cannot transition automatically
    if old.status = 'RECONCILIATION_REQUIRED' then
      raise exception 'Payment intent in RECONCILIATION_REQUIRED cannot transition without privileged intervention';
    end if;

    -- Valid state transitions
    if old.status = 'ORDER_CREATING' and new.status not in ('ORDER_CREATED', 'FAILED', 'RECONCILIATION_REQUIRED') then
      raise exception 'Invalid transition from ORDER_CREATING to %', new.status;
    elsif old.status = 'ORDER_CREATED' and new.status not in ('BUYER_APPROVED', 'CANCELLED') then
      raise exception 'Invalid transition from ORDER_CREATED to %', new.status;
    elsif old.status = 'BUYER_APPROVED' and new.status not in ('CAPTURING') then
      raise exception 'Invalid transition from BUYER_APPROVED to %', new.status;
    elsif old.status = 'CAPTURING' and new.status not in ('COMPLETED', 'RECONCILING') then
      raise exception 'Invalid transition from CAPTURING to %', new.status;
    elsif old.status = 'RECONCILING' and new.status not in ('COMPLETED', 'BUYER_APPROVED', 'RECONCILIATION_REQUIRED') then
      raise exception 'Invalid transition from RECONCILING to %', new.status;
    end if;

    -- COMPLETED transition requires verified capture transaction in payment_transactions
    if new.status = 'COMPLETED' then
      if not exists (
        select 1 from public.payment_transactions pt
        where pt.payment_intent_id = new.id
          and pt.transaction_type = 'CAPTURE'
          and pt.status = 'COMPLETED'
      ) then
        raise exception 'Payment intent cannot be marked COMPLETED without a verified capture record in payment_transactions';
      end if;
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payment_intents_protect_immutability on public.payment_intents;
create trigger payment_intents_protect_immutability
  before update on public.payment_intents
  for each row execute procedure public.protect_payment_intent_immutability();

-- Prevent deletion of payment intents
create or replace function public.prevent_payment_intent_deletion()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Payment intents cannot be deleted; financial history is immutable';
end;
$$;

drop trigger if exists payment_intents_no_delete on public.payment_intents;
create trigger payment_intents_no_delete
  before delete on public.payment_intents
  for each row execute procedure public.prevent_payment_intent_deletion();

-- Append-Only Financial Ledger: Prevent UPDATE and DELETE on payment_transactions
create or replace function public.prevent_payment_transactions_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Financial transaction ledger is strictly append-only and cannot be updated or deleted';
end;
$$;

drop trigger if exists payment_transactions_immutable on public.payment_transactions;
create trigger payment_transactions_immutable
  before update or delete on public.payment_transactions
  for each row execute procedure public.prevent_payment_transactions_mutation();

-- Insertion-Time Integrity Validation for payment_transactions
create or replace function public.validate_payment_transaction_insert()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_parent public.payment_transactions%rowtype;
  v_existing_refunds bigint;
begin
  -- Lock associated payment intent row
  select * into v_intent
  from public.payment_intents
  where id = new.payment_intent_id
  for update;

  if not found then
    raise exception 'Associated payment intent not found';
  end if;

  -- 1. Capture transaction validation
  if new.transaction_type = 'CAPTURE' then
    if new.parent_transaction_id is not null then
      raise exception 'Capture transaction must not have a parent transaction';
    end if;

    if new.currency <> v_intent.expected_currency then
      raise exception 'Capture currency % does not match intent expected currency %', new.currency, v_intent.expected_currency;
    end if;

    if new.amount_cents <> v_intent.expected_amount_cents then
      raise exception 'Capture amount % does not match intent expected amount %', new.amount_cents, v_intent.expected_amount_cents;
    end if;

    if new.payee_merchant_id <> v_intent.expected_merchant_id then
      raise exception 'Capture merchant ID % does not match expected merchant ID %', new.payee_merchant_id, v_intent.expected_merchant_id;
    end if;

    if v_intent.status not in ('CAPTURING', 'RECONCILING', 'COMPLETED') then
      raise exception 'Cannot record capture for intent in status %', v_intent.status;
    end if;

  -- 2. Refund / Reversal transaction validation
  elsif new.transaction_type in ('REFUND', 'REVERSAL') then
    if new.parent_transaction_id is null then
      raise exception 'Refund or reversal must reference a valid parent capture transaction';
    end if;

    -- Lock parent transaction to serialize concurrent refunds and prevent over-refunding
    select * into v_parent
    from public.payment_transactions
    where id = new.parent_transaction_id
    for update;

    if not found then
      raise exception 'Parent capture transaction not found';
    end if;

    if v_parent.transaction_type <> 'CAPTURE' then
      raise exception 'Parent transaction must be a CAPTURE transaction';
    end if;

    if v_parent.payment_intent_id <> new.payment_intent_id then
      raise exception 'Parent transaction belongs to a different payment intent';
    end if;

    if v_parent.status <> 'COMPLETED' then
      raise exception 'Cannot refund an uncompleted parent transaction';
    end if;

    if new.currency <> v_parent.currency then
      raise exception 'Refund currency does not match parent capture currency';
    end if;

    if new.payee_merchant_id <> v_parent.payee_merchant_id then
      raise exception 'Refund merchant ID does not match parent capture merchant ID';
    end if;

    -- Sum existing completed or pending refunds for this parent transaction
    select coalesce(sum(amount_cents), 0) into v_existing_refunds
    from public.payment_transactions
    where parent_transaction_id = v_parent.id
      and status in ('COMPLETED', 'PENDING');

    if (v_existing_refunds + new.amount_cents) > v_parent.amount_cents then
      raise exception 'Refund amount % exceeds remaining refundable capture balance % (captured: %, already refunded: %)',
        new.amount_cents, (v_parent.amount_cents - v_existing_refunds), v_parent.amount_cents, v_existing_refunds;
    end if;

  else
    raise exception 'Unsupported transaction type %', new.transaction_type;
  end if;

  return new;
end;
$$;

drop trigger if exists payment_transactions_validate_insert on public.payment_transactions;
create trigger payment_transactions_validate_insert
  before insert on public.payment_transactions
  for each row execute procedure public.validate_payment_transaction_insert();

-- Update client email protection trigger to cascade session/token invalidation
create or replace function public.protect_project_verified_client_email()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_owner_email text;
begin
  select email into v_owner_email from auth.users where id = new.owner_id;
  if v_owner_email is not null and lower(trim(new.client_email)) = lower(trim(v_owner_email)) then
    raise exception 'Client email cannot be identical to the project owner email';
  end if;

  if (old.client_email_verified_at is distinct from new.client_email_verified_at) then
    if current_setting('payroost.verification_active', true) is distinct from 'true' then
      raise exception 'Client email verification status cannot be updated directly';
    end if;
  end if;

  if (old.client_email is distinct from new.client_email) then
    new.client_email_verified_at := null;

    update public.review_links
    set revoked_at = now()
    where project_id = old.id and revoked_at is null;

    update public.client_email_verifications
    set consumed_at = now()
    where project_id = old.id and consumed_at is null;

    update public.review_link_otp_challenges
    set consumed_at = now()
    where project_id = old.id and consumed_at is null;

    -- Phase 3A: Invalidate all active portal tokens and sessions
    update public.client_portal_tokens
    set revoked_at = now()
    where project_id = old.id and revoked_at is null;

    update public.client_portal_sessions
    set revoked_at = now()
    where project_id = old.id and revoked_at is null;

    insert into public.activity_events (project_id, actor_label, event_type, summary)
    values (
      old.id,
      'System',
      'client_email.changed',
      'Client email changed to ' || new.client_email || '; verification, review links, and portal sessions invalidated.'
    );
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 4. PRIVILEGED DATABASE RPC FUNCTIONS (SECURITY DEFINER)
-- ============================================================================

-- Atomic RPC: Token issuance with superseded/expired token revocation
create or replace function public.create_client_portal_token(
  p_project_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_project public.projects%rowtype;
  new_token_id uuid;
begin
  -- Verify project exists and lock row
  select * into v_project from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'Project not found';
  end if;

  -- Ensure caller is project owner
  if auth.uid() is null or v_project.owner_id <> auth.uid() then
    raise exception 'Forbidden: Only the project owner can issue portal tokens';
  end if;

  -- Mandatory check: Client email must be verified
  if v_project.client_email_verified_at is null then
    raise exception 'Client email must be verified before issuing portal token';
  end if;

  -- Atomically revoke all existing active or expired unconsumed tokens for this project
  update public.client_portal_tokens
  set revoked_at = now()
  where project_id = p_project_id
    and revoked_at is null
    and consumed_at is null;

  insert into public.client_portal_tokens (
    project_id,
    token_hash,
    expires_at
  ) values (
    p_project_id,
    p_token_hash,
    p_expires_at
  ) returning id into new_token_id;

  return new_token_id;
end;
$$;

-- Atomic RPC: Create OTP Challenge for Client Portal Access
create or replace function public.create_portal_otp_challenge(
  p_portal_token_hash text,
  p_otp_hmac text,
  p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_token public.client_portal_tokens%rowtype;
  v_project public.projects%rowtype;
  v_challenge_id uuid;
begin
  select * into v_token
  from public.client_portal_tokens
  where token_hash = p_portal_token_hash
  for update;

  if not found or v_token.revoked_at is not null or v_token.consumed_at is not null or v_token.expires_at <= now() then
    raise exception 'Portal token is invalid, expired, or revoked';
  end if;

  select * into v_project
  from public.projects
  where id = v_token.project_id
  for update;

  if not found or v_project.client_email_verified_at is null then
    raise exception 'Project does not have a verified client email';
  end if;

  -- Invalidate prior unconsumed challenges for this token
  update public.client_portal_otp_challenges
  set consumed_at = now()
  where portal_token_id = v_token.id
    and consumed_at is null;

  insert into public.client_portal_otp_challenges (
    project_id,
    portal_token_id,
    client_email,
    otp_hmac,
    expires_at
  ) values (
    v_token.project_id,
    v_token.id,
    v_project.client_email,
    p_otp_hmac,
    p_expires_at
  ) returning id into v_challenge_id;

  return jsonb_build_object(
    'challengeId', v_challenge_id,
    'clientEmail', v_project.client_email,
    'projectTitle', v_project.title
  );
end;
$$;

-- Atomic RPC: Consume OTP and Create Session with Persistent Attempt Counting
-- Crucial invariant: Mismatched OTP increments attempt counter and COMMITS instead of rolling back.
create or replace function public.consume_portal_otp_and_create_session(
  p_challenge_id uuid,
  p_otp_hmac text,
  p_session_token_hash text,
  p_csrf_secret text,
  p_session_duration interval default interval '12 hours'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_challenge public.client_portal_otp_challenges%rowtype;
  v_project public.projects%rowtype;
  v_new_attempts integer;
  v_session_id uuid;
begin
  select * into v_challenge
  from public.client_portal_otp_challenges
  where id = p_challenge_id
  for update;

  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  if v_challenge.consumed_at is not null then
    return jsonb_build_object('status', 'ALREADY_CONSUMED');
  end if;

  if v_challenge.expires_at <= now() then
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  if v_challenge.attempts >= 5 then
    return jsonb_build_object('status', 'EXHAUSTED', 'attempts', v_challenge.attempts);
  end if;

  -- Increment attempt counter
  update public.client_portal_otp_challenges
  set attempts = attempts + 1
  where id = v_challenge.id
  returning attempts into v_new_attempts;

  -- Check HMAC mismatch without raising exception to guarantee attempt count commits
  if v_challenge.otp_hmac <> p_otp_hmac then
    if v_new_attempts >= 5 then
      return jsonb_build_object('status', 'EXHAUSTED', 'attempts', v_new_attempts);
    else
      return jsonb_build_object('status', 'INVALID_OTP', 'remainingAttempts', 5 - v_new_attempts, 'attempts', v_new_attempts);
    end if;
  end if;

  -- Re-verify project still has verified client email matching challenge
  select * into v_project
  from public.projects
  where id = v_challenge.project_id;

  if not found or v_project.client_email_verified_at is null or v_project.client_email <> v_challenge.client_email then
    return jsonb_build_object('status', 'CLIENT_EMAIL_CHANGED');
  end if;

  -- Mark challenge and portal token consumed atomically
  update public.client_portal_otp_challenges
  set consumed_at = now()
  where id = v_challenge.id;

  update public.client_portal_tokens
  set consumed_at = now()
  where id = v_challenge.portal_token_id;

  -- Issue active portal session
  insert into public.client_portal_sessions (
    project_id,
    client_email,
    session_token_hash,
    csrf_secret,
    expires_at
  ) values (
    v_challenge.project_id,
    v_challenge.client_email,
    p_session_token_hash,
    p_csrf_secret,
    now() + p_session_duration
  ) returning id into v_session_id;

  return jsonb_build_object(
    'status', 'SUCCESS',
    'sessionId', v_session_id,
    'projectId', v_challenge.project_id,
    'clientEmail', v_challenge.client_email
  );
end;
$$;

-- Atomic RPC: Validate Portal Session with Idle and Absolute Timeout
create or replace function public.validate_portal_session(
  p_session_token_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_project public.projects%rowtype;
begin
  select * into v_session
  from public.client_portal_sessions
  where session_token_hash = p_session_token_hash
  for update;

  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('valid', false, 'reason', 'REVOKED_OR_NOT_FOUND');
  end if;

  -- Absolute expiration check (12 hours)
  if now() >= v_session.expires_at then
    return jsonb_build_object('valid', false, 'reason', 'ABSOLUTE_EXPIRY');
  end if;

  -- Idle expiration check (60 minutes)
  if now() >= v_session.last_active_at + interval '60 minutes' then
    return jsonb_build_object('valid', false, 'reason', 'IDLE_TIMEOUT');
  end if;

  -- Verified client email check
  select * into v_project from public.projects where id = v_session.project_id;
  if not found or v_project.client_email_verified_at is null or v_project.client_email <> v_session.client_email then
    return jsonb_build_object('valid', false, 'reason', 'CLIENT_EMAIL_CHANGED');
  end if;

  -- Renew last active timestamp
  update public.client_portal_sessions
  set last_active_at = now()
  where id = v_session.id;

  return jsonb_build_object(
    'valid', true,
    'sessionId', v_session.id,
    'projectId', v_session.project_id,
    'clientEmail', v_session.client_email,
    'csrfSecret', v_session.csrf_secret
  );
end;
$$;

-- Privileged RPC: Create Payment Intent with Strict Milestone Verification
create or replace function public.create_payment_intent(
  p_milestone_id uuid,
  p_expected_merchant_id text,
  p_order_idempotency_key uuid,
  p_capture_idempotency_key uuid,
  p_canonical_payload jsonb,
  p_is_sandbox_demo boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_milestone public.milestones%rowtype;
  v_project public.projects%rowtype;
  v_agreement_version public.agreement_versions%rowtype;
  v_canonical_amount text;
  v_intent_id uuid;
begin
  -- Lock milestone
  select * into v_milestone from public.milestones where id = p_milestone_id for update;
  if not found then
    raise exception 'Milestone not found';
  end if;

  -- Lock project
  select * into v_project from public.projects where id = v_milestone.project_id for update;
  if not found then
    raise exception 'Project not found';
  end if;

  -- Authorization check
  if p_is_sandbox_demo then
    if auth.uid() is null or v_project.owner_id <> auth.uid() then
      raise exception 'Forbidden: Only the project owner can create sandbox demo payment intents';
    end if;
  end if;

  -- Check milestone payable status
  if v_milestone.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED') then
    raise exception 'Milestone status % is not payable; must be APPROVED, IN_PROGRESS, or SUBMITTED', v_milestone.status;
  end if;

  -- Lock and verify approved agreement version
  select * into v_agreement_version from public.agreement_versions where id = v_milestone.agreement_version_id for update;
  if not found or v_agreement_version.status <> 'APPROVED' then
    raise exception 'Milestone does not belong to an approved agreement version';
  end if;

  -- USD only in Phase 3A
  if v_milestone.currency <> 'USD' then
    raise exception 'Currency % is unsupported; only USD is accepted in Phase 3A', v_milestone.currency;
  end if;

  if v_milestone.amount_minor <= 0 then
    raise exception 'Milestone amount must be strictly positive';
  end if;

  if char_length(trim(p_expected_merchant_id)) < 3 or char_length(trim(p_expected_merchant_id)) > 64 then
    raise exception 'Invalid expected merchant ID';
  end if;

  -- Derive canonical USD amount string from authoritative milestone integer cents
  v_canonical_amount := (v_milestone.amount_minor / 100)::text || '.' || lpad((v_milestone.amount_minor % 100)::text, 2, '0');

  insert into public.payment_intents (
    project_id,
    milestone_id,
    agreement_version_id,
    environment,
    is_sandbox_demo,
    status,
    expected_merchant_id,
    expected_currency,
    expected_amount_canonical,
    expected_amount_cents,
    provider,
    order_idempotency_key,
    capture_idempotency_key,
    canonical_payload_json,
    order_creation_lease_expires_at
  ) values (
    v_project.id,
    v_milestone.id,
    v_agreement_version.id,
    'SANDBOX',
    p_is_sandbox_demo,
    'ORDER_CREATING',
    trim(p_expected_merchant_id),
    'USD',
    v_canonical_amount,
    v_milestone.amount_minor,
    'PAYPAL',
    p_order_idempotency_key,
    p_capture_idempotency_key,
    p_canonical_payload,
    now() + interval '30 seconds'
  ) returning id into v_intent_id;

  return v_intent_id;
end;
$$;

-- Privileged Server RPC: Record Completed Payment Capture
create or replace function public.record_payment_intent_completed(
  p_intent_id uuid,
  p_provider_capture_id text,
  p_amount_cents bigint,
  p_payee_merchant_id text,
  p_raw_response jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
begin
  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if not found then
    raise exception 'Payment intent not found';
  end if;

  if v_intent.status not in ('CAPTURING', 'RECONCILING') then
    raise exception 'Cannot record completion for intent in status %', v_intent.status;
  end if;

  if p_amount_cents <> v_intent.expected_amount_cents then
    raise exception 'Capture amount % does not match expected intent amount %', p_amount_cents, v_intent.expected_amount_cents;
  end if;

  if trim(p_payee_merchant_id) <> v_intent.expected_merchant_id then
    raise exception 'Capture merchant ID % does not match expected merchant ID %', p_payee_merchant_id, v_intent.expected_merchant_id;
  end if;

  -- 1. Insert verified capture transaction into ledger
  insert into public.payment_transactions (
    payment_intent_id,
    transaction_type,
    provider,
    provider_reference_id,
    status,
    amount_cents,
    currency,
    payee_merchant_id,
    raw_response
  ) values (
    p_intent_id,
    'CAPTURE',
    'PAYPAL',
    trim(p_provider_capture_id),
    'COMPLETED',
    p_amount_cents,
    'USD',
    trim(p_payee_merchant_id),
    p_raw_response
  );

  -- 2. Transition payment intent to COMPLETED
  update public.payment_intents
  set status = 'COMPLETED',
      completed_at = now(),
      capture_lease_expires_at = null
  where id = p_intent_id;

  -- 3. Record audit activity event
  insert into public.activity_events (project_id, actor_label, event_type, summary)
  values (
    v_intent.project_id,
    'System',
    'milestone.payment_completed',
    'Payment of $' || v_intent.expected_amount_canonical || ' completed for milestone'
  );

  return true;
end;
$$;

-- Privileged Server RPC: Process Refund Transaction with Over-Refund Guard
create or replace function public.process_refund_transaction(
  p_payment_intent_id uuid,
  p_parent_capture_id uuid,
  p_refund_reference_id text,
  p_amount_cents bigint,
  p_raw_response jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_parent public.payment_transactions%rowtype;
  v_refund_id uuid;
begin
  select * into v_parent from public.payment_transactions where id = p_parent_capture_id for update;
  if not found then
    raise exception 'Parent capture transaction not found';
  end if;

  insert into public.payment_transactions (
    payment_intent_id,
    parent_transaction_id,
    transaction_type,
    provider,
    provider_reference_id,
    status,
    amount_cents,
    currency,
    payee_merchant_id,
    raw_response
  ) values (
    p_payment_intent_id,
    p_parent_capture_id,
    'REFUND',
    'PAYPAL',
    trim(p_refund_reference_id),
    'COMPLETED',
    p_amount_cents,
    v_parent.currency,
    v_parent.payee_merchant_id,
    p_raw_response
  ) returning id into v_refund_id;

  return v_refund_id;
end;
$$;

-- ============================================================================
-- 5. ROW LEVEL SECURITY AND PERMISSIONS MATRIX
-- ============================================================================

alter table public.client_portal_tokens enable row level security;
alter table public.client_portal_otp_challenges enable row level security;
alter table public.client_portal_sessions enable row level security;
alter table public.payment_intents enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.provider_webhook_events enable row level security;

-- Portal tokens, challenges, sessions, and webhooks: No direct access from client roles
revoke all on public.client_portal_tokens from public, anon, authenticated;
revoke all on public.client_portal_otp_challenges from public, anon, authenticated;
revoke all on public.client_portal_sessions from public, anon, authenticated;
revoke all on public.provider_webhook_events from public, anon, authenticated;

-- Payment intents and transactions: SELECT allowed for project members only; mutations revoked
revoke all on public.payment_intents from public, anon;
revoke insert, update, delete, truncate on public.payment_intents from authenticated;
grant select on public.payment_intents to authenticated;

create policy "payment_intents_member_read" on public.payment_intents
  for select to authenticated using (public.is_project_member(project_id));

revoke all on public.payment_transactions from public, anon;
revoke insert, update, delete, truncate on public.payment_transactions from authenticated;
grant select on public.payment_transactions to authenticated;

create policy "payment_transactions_member_read" on public.payment_transactions
  for select to authenticated using (
    exists (
      select 1 from public.payment_intents pi
      where pi.id = payment_intent_id
        and public.is_project_member(pi.project_id)
    )
  );

-- Privileged RPC Function Grants
revoke all on function public.create_client_portal_token(uuid, text, timestamptz) from public, anon;
grant execute on function public.create_client_portal_token(uuid, text, timestamptz) to authenticated;

revoke all on function public.create_portal_otp_challenge(text, text, timestamptz) from public;
grant execute on function public.create_portal_otp_challenge(text, text, timestamptz) to anon, authenticated;

revoke all on function public.consume_portal_otp_and_create_session(uuid, text, text, text, interval) from public;
grant execute on function public.consume_portal_otp_and_create_session(uuid, text, text, text, interval) to anon, authenticated;

revoke all on function public.validate_portal_session(text) from public;
grant execute on function public.validate_portal_session(text) to anon, authenticated;

revoke all on function public.create_payment_intent(uuid, text, uuid, uuid, jsonb, boolean) from public;
grant execute on function public.create_payment_intent(uuid, text, uuid, uuid, jsonb, boolean) to anon, authenticated;

-- Service-Role-Only Privileged Functions (strictly revoked from browser/client roles)
revoke all on function public.record_payment_intent_completed(uuid, text, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.process_refund_transaction(uuid, uuid, text, bigint, jsonb) from public, anon, authenticated;
