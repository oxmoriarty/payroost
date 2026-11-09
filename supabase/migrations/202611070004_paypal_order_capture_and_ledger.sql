-- PayRoost Phase 3B.4.2: Server-Side PayPal Order Capture and Ledger Integration
--
-- Objectives:
-- 1. Schema Extensions: Add capture_lease_token (UUID fencing token) to payment_intents.
-- 2. Trigger Hardening:
--    - protect_payment_intent_immutability(): Permits ORDER_CREATED -> CAPTURING and BUYER_APPROVED -> CAPTURING.
--      Permits CAPTURING -> COMPLETED, RECONCILING, RECONCILIATION_REQUIRED, FAILED, and ORDER_CREATED (lease release).
--      Maintains strict dual-layer authorization for RECONCILIATION_REQUIRED transitions.
--    - protect_milestone_payment_invariants(): Ensures milestones associated with COMPLETED payment intents
--      cannot be deleted or have their financial attributes modified.
-- 3. claim_order_capture_lease:
--    - Atomically locks payment intent FOR UPDATE.
--    - Validates client portal session, expiration, and strict project binding.
--    - Validates matching provider_order_id.
--    - Safe idempotency fast-path if intent is already COMPLETED with a verified capture in payment_transactions.
--    - Validates intent status is in ('ORDER_CREATED', 'BUYER_APPROVED').
--    - Locks milestone FOR SHARE and validates payable status ('APPROVED', 'IN_PROGRESS', 'SUBMITTED') and USD currency.
--    - Checks active capture lease to prevent concurrent execution (LEASE_ACTIVE).
--    - Generates fresh cryptographically random capture_lease_token.
--    - Sets intent status to 'CAPTURING', sets lease expiry and token.
--    - Records 'payment.capture_initiated' activity event.
-- 4. release_order_capture_lease:
--    - Fenced lease release. Validates session/project binding and asserts caller holds active capture_lease_token.
--    - Safely reverts status from CAPTURING back to ORDER_CREATED (or BUYER_APPROVED) and clears lease attributes.
-- 5. record_paypal_order_captured:
--    - Atomically records verified capture in payment_transactions and completes intent and milestone.
--    - Fenced by capture_lease_token.
--    - Validates session/project binding and strict financial/merchant invariants.
--    - Idempotency guard: returns existing capture if already recorded.
--    - For COMPLETED status: inserts capture ledger entry, sets intent status = 'COMPLETED', sets milestone status = 'ACCEPTED',
--      clears capture lease, and records 'payment.order_captured' audit event.
--    - For PENDING status: inserts capture ledger entry with status 'PENDING', moves intent to 'RECONCILIATION_REQUIRED',
--      keeps milestone locked, and records 'payment.capture_pending' audit event.
--    - For DECLINED/FAILED status: updates intent to 'FAILED', clears lease, and records 'payment.capture_failed'.
-- 6. mark_intent_capture_reconciliation_required:
--    - Fenced transition to RECONCILIATION_REQUIRED for in-flight capture workers on ambiguous provider outcomes (timeouts, 5xx).
-- 7. Privilege Lockdown:
--    - All functions configured with SECURITY DEFINER and search_path = ''.
--    - Executable strictly by service_role.

-- ============================================================================
-- 1. SCHEMA EXTENSIONS
-- ============================================================================

alter table public.payment_intents
  add column if not exists capture_lease_token uuid;

-- ============================================================================
-- 2. HARDENED PAYMENT INTENT IMMUTABILITY & TRANSITION TRIGGER
-- ============================================================================

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

    -- Ambiguous state cannot transition automatically unless authorized privileged reconciliation is active
    if old.status = 'RECONCILIATION_REQUIRED' then
      -- Dual-Layer Check: Session user must be a trusted service role or superuser
      if session_user not in ('service_role', 'postgres', 'supabase_admin') then
        raise exception 'Unauthorized: Only service_role can perform reconciliation transitions';
      end if;

      -- Transaction-local privileged execution check
      if current_setting('payroost.reconciliation_active', true) is distinct from 'true' then
        raise exception 'Payment intent in RECONCILIATION_REQUIRED cannot transition without privileged intervention';
      end if;

      -- Allowed transitions: COMPLETED (captured), FAILED/CANCELLED (verified inactive), or ORDER_CREATED (ghost order recovered)
      if new.status not in ('COMPLETED', 'FAILED', 'CANCELLED', 'ORDER_CREATED') then
        raise exception 'Payment intent in RECONCILIATION_REQUIRED can only transition to COMPLETED, FAILED, CANCELLED, or ORDER_CREATED via privileged reconciliation';
      end if;
    end if;

    -- Valid state transitions
    if old.status = 'ORDER_CREATING' and new.status not in ('ORDER_CREATED', 'FAILED', 'RECONCILIATION_REQUIRED') then
      raise exception 'Invalid transition from ORDER_CREATING to %', new.status;
    elsif old.status = 'ORDER_CREATED' and new.status not in ('BUYER_APPROVED', 'CAPTURING', 'CANCELLED') then
      raise exception 'Invalid transition from ORDER_CREATED to %', new.status;
    elsif old.status = 'BUYER_APPROVED' and new.status not in ('CAPTURING', 'CANCELLED') then
      raise exception 'Invalid transition from BUYER_APPROVED to %', new.status;
    elsif old.status = 'CAPTURING' and new.status not in ('COMPLETED', 'RECONCILING', 'RECONCILIATION_REQUIRED', 'FAILED', 'ORDER_CREATED', 'BUYER_APPROVED') then
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

