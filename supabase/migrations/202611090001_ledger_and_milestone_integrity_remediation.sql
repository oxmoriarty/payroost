-- PayRoost Phase 3B.4.2.2: Critical Ledger and Milestone Integrity Remediation
--
-- Remediates:
-- 1. F-01 (CRITICAL): Pending-to-completed capture ledger deadlock.
--    - Hardens prevent_payment_transactions_mutation() to disallow DELETE unconditionally.
--    - Allows UPDATE on payment_transactions ONLY for CAPTURE status transition from PENDING to COMPLETED.
--    - Enforces dual-layer authorization: session_user in ('service_role', 'postgres', 'supabase_admin')
--      AND current_setting('payroost.ledger_mutation_authorized', true) = 'true'.
--    - Enforces immutability of id, payment_intent_id, parent_transaction_id, transaction_type,
--      provider, provider_reference_id, amount_cents, currency, payee_merchant_id, and created_at.
--    - Updates record_paypal_order_captured() and reconcile_and_complete_payment_intent() to detect
--      existing PENDING capture transactions and perform authorized in-place transition to COMPLETED.
--
-- 2. F-02 (HIGH): Milestones can be marked ACCEPTED without a completed payment.
--    - Hardens protect_milestone_payment_invariants() to enforce that transition to ACCEPTED
--      is strictly prohibited unless an authoritative COMPLETED payment intent exists for the milestone.
--    - Prevents milestone modification away from ACCEPTED or cancellation after payment completion.
--    - In record_paypal_order_captured() and reconcile_and_complete_payment_intent(), payment_intents
--      is updated to COMPLETED before milestones is updated to ACCEPTED, satisfying the trigger invariant.
--
-- 3. F-04 (MEDIUM): Expired CAPTURING intents are excluded from automated reconciliation.
--    - Hardens reconcile_and_complete_payment_intent(), admin_mark_intent_reconciliation_required(),
--      admin_recover_and_bind_paypal_order(), and admin_resolve_reconciliation_without_payment()
--      to accept expired CAPTURING intents alongside RECONCILIATION_REQUIRED.
--    - Ensures dual lease checking (order_creation_lease and capture_lease) to protect active workers.

-- ============================================================================
-- 1. HARDENED PAYMENT TRANSACTIONS IMMUTABILITY TRIGGER (F-01)
-- ============================================================================

create or replace function public.prevent_payment_transactions_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Financial transaction ledger is strictly append-only and records cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    -- Dual-Layer Check 1: Session user must be a trusted service role or superuser
    if session_user not in ('service_role', 'postgres', 'supabase_admin') then
      raise exception 'Unauthorized: Only service_role can update payment transactions';
    end if;

    -- Dual-Layer Check 2: Transaction-local privileged execution flag
    if current_setting('payroost.ledger_mutation_authorized', true) is distinct from 'true' then
      raise exception 'Financial transaction ledger is strictly append-only; update not authorized';
    end if;

    -- Only CAPTURE transactions can transition from PENDING to COMPLETED
    if old.transaction_type <> 'CAPTURE' then
      raise exception 'Only CAPTURE transactions can be updated from PENDING to COMPLETED';
    end if;

    -- Only PENDING to COMPLETED status transition is permitted
    if old.status <> 'PENDING' or new.status <> 'COMPLETED' then
      raise exception 'Invalid status transition on payment transaction: % to %; only PENDING to COMPLETED is permitted',
        old.status, new.status;
    end if;

    -- Assert strict immutability of financial, relational, and identity attributes
    if (old.id <> new.id or
        old.payment_intent_id <> new.payment_intent_id or
        (old.parent_transaction_id is distinct from new.parent_transaction_id) or
        old.transaction_type <> new.transaction_type or
        old.provider <> new.provider or
        old.provider_reference_id <> new.provider_reference_id or
        old.amount_cents <> new.amount_cents or
        old.currency <> new.currency or
        old.payee_merchant_id <> new.payee_merchant_id or
        old.created_at <> new.created_at) then
      raise exception 'Payment transaction immutable financial, relational, and identity attributes cannot be modified';
    end if;

    -- Allow update of status, raw_response, and captured_at
    new.captured_at := coalesce(new.captured_at, now());
    return new;
  end if;

  return null;
end;
$$;

