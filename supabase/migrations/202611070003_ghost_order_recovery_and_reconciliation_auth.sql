-- PayRoost Phase 3B.4.1.6: Ghost-Order Recovery & Reconciliation Authorization Hardening
--
-- Objectives:
-- 1. Dual-Layer Authorization in protect_payment_intent_immutability():
--    Enforces that transitions out of RECONCILIATION_REQUIRED strictly require session_user
--    in ('service_role', 'postgres', 'supabase_admin') in addition to payroost.reconciliation_active = 'true'.
--    Unprivileged roles (anon, authenticated) can never satisfy this check, even if they invoke set_config().
-- 2. Permit ORDER_CREATED Transition Out of RECONCILIATION_REQUIRED:
--    Allows privileged reconciliation to transition RECONCILIATION_REQUIRED -> ORDER_CREATED when a ghost order
--    is successfully recovered and bound to the intent via idempotency replay.
-- 3. Dedicated admin_recover_and_bind_paypal_order RPC:
--    Safely binds a recovered PayPal order ID to a payment intent, transitioning it from
--    RECONCILIATION_REQUIRED (or ORDER_CREATING) to ORDER_CREATED with audit activity logging.
-- 4. Hardened admin_resolve_reconciliation_without_payment RPC:
--    Validates session_user, requires authenticated raw PayPal provider evidence, and rejects
--    unverified assertions that an order was not created.
-- 5. Strict Privilege Lockdown:
--    All RPCs declared SECURITY DEFINER set search_path = '' and restricted strictly to service_role.

-- ============================================================================
-- 1. HARDENED PAYMENT INTENT IMMUTABILITY TRIGGER (DUAL-LAYER AUTH)
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

    -- Ambiguous state cannot transition automatically unless authorized reconciliation is active
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

-- ============================================================================
-- 2. RPC: admin_recover_and_bind_paypal_order (FOR GHOST-ORDER RECOVERY)
-- ============================================================================

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

  -- 5. Eligible states: RECONCILIATION_REQUIRED or ORDER_CREATING
  if v_intent.status not in ('RECONCILIATION_REQUIRED', 'ORDER_CREATING') then
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

  -- 6. Check active lease: reject if an active worker holds a lease
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
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

  -- 8. Raw response verification: order status must be CREATED
  v_order_status := upper(trim(coalesce(p_raw_order_response->>'status', '')));
  if v_order_status <> 'CREATED' then
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

-- ============================================================================
-- 3. HARDENED admin_resolve_reconciliation_without_payment RPC
-- ============================================================================

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

  -- 5. Initial state must strictly be RECONCILIATION_REQUIRED
  if v_intent.status <> 'RECONCILIATION_REQUIRED' then
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
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  -- 7. Financial ledger protection: If a completed capture exists, reject without-payment resolution
  if exists (
    select 1 from public.payment_transactions
    where payment_intent_id = v_intent.id
      and status = 'COMPLETED'
  ) then
    return jsonb_build_object('success', false, 'error', 'COMPLETED_CAPTURE_EXISTS');
  end if;

  -- 8. Controlled sanitization of reason code
  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);
  if char_length(v_sanitized_reason) = 0 then
    return jsonb_build_object('success', false, 'error', 'INVALID_REASON_CODE');
  end if;

  -- 9. Authoritative Provider Evidence Validation
  if jsonb_typeof(p_evidence) <> 'object' then
    return jsonb_build_object('success', false, 'error', 'INVALID_EVIDENCE_FORMAT');
  end if;

  v_evidence_type := upper(trim(coalesce(p_evidence->>'evidence_type', '')));
  v_confirmed_by := trim(coalesce(p_evidence->>'confirmed_by', ''));

  if char_length(v_evidence_type) = 0 or char_length(v_confirmed_by) = 0 then
    return jsonb_build_object('success', false, 'error', 'INCOMPLETE_EVIDENCE_METADATA');
  end if;

  -- Assert verified_at timestamp is present and valid
  if not (p_evidence ? 'verified_at') or char_length(trim(coalesce(p_evidence->>'verified_at', ''))) = 0 then
    return jsonb_build_object('success', false, 'error', 'MISSING_VERIFICATION_TIMESTAMP');
  end if;

  if v_evidence_type = 'ORDER_NOT_CREATED' then
    -- Assert that no provider order was ever recorded on this intent
    if v_intent.provider_order_id is not null then
      return jsonb_build_object(
        'success', false,
        'error', 'CONTRADICTORY_EVIDENCE_ORDER_EXISTS',
        'provider_order_id', v_intent.provider_order_id
      );
    end if;

    -- Require authoritative idempotency replay evidence proving inquiry was executed
    if not (p_evidence ? 'idempotency_inquiry_executed') or (p_evidence->>'idempotency_inquiry_executed')::boolean is not true then
      return jsonb_build_object('success', false, 'error', 'UNVERIFIED_ORDER_NOT_CREATED');
    end if;

  elsif v_evidence_type = 'ORDER_VERIFIED_INACTIVE' then
    -- Must match recorded provider_order_id
    if v_intent.provider_order_id is null then
      return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISSING_ON_INTENT');
    end if;

    if trim(coalesce(p_evidence->>'order_id', '')) <> v_intent.provider_order_id then
      return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISMATCH');
    end if;

    v_order_status := upper(trim(coalesce(p_evidence->>'paypal_order_status', '')));
    if v_order_status not in ('VOIDED', 'EXPIRED', 'SAVED') then
      return jsonb_build_object(
        'success', false,
        'error', 'INVALID_PROVIDER_ORDER_STATUS',
        'paypal_order_status', v_order_status
      );
    end if;

  else
    return jsonb_build_object('success', false, 'error', 'UNSUPPORTED_EVIDENCE_TYPE', 'evidence_type', v_evidence_type);
  end if;

  -- 10. Atomic state transition and lease clearing
  update public.payment_intents
  set status = v_clean_status,
      reconciliation_reason = v_sanitized_reason,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- 11. Audit Activity Logging
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    case when v_clean_status = 'CANCELLED' then 'payment.reconciliation_cancelled' else 'payment.reconciliation_failed' end,
    'Payment intent ' || v_intent.id::text || ' resolved to ' || v_clean_status || ' via administrative reconciliation (' || v_sanitized_reason || ')',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'previousStatus', v_intent.status,
      'targetStatus', v_clean_status,
      'reasonCode', v_sanitized_reason,
      'notes', p_notes,
      'evidence', p_evidence
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'milestone_id', v_intent.milestone_id,
    'status', v_clean_status,
    'reason_code', v_sanitized_reason
  );
end;
$$;

revoke all on function public.admin_resolve_reconciliation_without_payment(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.admin_resolve_reconciliation_without_payment(uuid, text, text, jsonb, text, text) to service_role;