-- ============================================================================
-- 3. HARDENED MILESTONE PAYMENT COORDINATION TRIGGER
-- ============================================================================

create or replace function public.protect_milestone_payment_invariants()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_active_intent_count integer;
  v_completed_intent_count integer;
begin
  if tg_op = 'DELETE' then
    -- Check active intents or leases
    select count(*) into v_active_intent_count
    from public.payment_intents
    where milestone_id = old.id
      and (
        status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')
        or (status = 'ORDER_CREATING' and order_creation_lease_expires_at is not null and order_creation_lease_expires_at > clock_timestamp())
        or (status = 'CAPTURING' and capture_lease_expires_at is not null and capture_lease_expires_at > clock_timestamp())
      );

    if v_active_intent_count > 0 then
      raise exception 'Milestone % cannot be deleted while an active payment intent, reconciliation, or lease exists', old.id;
    end if;

    -- Check completed intent
    select count(*) into v_completed_intent_count
    from public.payment_intents
    where milestone_id = old.id
      and status = 'COMPLETED';

    if v_completed_intent_count > 0 then
      raise exception 'Milestone % cannot be deleted because it has a completed payment', old.id;
    end if;

    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Check if status or financial terms are being modified
    if (old.status is distinct from new.status) or
       (old.amount_minor is distinct from new.amount_minor) or
       (old.currency is distinct from new.currency) then

      -- Check active intent count
      select count(*) into v_active_intent_count
      from public.payment_intents
      where milestone_id = old.id
        and (
          status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')
          or (status = 'ORDER_CREATING' and order_creation_lease_expires_at is not null and order_creation_lease_expires_at > clock_timestamp())
          or (status = 'CAPTURING' and capture_lease_expires_at is not null and capture_lease_expires_at > clock_timestamp())
        );

      if v_active_intent_count > 0 then
        -- Allow milestone completion (ACCEPTED) during valid payment capture
        if new.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED') then
          raise exception 'Milestone % cannot be cancelled or moved to non-payable status % while an active payment operation, reconciliation, or lease is in progress', old.id, new.status;
        end if;

        if (old.amount_minor is distinct from new.amount_minor) or (old.currency is distinct from new.currency) then
          raise exception 'Milestone % financial attributes (amount/currency) cannot be modified while an active payment operation, reconciliation, or lease is in progress', old.id;
        end if;
      end if;

      -- Check completed intent count
      select count(*) into v_completed_intent_count
      from public.payment_intents
      where milestone_id = old.id
        and status = 'COMPLETED';

      if v_completed_intent_count > 0 then
        if (old.amount_minor is distinct from new.amount_minor) or (old.currency is distinct from new.currency) then
          raise exception 'Milestone % financial attributes cannot be modified after payment completion', old.id;
        end if;
        if new.status = 'CANCELLED' then
          raise exception 'Milestone % cannot be cancelled after payment completion', old.id;
        end if;
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 4. ATOMICALLY CLAIM ORDER CAPTURE LEASE WITH FENCING TOKEN
-- ============================================================================