-- ============================================================================
-- 2. HARDENED MILESTONE PAYMENT INVARIANTS TRIGGER (F-02)
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

      -- 1. Enforce payment precondition for ACCEPTED status (Finding F-02):
      -- A milestone cannot transition to ACCEPTED without a verified COMPLETED payment intent in the database.
      if new.status = 'ACCEPTED' and old.status is distinct from 'ACCEPTED' then
        if not exists (
          select 1 from public.payment_intents
          where milestone_id = new.id
            and status = 'COMPLETED'
        ) then
          raise exception 'Milestone % cannot be marked ACCEPTED without a verified COMPLETED payment intent', new.id;
        end if;
      end if;

      -- 2. Check completed intent count: protect paid milestones
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
        if old.status = 'ACCEPTED' and new.status <> 'ACCEPTED' then
          raise exception 'Milestone % cannot transition away from ACCEPTED after payment completion', old.id;
        end if;
      end if;

      -- 3. Check active intent count: protect milestones during active payment workflows
      select count(*) into v_active_intent_count
      from public.payment_intents
      where milestone_id = old.id
        and (
          status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')
          or (status = 'ORDER_CREATING' and order_creation_lease_expires_at is not null and order_creation_lease_expires_at > clock_timestamp())
          or (status = 'CAPTURING' and capture_lease_expires_at is not null and capture_lease_expires_at > clock_timestamp())
        );

      if v_active_intent_count > 0 then
        -- During active intents, milestone status cannot be changed to non-payable status,
        -- AND cannot be ACCEPTED unless a COMPLETED payment intent exists (guaranteed by check 1 above).
        if new.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED') then
          raise exception 'Milestone % cannot be cancelled or moved to non-payable status % while an active payment operation, reconciliation, or lease is in progress', old.id, new.status;
        end if;

        if (old.amount_minor is distinct from new.amount_minor) or (old.currency is distinct from new.currency) then
          raise exception 'Milestone % financial attributes (amount/currency) cannot be modified while an active payment operation, reconciliation, or lease is in progress', old.id;
        end if;
      end if;
    end if;

    return new;
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 3. UPDATED RECORD_PAYPAL_ORDER_CAPTURED RPC (F-01, F-02)
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

  -- 7. Check global uniqueness of capture ID across other payment intents
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
    -- Check if capture was already recorded (e.g. as PENDING) for this intent
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and provider_reference_id = v_clean_capture_id
      and transaction_type = 'CAPTURE'
    limit 1;

    if found then
      if v_existing_capture.status = 'COMPLETED' then
        -- Idempotent return (already completed)
        null;
      elsif v_existing_capture.status = 'PENDING' then
        -- Authorized in-place status transition from PENDING to COMPLETED
        perform set_config('payroost.ledger_mutation_authorized', 'true', true);

        update public.payment_transactions
        set status = 'COMPLETED',
            raw_response = p_raw_capture_response,
            captured_at = now()
        where id = v_existing_capture.id;
      else
        return jsonb_build_object('success', false, 'error', 'UNSUPPORTED_EXISTING_STATUS');
      end if;
    else
      -- Insert verified capture into append-only payment ledger
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
    end if;

    -- B. Atomically mark payment intent COMPLETED FIRST (F-02 requirement)
    update public.payment_intents
    set status = 'COMPLETED',
        completed_at = now(),
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    -- C. Atomically mark milestone ACCEPTED SECOND (F-02 trigger validates intent is completed)
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
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and provider_reference_id = v_clean_capture_id
      and transaction_type = 'CAPTURE'
    limit 1;

    if found then
      if v_existing_capture.status = 'COMPLETED' then
        -- Capture already completed; do not regress to PENDING
        return jsonb_build_object(
          'success', true,
          'already_recorded', true,
          'payment_intent_id', v_intent.id,
          'capture_id', v_clean_capture_id,
          'status', 'COMPLETED'
        );
      end if;
      -- Already recorded as PENDING
    else
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
    end if;

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
      'status', v_clean_status
    );
  end if;
end;
$$;

revoke all on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) to service_role;

-- ============================================================================
-- 4. HARDENED RECONCILE_AND_COMPLETE_PAYMENT_INTENT RPC (F-01, F-02, F-04)
-- ============================================================================