create or replace function public.claim_order_capture_lease(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_provider_order_id text,
  p_lease_seconds integer default 45
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_milestone public.milestones%rowtype;
  v_clean_order_id text;
  v_lease_token uuid;
  v_existing_capture public.payment_transactions%rowtype;
begin
  -- Validate mandatory arguments
  if p_session_token_hash is null or p_payment_intent_id is null or p_provider_order_id is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_order_id := trim(p_provider_order_id);
  if char_length(v_clean_order_id) = 0 then
    return jsonb_build_object('success', false, 'error', 'INVALID_ORDER_ID');
  end if;

  -- 1. Lock and validate payment intent
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 2. Lock and validate client portal session
  select * into v_session
  from public.client_portal_sessions
  where session_token_hash = p_session_token_hash
  for update;

  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED_SESSION');
  end if;

  if now() >= v_session.expires_at or now() >= v_session.last_active_at + interval '60 minutes' then
    return jsonb_build_object('success', false, 'error', 'SESSION_EXPIRED');
  end if;

  -- 3. Assert strict project binding
  if v_session.project_id <> v_intent.project_id then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN_PROJECT_MISMATCH');
  end if;

  -- 4. Verify matching provider_order_id
  if v_intent.provider_order_id is null or v_intent.provider_order_id <> v_clean_order_id then
    return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISMATCH');
  end if;

  -- 5. Safe idempotency fast-path: if intent is already COMPLETED
  if v_intent.status = 'COMPLETED' then
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and transaction_type = 'CAPTURE'
      and status = 'COMPLETED'
    limit 1;

    return jsonb_build_object(
      'success', true,
      'already_completed', true,
      'payment_intent_id', v_intent.id,
      'provider_order_id', v_intent.provider_order_id,
      'provider_capture_id', v_existing_capture.provider_reference_id,
      'status', 'COMPLETED'
    );
  end if;

  -- 6. Check eligibility: must be in ORDER_CREATED or BUYER_APPROVED
  if v_intent.status = 'RECONCILIATION_REQUIRED' then
    return jsonb_build_object(
      'success', false,
      'error', 'RECONCILIATION_REQUIRED',
      'status', v_intent.status
    );
  end if;

  if v_intent.status in ('FAILED', 'CANCELLED') then
    return jsonb_build_object(
      'success', false,
      'error', 'TERMINAL_STATE',
      'status', v_intent.status
    );
  end if;

  if v_intent.status not in ('ORDER_CREATED', 'BUYER_APPROVED') then
    -- If already in CAPTURING, check if current lease is still active
    if v_intent.status = 'CAPTURING' and v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > now() then
      return jsonb_build_object(
        'success', false,
        'error', 'LEASE_ACTIVE',
        'lease_expires_at', v_intent.capture_lease_expires_at
      );
    end if;

    if v_intent.status <> 'CAPTURING' then
      return jsonb_build_object(
        'success', false,
        'error', 'INELIGIBLE_STATUS',
        'status', v_intent.status
      );
    end if;
  end if;

  -- 7. Lock and validate milestone payable status
  select * into v_milestone
  from public.milestones
  where id = v_intent.milestone_id
  for share;

  if not found then
    return jsonb_build_object('success', false, 'error', 'MILESTONE_NOT_FOUND');
  end if;

  if v_milestone.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED') then
    return jsonb_build_object(
      'success', false,
      'error', 'MILESTONE_NOT_PAYABLE',
      'milestone_status', v_milestone.status
    );
  end if;

  if v_milestone.currency <> 'USD' then
    return jsonb_build_object('success', false, 'error', 'UNSUPPORTED_CURRENCY');
  end if;

  -- 8. Concurrency check: check if an active capture lease exists
  if v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > now() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_expires_at', v_intent.capture_lease_expires_at
    );
  end if;

  -- 9. Generate fresh cryptographically random lease fencing token
  v_lease_token := gen_random_uuid();

  -- 10. Update intent to CAPTURING, set lease expiry and fencing token
  update public.payment_intents
  set status = 'CAPTURING',
      capture_lease_expires_at = now() + (greatest(10, least(p_lease_seconds, 120)) || ' seconds')::interval,
      capture_lease_token = v_lease_token,
      updated_at = now()
  where id = v_intent.id;

  -- Renew session activity
  update public.client_portal_sessions
  set last_active_at = now()
  where id = v_session.id;

  -- Record audit event
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    'Client',
    'payment.capture_initiated',
    'Payment capture initiated for milestone',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'providerOrderId', v_clean_order_id
    )
  );

  return jsonb_build_object(
    'success', true,
    'claimed', true,
    'lease_token', v_lease_token,
    'payment_intent_id', v_intent.id,
    'milestone_id', v_intent.milestone_id,
    'project_id', v_intent.project_id,
    'provider_order_id', v_clean_order_id,
    'expected_merchant_id', v_intent.expected_merchant_id,
    'expected_amount_cents', v_intent.expected_amount_cents,
    'expected_amount_canonical', v_intent.expected_amount_canonical,
    'capture_idempotency_key', v_intent.capture_idempotency_key
  );
end;
$$;

revoke all on function public.claim_order_capture_lease(text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_order_capture_lease(text, uuid, text, integer) to service_role;

-- ============================================================================
-- 5. FENCED RELEASE OF ORDER CAPTURE LEASE
-- ============================================================================

create or replace function public.release_order_capture_lease(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_token uuid,
  p_target_status text default 'ORDER_CREATED'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_safe_target text;
begin
  if p_session_token_hash is null or p_payment_intent_id is null or p_lease_token is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  select * into v_session
  from public.client_portal_sessions
  where session_token_hash = p_session_token_hash
  for update;

  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED_SESSION');
  end if;

  if v_session.project_id <> v_intent.project_id then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN_PROJECT_MISMATCH');
  end if;

  -- Assert caller holds active fencing token
  if v_intent.capture_lease_token is distinct from p_lease_token then
    return jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'STALE_LEASE_TOKEN'
    );
  end if;

  v_safe_target := coalesce(p_target_status, 'ORDER_CREATED');
  if v_safe_target not in ('ORDER_CREATED', 'BUYER_APPROVED') then
    v_safe_target := 'ORDER_CREATED';
  end if;

  if v_intent.status = 'CAPTURING' then
    update public.payment_intents
    set status = v_safe_target,
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    return jsonb_build_object('success', true, 'released', true, 'status', v_safe_target);
  end if;

  return jsonb_build_object('success', true, 'released', false, 'status', v_intent.status);
end;
$$;

revoke all on function public.release_order_capture_lease(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.release_order_capture_lease(text, uuid, uuid, text) to service_role;

-- ============================================================================
-- 6. FENCED ATOMIC RECORDING OF CAPTURE AND COMPLETION
-- ============================================================================

create or replace function public.record_paypal_order_captured(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_token uuid,
  p_provider_capture_id text,
  p_capture_status text,
  p_amount_cents bigint,
  p_payee_merchant_id text,
  p_raw_capture_response jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_milestone public.milestones%rowtype;
  v_clean_capture_id text;
  v_clean_status text;
  v_existing_capture public.payment_transactions%rowtype;
begin
  if p_session_token_hash is null or p_payment_intent_id is null or p_lease_token is null or
     p_provider_capture_id is null or p_capture_status is null or p_amount_cents is null or
     p_payee_merchant_id is null or p_raw_capture_response is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_capture_id := trim(p_provider_capture_id);
  if char_length(v_clean_capture_id) < 1 or char_length(v_clean_capture_id) > 64 then
    return jsonb_build_object('success', false, 'error', 'INVALID_CAPTURE_ID');
  end if;

  v_clean_status := upper(trim(p_capture_status));
  if v_clean_status not in ('COMPLETED', 'PENDING', 'FAILED', 'DECLINED') then
    return jsonb_build_object('success', false, 'error', 'UNSUPPORTED_CAPTURE_STATUS');
  end if;

  -- 1. Lock payment intent
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 2. Lock session
  select * into v_session
  from public.client_portal_sessions
  where session_token_hash = p_session_token_hash
  for update;

  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED_SESSION');
  end if;

  -- 3. Assert project binding
  if v_session.project_id <> v_intent.project_id then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN_PROJECT_MISMATCH');
  end if;

  -- 4. Idempotent check: if already COMPLETED with this exact capture ID
  if v_intent.status = 'COMPLETED' then
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and provider_reference_id = v_clean_capture_id
      and transaction_type = 'CAPTURE'
      and status = 'COMPLETED'
    limit 1;

    if found then
      return jsonb_build_object(
        'success', true,
        'already_recorded', true,
        'payment_intent_id', v_intent.id,
        'capture_id', v_clean_capture_id,
        'status', 'COMPLETED'
      );
    else
      return jsonb_build_object('success', false, 'error', 'COMPLETED_WITH_DIFFERENT_CAPTURE');
    end if;
  end if;

  -- 5. Fencing token validation: caller must strictly hold active capture lease
  if v_intent.capture_lease_token is distinct from p_lease_token then
    return jsonb_build_object('success', false, 'error', 'STALE_LEASE_TOKEN');
  end if;

  -- 6. Status check: must be in CAPTURING
  if v_intent.status <> 'CAPTURING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- 7. Check global uniqueness of capture ID across all payment intents
  if exists (
    select 1 from public.payment_transactions
    where provider_reference_id = v_clean_capture_id
      and payment_intent_id <> v_intent.id
  ) then
    return jsonb_build_object('success', false, 'error', 'DUPLICATE_CAPTURE_ID');
  end if;

  -- 8. Financial and Merchant Verification
  if p_amount_cents <> v_intent.expected_amount_cents then
    return jsonb_build_object(
      'success', false,
      'error', 'AMOUNT_MISMATCH',
      'expected_amount_cents', v_intent.expected_amount_cents,
      'received_amount_cents', p_amount_cents
    );
  end if;

  if trim(p_payee_merchant_id) <> v_intent.expected_merchant_id then
    return jsonb_build_object(
      'success', false,
      'error', 'MERCHANT_MISMATCH',
      'expected_merchant_id', v_intent.expected_merchant_id,
      'received_merchant_id', trim(p_payee_merchant_id)
    );
  end if;

  -- 9. Handle COMPLETED capture
  if v_clean_status = 'COMPLETED' then
    -- A. Insert verified capture into append-only payment ledger
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
      v_intent.id,
      'CAPTURE',
      'PAYPAL',
      v_clean_capture_id,
      'COMPLETED',
      p_amount_cents,
      'USD',
      trim(p_payee_merchant_id),
      p_raw_capture_response
    );

    -- B. Atomically mark payment intent COMPLETED
    update public.payment_intents
    set status = 'COMPLETED',
        completed_at = now(),
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    -- C. Atomically mark milestone ACCEPTED
    update public.milestones
    set status = 'ACCEPTED',
        updated_at = now()
    where id = v_intent.milestone_id;

    -- D. Record audit activity event
    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.order_captured',
      'Payment of $' || v_intent.expected_amount_canonical || ' captured and completed for milestone',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id,
        'amountCents', p_amount_cents
      )
    );

    -- Renew session activity
    update public.client_portal_sessions
    set last_active_at = now()
    where id = v_session.id;

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'milestone_id', v_intent.milestone_id,
      'capture_id', v_clean_capture_id,
      'status', 'COMPLETED'
    );

  -- 10. Handle PENDING capture
  elsif v_clean_status = 'PENDING' then
    -- Record PENDING in payment ledger
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
      v_intent.id,
      'CAPTURE',
      'PAYPAL',
      v_clean_capture_id,
      'PENDING',
      p_amount_cents,
      'USD',
      trim(p_payee_merchant_id),
      p_raw_capture_response
    );

    -- Intent moves to RECONCILIATION_REQUIRED, milestone is NOT accepted
    update public.payment_intents
    set status = 'RECONCILIATION_REQUIRED',
        reconciliation_reason = 'PAYPAL_CAPTURE_PENDING',
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.capture_pending',
      'Payment capture of $' || v_intent.expected_amount_canonical || ' is pending provider settlement',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id
      )
    );

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'capture_id', v_clean_capture_id,
      'status', 'PENDING',
      'reconciliation_required', true
    );

  -- 11. Handle DECLINED / FAILED capture
  else
    update public.payment_intents
    set status = 'FAILED',
        reconciliation_reason = 'PAYPAL_CAPTURE_DECLINED',
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.capture_failed',
      'Payment capture was declined or failed at provider',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id
      )
    );

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'capture_id', v_clean_capture_id,
      'status', 'FAILED'
    );
  end if;