create or replace function public.reconcile_and_complete_payment_intent(
  p_intent_id uuid,
  p_provider_capture_id text,
  p_raw_capture_response jsonb,
  p_raw_order_response jsonb,
  p_resolution_notes text default null,
  p_amount_cents bigint default null,
  p_payee_merchant_id text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_clean_capture_id text;
  v_capture_amount_text text;
  v_capture_currency text;
  v_capture_merchant_id text;
  v_capture_order_id text;
  v_dollars bigint;
  v_cents bigint;
  v_parsed_cents bigint;
  v_existing_capture public.payment_transactions%rowtype;

  v_target_pu jsonb;
  v_pu_custom_id text;
  v_pu_ref_id text;
  v_pu_amount_text text;
  v_pu_currency text;
  v_pu_merchant_id text;

  v_cap_item jsonb;
  v_capture_occurrence_count int := 0;
begin
  -- 1. Set transaction-local flags so triggers permit authorized recovery transition
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 2. Basic parameter validations
  v_clean_capture_id := trim(p_provider_capture_id);
  if char_length(v_clean_capture_id) < 3 then
    raise exception 'Invalid provider capture ID';
  end if;

  if p_raw_capture_response is null or jsonb_typeof(p_raw_capture_response) <> 'object' then
    raise exception 'Provider capture response must be a valid JSON object';
  end if;

  if p_raw_order_response is null or jsonb_typeof(p_raw_order_response) <> 'object' then
    raise exception 'Provider order response must be a valid JSON object';
  end if;

  -- 3. Lock payment intent row
  select * into v_intent
  from public.payment_intents
  where id = p_intent_id
  for update;

  if not found then
    raise exception 'Payment intent not found';
  end if;

  -- 4. Idempotency Check: If already completed with this exact capture, return true
  if v_intent.status = 'COMPLETED' then
    if exists (
      select 1 from public.payment_transactions
      where payment_intent_id = p_intent_id
        and provider_reference_id = v_clean_capture_id
        and transaction_type = 'CAPTURE'
        and status = 'COMPLETED'
    ) then
      return true; -- Idempotent success
    else
      raise exception 'Payment intent is already COMPLETED with a different capture reference';
    end if;
  end if;

  -- 5. Recovery Eligibility Guard: RECONCILIATION_REQUIRED or expired CAPTURING
  if v_intent.status not in ('RECONCILIATION_REQUIRED', 'CAPTURING') then
    raise exception 'Intent status % is not eligible for reconciliation recovery; must be RECONCILIATION_REQUIRED or CAPTURING', v_intent.status;
  end if;

  if v_intent.status = 'CAPTURING' and v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > clock_timestamp() then
    raise exception 'Cannot reconcile CAPTURING intent while an active worker lease is held';
  end if;

  -- 6. Environment & Provider Guards
  if v_intent.provider <> 'PAYPAL' then
    raise exception 'Payment intent provider must be PAYPAL';
  end if;

  if v_intent.environment <> 'SANDBOX' then
    raise exception 'Payment intent environment must be SANDBOX in this phase';
  end if;

  if v_intent.provider_order_id is null or char_length(trim(v_intent.provider_order_id)) = 0 then
    raise exception 'Payment intent is missing stored provider_order_id';
  end if;

  -- 7. Check global capture reference uniqueness across other payment intents
  if exists (
    select 1 from public.payment_transactions
    where provider_reference_id = v_clean_capture_id
      and payment_intent_id <> p_intent_id
  ) then
    raise exception 'Provider capture ID % is already associated with another payment intent', v_clean_capture_id;
  end if;

  -- ==========================================================================
  -- 8. VALIDATE CAPTURE RESPONSE (p_raw_capture_response)
  -- ==========================================================================

  -- 8.1 Capture ID match
  if coalesce(p_raw_capture_response->>'id', '') <> v_clean_capture_id then
    raise exception 'Capture response ID % does not match supplied capture ID %',
      coalesce(p_raw_capture_response->>'id', '<missing>'), v_clean_capture_id;
  end if;

  -- 8.2 Capture status must be exactly COMPLETED
  if coalesce(p_raw_capture_response->>'status', '') <> 'COMPLETED' then
    raise exception 'Authoritative PayPal capture status must be COMPLETED, received %',
      coalesce(p_raw_capture_response->>'status', '<missing>');
  end if;

  -- 8.3 Currency validation
  if not (p_raw_capture_response ? 'amount') or not (p_raw_capture_response->'amount' ? 'currency_code') then
    raise exception 'Capture response missing amount.currency_code';
  end if;

  v_capture_currency := p_raw_capture_response->'amount'->>'currency_code';
  if v_capture_currency <> 'USD' then
    raise exception 'Capture currency % is unsupported; expected USD', v_capture_currency;
  end if;

  if v_capture_currency <> v_intent.expected_currency then
    raise exception 'Capture currency % does not match intent expected currency %',
      v_capture_currency, v_intent.expected_currency;
  end if;

  -- 8.4 Amount validation with strict monetary parsing (no float)
  if not (p_raw_capture_response->'amount' ? 'value') then
    raise exception 'Capture response missing amount.value';
  end if;

  v_capture_amount_text := p_raw_capture_response->'amount'->>'value';
  if v_capture_amount_text !~ '^(0|[1-9]\d*)\.\d{2}$' then
    raise exception 'Invalid monetary format in capture amount: %', v_capture_amount_text;
  end if;

  if v_capture_amount_text <> v_intent.expected_amount_canonical then
    raise exception 'Capture amount % does not match expected intent amount %',
      v_capture_amount_text, v_intent.expected_amount_canonical;
  end if;

  v_dollars := split_part(v_capture_amount_text, '.', 1)::bigint;
  v_cents := split_part(v_capture_amount_text, '.', 2)::bigint;
  v_parsed_cents := (v_dollars * 100) + v_cents;

  if v_parsed_cents <> v_intent.expected_amount_cents then
    raise exception 'Parsed capture cents % do not match expected intent cents %',
      v_parsed_cents, v_intent.expected_amount_cents;
  end if;

  -- 8.5 Payee merchant verification
  if not (p_raw_capture_response ? 'payee') or not (p_raw_capture_response->'payee' ? 'merchant_id') then
    raise exception 'Capture response missing payee.merchant_id';
  end if;

  v_capture_merchant_id := trim(p_raw_capture_response->'payee'->>'merchant_id');
  if v_capture_merchant_id <> v_intent.expected_merchant_id then
    raise exception 'Capture payee merchant ID % does not match expected merchant ID %',
      v_capture_merchant_id, v_intent.expected_merchant_id;
  end if;

  -- 8.6 Optional custom_id validation
  if (p_raw_capture_response ? 'custom_id') and
     char_length(trim(coalesce(p_raw_capture_response->>'custom_id', ''))) > 0 and
     trim(p_raw_capture_response->>'custom_id') <> v_intent.id::text then
    raise exception 'Capture custom_id % does not match payment intent ID %',
      p_raw_capture_response->>'custom_id', v_intent.id::text;
  end if;

  -- ==========================================================================
  -- 9. VALIDATE AUTHORITATIVE ORDER RESPONSE (p_raw_order_response)
  -- ==========================================================================

  -- 9.1 Top-level order ID and status
  v_capture_order_id := trim(coalesce(p_raw_order_response->>'id', ''));
  if v_capture_order_id <> v_intent.provider_order_id then
    raise exception 'Order response ID % does not match intent provider_order_id %',
      v_capture_order_id, v_intent.provider_order_id;
  end if;

  if coalesce(p_raw_order_response->>'status', '') <> 'COMPLETED' then
    raise exception 'Authoritative PayPal order status must be COMPLETED, received %',
      coalesce(p_raw_order_response->>'status', '<missing>');
  end if;

  -- 9.2 Purchase unit contract enforcement
  if not (p_raw_order_response ? 'purchase_units') or
     jsonb_typeof(p_raw_order_response->'purchase_units') <> 'array' or
     jsonb_array_length(p_raw_order_response->'purchase_units') <> 1 then
    raise exception 'Order response purchase_units must contain exactly 1 element, received %',
      coalesce(jsonb_array_length(p_raw_order_response->'purchase_units')::text, 'null');
  end if;

  v_target_pu := p_raw_order_response->'purchase_units'->0;
  if jsonb_typeof(v_target_pu) <> 'object' then
    raise exception 'Order purchase_units[0] must be an object';
  end if;

  -- 9.3 Custom ID and Reference ID bindings
  v_pu_custom_id := trim(coalesce(v_target_pu->>'custom_id', ''));
  v_pu_ref_id := trim(coalesce(v_target_pu->>'reference_id', ''));

  if v_pu_custom_id = v_intent.id::text and v_pu_ref_id <> v_intent.milestone_id::text then
    raise exception 'Purchase unit contains correct custom_id % but contradictory reference_id % (expected milestone %)',
      v_pu_custom_id, v_pu_ref_id, v_intent.milestone_id::text;
  end if;

  if v_pu_ref_id = v_intent.milestone_id::text and v_pu_custom_id <> v_intent.id::text then
    raise exception 'Purchase unit contains correct reference_id % but contradictory custom_id % (expected intent %)',
      v_pu_ref_id, v_pu_custom_id, v_intent.id::text;
  end if;

  if v_pu_custom_id <> v_intent.id::text or v_pu_ref_id <> v_intent.milestone_id::text then
    raise exception 'Purchase unit matching intent ID % and milestone ID % not found in order response',
      v_intent.id::text, v_intent.milestone_id::text;
  end if;

  -- 9.4 Currency and Amount
  if not (v_target_pu ? 'amount') or not (v_target_pu->'amount' ? 'currency_code') then
    raise exception 'Matched purchase unit missing amount.currency_code';
  end if;

  v_pu_currency := v_target_pu->'amount'->>'currency_code';
  if v_pu_currency <> 'USD' or v_pu_currency <> v_intent.expected_currency then
    raise exception 'Purchase unit currency % does not match expected USD', v_pu_currency;
  end if;

  if not (v_target_pu->'amount' ? 'value') or (v_target_pu->'amount'->>'value') <> v_intent.expected_amount_canonical then
    raise exception 'Purchase unit amount does not match expected amount %', v_intent.expected_amount_canonical;
  end if;

  -- 9.5 Payee merchant
  if not (v_target_pu ? 'payee') or not (v_target_pu->'payee' ? 'merchant_id') then
    raise exception 'Matched purchase unit missing payee.merchant_id';
  end if;

  v_pu_merchant_id := trim(v_target_pu->'payee'->>'merchant_id');
  if v_pu_merchant_id <> v_intent.expected_merchant_id then
    raise exception 'Purchase unit payee merchant ID % does not match expected merchant ID %',
      v_pu_merchant_id, v_intent.expected_merchant_id;
  end if;

  -- ==========================================================================
  -- 10. MANDATORY CAPTURE LINKAGE WITHIN MATCHED PURCHASE UNIT
  -- ==========================================================================

  if not (v_target_pu ? 'payments') or jsonb_typeof(v_target_pu->'payments') <> 'object' or
     not (v_target_pu->'payments' ? 'captures') or
     jsonb_typeof(v_target_pu->'payments'->'captures') <> 'array' or
     jsonb_array_length(v_target_pu->'payments'->'captures') = 0 then
    raise exception 'Matched purchase unit missing mandatory non-empty payments.captures array';
  end if;

  v_capture_occurrence_count := 0;
  for v_cap_item in select * from jsonb_array_elements(v_target_pu->'payments'->'captures') loop
    if jsonb_typeof(v_cap_item) <> 'object' or not (v_cap_item ? 'id') or char_length(trim(v_cap_item->>'id')) < 3 then
      raise exception 'Invalid capture entry in purchase unit payments.captures';
    end if;

    if trim(v_cap_item->>'id') = v_clean_capture_id then
      v_capture_occurrence_count := v_capture_occurrence_count + 1;
      if coalesce(v_cap_item->>'status', '') <> 'COMPLETED' then
        raise exception 'Capture % in order purchase unit has non-COMPLETED status %',
          v_clean_capture_id, coalesce(v_cap_item->>'status', '<missing>');
      end if;
    end if;
  end loop;

  if v_capture_occurrence_count = 0 then
    raise exception 'Expected capture ID % not found in matched purchase unit captures', v_clean_capture_id;
  end if;

  if v_capture_occurrence_count > 1 then
    raise exception 'Duplicate occurrence of capture ID % in matched purchase unit captures', v_clean_capture_id;
  end if;

  -- ==========================================================================
  -- 11. REJECT CONTRADICTORY LEGACY ARGUMENTS (IF PROVIDED)
  -- ==========================================================================
  if p_amount_cents is not null and p_amount_cents <> v_parsed_cents then
    raise exception 'Contradictory argument: p_amount_cents % does not match verified provider capture amount %',
      p_amount_cents, v_parsed_cents;
  end if;

  if p_payee_merchant_id is not null and trim(p_payee_merchant_id) <> v_capture_merchant_id then
    raise exception 'Contradictory argument: p_payee_merchant_id % does not match verified provider capture payee %',
      p_payee_merchant_id, v_capture_merchant_id;
  end if;

  -- ==========================================================================
  -- 12. INSERT OR UPDATE VERIFIED CAPTURE INTO FINANCIAL LEDGER (F-01)
  -- ==========================================================================
  select * into v_existing_capture
  from public.payment_transactions
  where payment_intent_id = p_intent_id
    and provider_reference_id = v_clean_capture_id
    and transaction_type = 'CAPTURE'
  limit 1;

  if found then
    if v_existing_capture.status = 'COMPLETED' then
      -- Idempotent return (already recorded as completed)
      null;
    elsif v_existing_capture.status = 'PENDING' then
      -- Authorized in-place update from PENDING to COMPLETED
      perform set_config('payroost.ledger_mutation_authorized', 'true', true);

      update public.payment_transactions
      set status = 'COMPLETED',
          raw_response = jsonb_build_object(
            'capture', p_raw_capture_response,
            'order', p_raw_order_response
          ),
          captured_at = now()
      where id = v_existing_capture.id;
    else
      raise exception 'Existing transaction for capture % has unsupported status %',
        v_clean_capture_id, v_existing_capture.status;
    end if;
  else
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
      v_clean_capture_id,
      'COMPLETED',
      v_parsed_cents,
      v_capture_currency,
      v_capture_merchant_id,
      jsonb_build_object(
        'capture', p_raw_capture_response,
        'order', p_raw_order_response
      )
    );
  end if;

  -- ==========================================================================
  -- 13. ATOMICALLY UPDATE INTENT STATUS TO COMPLETED FIRST (F-02 requirement)
  -- ==========================================================================
  update public.payment_intents
  set status = 'COMPLETED',
      completed_at = coalesce(completed_at, now()),
      capture_lease_expires_at = null,
      capture_lease_token = null,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      reconciliation_reason = null,
      updated_at = now()
  where id = p_intent_id;

  -- ==========================================================================
  -- 13.1 ATOMICALLY UPDATE MILESTONE STATUS TO ACCEPTED SECOND (F-02 requirement)
  -- ==========================================================================
  update public.milestones
  set status = 'ACCEPTED',
      updated_at = now()
  where id = v_intent.milestone_id;

  -- ==========================================================================
  -- 14. RECORD AUDIT ACTIVITY EVENT
  -- ==========================================================================
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    'System',
    'payment.reconciliation_completed',
    'Payment of $' || v_intent.expected_amount_canonical || ' recovered and completed via verified provider reconciliation',
    jsonb_build_object(
      'paymentIntentId', p_intent_id,
      'milestoneId', v_intent.milestone_id,
      'providerCaptureId', v_clean_capture_id,
      'providerOrderId', v_intent.provider_order_id,
      'notes', p_resolution_notes
    )
  );

  return true;