end;
$$;

revoke all on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) to service_role;

-- ============================================================================
-- 7. FENCED mark_intent_capture_reconciliation_required (FOR IN-FLIGHT CAPTURE WORKERS)
-- ============================================================================

create or replace function public.mark_intent_capture_reconciliation_required(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_token uuid,
  p_reason_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_sanitized_reason text;
begin
  if p_session_token_hash is null or p_payment_intent_id is null or p_lease_token is null or p_reason_code is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  select * into v_session
  from public.client_portal_sessions
  where session_token_hash = p_session_token_hash
  for update;

  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED_SESSION');
  end if;

  if v_session.project_id <> v_intent.project_id then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN_PROJECT_MISMATCH');
  end if;

  -- Never downgrade protected terminal or successful states
  if v_intent.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- Fencing validation
  if v_intent.capture_lease_token is distinct from p_lease_token then
    return jsonb_build_object('success', false, 'error', 'STALE_LEASE_TOKEN');
  end if;

  -- Must be in CAPTURING state
  if v_intent.status <> 'CAPTURING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- Controlled sanitization of reason code (uppercase alphanumeric and underscores)
  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);

  update public.payment_intents
  set status = 'RECONCILIATION_REQUIRED',
      reconciliation_reason = v_sanitized_reason,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    'System',
    'payment.capture_reconciliation_required',
    'Capture outcome ambiguous; payment intent escalated to reconciliation required',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'reasonCode', v_sanitized_reason
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'status', 'RECONCILIATION_REQUIRED',
    'reason_code', v_sanitized_reason
  );
end;
$$;

revoke all on function public.mark_intent_capture_reconciliation_required(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_intent_capture_reconciliation_required(text, uuid, uuid, text) to service_role;