end;
$$;

revoke all on function public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text) from public, anon, authenticated;
grant execute on function public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text) to service_role;

-- ============================================================================
-- 5. HARDENED ADMINISTRATIVE RECONCILIATION RPCS (F-04)
-- ============================================================================

-- 5.1 admin_mark_intent_reconciliation_required
create or replace function public.admin_mark_intent_reconciliation_required(
  p_payment_intent_id uuid,
  p_reason_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_sanitized_reason text;
begin
  if p_payment_intent_id is null or p_reason_code is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- Prevent overriding terminal completed or already completed orders
  if v_intent.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- Reject if an active worker holds an unexpired order creation lease
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'ORDER_CREATION',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  -- Reject if an active worker holds an unexpired capture lease
  if v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'CAPTURE',
      'lease_expires_at', v_intent.capture_lease_expires_at
    );
  end if;

  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);

  update public.payment_intents
  set status = 'RECONCILIATION_REQUIRED',
      reconciliation_reason = v_sanitized_reason,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'status', 'RECONCILIATION_REQUIRED',
    'reason_code', v_sanitized_reason
  );
end;
$$;

revoke all on function public.admin_mark_intent_reconciliation_required(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_mark_intent_reconciliation_required(uuid, text) to service_role;

-- 5.2 admin_recover_and_bind_paypal_order
create or replace function public.admin_recover_and_bind_paypal_order(
  p_intent_id uuid,
  p_recovered_order_id text,
  p_raw_order_response jsonb,
  p_actor text default 'system_reconciliation_service'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_clean_order_id text;
  v_order_status text;
  v_actor text;
begin
  -- 1. Dual-layer session role assertion
  if session_user not in ('service_role', 'postgres', 'supabase_admin') then
    return jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED');
  end if;

  -- 2. Set transaction-local flag for trigger
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 3. Validate arguments
  if p_intent_id is null or p_recovered_order_id is null or p_raw_order_response is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_order_id := trim(p_recovered_order_id);
  if char_length(v_clean_order_id) < 1 or char_length(v_clean_order_id) > 64 then
    return jsonb_build_object('success', false, 'error', 'INVALID_ORDER_ID');
  end if;

  v_actor := substr(trim(coalesce(p_actor, 'system_reconciliation_service')), 1, 100);

  -- 4. Lock payment intent
  select * into v_intent
  from public.payment_intents
  where id = p_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 5. Eligible states: RECONCILIATION_REQUIRED, ORDER_CREATING, or CAPTURING (F-04)
  if v_intent.status not in ('RECONCILIATION_REQUIRED', 'ORDER_CREATING', 'CAPTURING') then
    -- Idempotent check: if already bound to this order and in ORDER_CREATED
    if v_intent.status = 'ORDER_CREATED' and v_intent.provider_order_id = v_clean_order_id then
      return jsonb_build_object(
        'success', true,
        'already_bound', true,
        'payment_intent_id', v_intent.id,
        'provider_order_id', v_intent.provider_order_id,
        'status', 'ORDER_CREATED'
      );
    end if;

    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_INITIAL_STATUS',
      'current_status', v_intent.status
    );
  end if;

  -- 6. Check active leases: reject if an active worker holds an unexpired lease
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'ORDER_CREATION',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  if v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'CAPTURE',
      'lease_expires_at', v_intent.capture_lease_expires_at
    );
  end if;

  -- 7. Conflict check: provider_order_id must not already be set to a different order
  if v_intent.provider_order_id is not null and v_intent.provider_order_id <> v_clean_order_id then
    return jsonb_build_object(
      'success', false,
      'error', 'ORDER_ID_CONFLICT',
      'existing_order_id', v_intent.provider_order_id
    );
  end if;

  -- 8. Raw response verification: order status must be CREATED or APPROVED (uncaptured order)
  v_order_status := upper(trim(coalesce(p_raw_order_response->>'status', '')));
  if v_order_status not in ('CREATED', 'APPROVED') then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_RAW_ORDER_STATUS',
      'status', v_order_status
    );
  end if;

  -- 9. Atomic transition to ORDER_CREATED
  update public.payment_intents
  set provider_order_id = v_clean_order_id,
      status = 'ORDER_CREATED',
      reconciliation_reason = null,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- 10. Audit activity logging
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    'payment.order_recovered',
    'Recovered and bound PayPal order ' || v_clean_order_id || ' to payment intent ' || v_intent.id::text || ' via authoritative idempotency replay',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'previousStatus', v_intent.status,
      'newStatus', 'ORDER_CREATED',
      'providerOrderId', v_clean_order_id,
      'orderIdempotencyKey', v_intent.order_idempotency_key,
      'rawOrderResponse', p_raw_order_response
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'milestone_id', v_intent.milestone_id,
    'provider_order_id', v_clean_order_id,
    'status', 'ORDER_CREATED'
  );
end;
$$;

revoke all on function public.admin_recover_and_bind_paypal_order(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.admin_recover_and_bind_paypal_order(uuid, text, jsonb, text) to service_role;

-- 5.3 admin_resolve_reconciliation_without_payment
create or replace function public.admin_resolve_reconciliation_without_payment(
  p_intent_id uuid,
  p_target_status text,
  p_reason_code text,
  p_evidence jsonb,
  p_notes text default null,
  p_actor text default 'system_reconciliation_service'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_sanitized_reason text;
  v_clean_status text;
  v_evidence_type text;
  v_confirmed_by text;
  v_order_status text;
  v_actor text;
begin
  -- 1. Dual-layer session role assertion
  if session_user not in ('service_role', 'postgres', 'supabase_admin') then
    return jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED');
  end if;

  -- 2. Enable privileged reconciliation transaction flag
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 3. Validate mandatory input arguments
  if p_intent_id is null or p_target_status is null or p_reason_code is null or p_evidence is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_status := upper(trim(p_target_status));
  if v_clean_status not in ('FAILED', 'CANCELLED') then
    return jsonb_build_object('success', false, 'error', 'INVALID_TARGET_STATUS', 'target_status', v_clean_status);
  end if;

  v_actor := substr(trim(coalesce(p_actor, 'system_reconciliation_service')), 1, 100);

  -- 4. Row lock payment intent
  select * into v_intent
  from public.payment_intents
  where id = p_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 5. Initial state must be RECONCILIATION_REQUIRED or CAPTURING (F-04)
  if v_intent.status not in ('RECONCILIATION_REQUIRED', 'CAPTURING') then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_INITIAL_STATUS',
      'current_status', v_intent.status
    );
  end if;

  -- 6. Concurrency protection: Reject if an active worker lease is running
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'ORDER_CREATION',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  if v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'CAPTURE',
      'lease_expires_at', v_intent.capture_lease_expires_at
    );
  end if;

  -- 7. Evidence validation
  if jsonb_typeof(p_evidence) <> 'object' then
    return jsonb_build_object('success', false, 'error', 'INVALID_EVIDENCE_PAYLOAD');
  end if;

  v_evidence_type := trim(coalesce(p_evidence->>'evidence_type', ''));
  v_confirmed_by := trim(coalesce(p_evidence->>'confirmed_by', ''));

  if v_evidence_type not in ('ORDER_NOT_FOUND_ON_PROVIDER', 'ORDER_VERIFIED_INACTIVE', 'MANUAL_OPERATOR_VERIFICATION') then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED_EVIDENCE_TYPE', 'evidence_type', v_evidence_type);
  end if;

  if char_length(v_confirmed_by) = 0 then
    return jsonb_build_object('success', false, 'error', 'MISSING_EVIDENCE_CONFIRMER');
  end if;

  if not (p_evidence ? 'verified_at') or char_length(trim(coalesce(p_evidence->>'verified_at', ''))) = 0 then
    return jsonb_build_object('success', false, 'error', 'MISSING_VERIFICATION_TIMESTAMP');
  end if;

  if v_evidence_type = 'ORDER_NOT_FOUND_ON_PROVIDER' then
    if not (p_evidence ? 'provider_replay_status') or (p_evidence->>'provider_replay_status') <> '404' then
      return jsonb_build_object('success', false, 'error', 'UNVERIFIED_ORDER_NOT_CREATED');
    end if;
  end if;

  if v_evidence_type = 'ORDER_VERIFIED_INACTIVE' then
    v_order_status := upper(trim(coalesce(p_evidence->>'paypal_order_status', '')));
    if v_order_status not in ('VOIDED', 'EXPIRED') then
      return jsonb_build_object('success', false, 'error', 'ORDER_STATUS_NOT_INACTIVE', 'status', v_order_status);
    end if;
  end if;

  -- 8. Sanitize reason code
  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);

  -- 9. Atomic transition to FAILED or CANCELLED
  update public.payment_intents
  set status = v_clean_status,
      reconciliation_reason = v_sanitized_reason,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- 10. Audit event logging
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    case when v_clean_status = 'CANCELLED' then 'payment.reconciliation_cancelled' else 'payment.reconciliation_failed' end,
    'Payment intent ' || v_intent.id::text || ' marked ' || v_clean_status || ' without payment via verified provider evidence',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'previousStatus', v_intent.status,
      'newStatus', v_clean_status,
      'reasonCode', v_sanitized_reason,
      'evidence', p_evidence,
      'notes', p_notes
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'milestone_id', v_intent.milestone_id,
    'previous_status', v_intent.status,
    'status', v_clean_status,
    'reason_code', v_sanitized_reason
  );
end;
$$;

revoke all on function public.admin_resolve_reconciliation_without_payment(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.admin_resolve_reconciliation_without_payment(uuid, text, text, jsonb, text, text) to service_role;
