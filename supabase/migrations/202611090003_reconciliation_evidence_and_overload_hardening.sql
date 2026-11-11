-- PayRoost Phase 3B.4.2.4: Financial Recovery Guard and RPC Overload Remediation
--
-- Remediates:
-- 1. F-20261109-01 (HIGH): Restores completed-capture protection and strict PayPal order ID binding
--    in admin_resolve_reconciliation_without_payment().
--    - Enforces that no COMPLETED transaction exists in payment_transactions before cancellation.
--    - Enforces exact match between stored provider_order_id and evidence order_id for ORDER_VERIFIED_INACTIVE.
--    - Enforces provider_order_id is null and 404 replay for ORDER_NOT_FOUND_ON_PROVIDER.
--    - Rejects invalid provider statuses (CREATED, APPROVED, etc. cannot be cancelled as inactive).
--
-- 2. F-20261109-02 (MEDIUM): Drops obsolete 5-parameter overload of admin_resolve_reconciliation_without_payment.
--    - Leaves exactly one authoritative 6-parameter signature with appropriate defaults and grants.
--
-- 3. F-20261109-03 (LOW): Adds request.jwt.claims JSON fallback to dual-layer PostgREST authorization.
--    - Applied across prevent_payment_transactions_mutation(), protect_payment_intent_immutability(),
--      admin_recover_and_bind_paypal_order(), and admin_resolve_reconciliation_without_payment().
--    - Supports both individual claim GUC (request.jwt.claim.role) and JSON object claim (request.jwt.claims).
--    - Fails closed on malformed claims; preserves direct DBA authorization.

-- ============================================================================
-- 1. DROP OBSOLETE 5-PARAMETER RPC OVERLOAD (F-20261109-02)
-- ============================================================================

drop function if exists public.admin_resolve_reconciliation_without_payment(uuid, text, text, jsonb, text);

-- ============================================================================
-- 2. HARDENED PAYMENT TRANSACTIONS IMMUTABILITY TRIGGER (F-20261109-03)
-- ============================================================================

create or replace function public.prevent_payment_transactions_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Financial transaction ledger is strictly append-only and records cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    -- Dual-Layer Check 1: Caller must be a trusted service role or superuser
    -- Supports both direct DBA connections and Supabase PostgREST service-role requests
    -- Includes request.jwt.claim.role with request.jwt.claims JSON fallback
    if not (
      session_user in ('postgres', 'supabase_admin', 'service_role')
      or (
        session_user = 'authenticator'
        and (
          coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
          or (
            current_setting('request.jwt.claims', true) is not null
            and current_setting('request.jwt.claims', true) ~ '^\s*\{.*\}\s*$'
            and (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
          )
        )
      )
    ) then
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
-- 3. HARDENED PAYMENT INTENT IMMUTABILITY & TRANSITION TRIGGER (F-20261109-03)
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
      -- Dual-Layer Check: Caller must be a trusted service role or superuser
      -- Supports both direct DBA connections and Supabase PostgREST service-role requests with JSON claims fallback
      if not (
        session_user in ('postgres', 'supabase_admin', 'service_role')
        or (
          session_user = 'authenticator'
          and (
            coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
            or (
              current_setting('request.jwt.claims', true) is not null
              and current_setting('request.jwt.claims', true) ~ '^\s*\{.*\}\s*$'
              and (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
            )
          )
        )
      ) then
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
    elsif old.status = 'CAPTURING' then
      -- Permit CAPTURING -> CANCELLED strictly through authorized administrative reconciliation
      if new.status = 'CANCELLED' then
        -- Role check with JSON claims fallback
        if not (
          session_user in ('postgres', 'supabase_admin', 'service_role')
          or (
            session_user = 'authenticator'
            and (
              coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
              or (
                current_setting('request.jwt.claims', true) is not null
                and current_setting('request.jwt.claims', true) ~ '^\s*\{.*\}\s*$'
                and (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
              )
            )
          )
        ) then
          raise exception 'Unauthorized: Only service_role can perform CAPTURING to CANCELLED reconciliation';
        end if;

        -- Privileged transaction flag check
        if current_setting('payroost.reconciliation_active', true) is distinct from 'true' then
          raise exception 'Payment intent transition from CAPTURING to CANCELLED requires privileged reconciliation intervention';
        end if;

        -- Lease expiry checks: both capture and order creation leases must be expired
        if old.capture_lease_expires_at is not null and old.capture_lease_expires_at > clock_timestamp() then
          raise exception 'Payment intent in CAPTURING cannot transition to CANCELLED while an active capture lease is held';
        end if;

        if old.order_creation_lease_expires_at is not null and old.order_creation_lease_expires_at > clock_timestamp() then
          raise exception 'Payment intent in CAPTURING cannot transition to CANCELLED while an active order creation lease is held';
        end if;

      elsif new.status not in ('COMPLETED', 'RECONCILING', 'RECONCILIATION_REQUIRED', 'FAILED', 'ORDER_CREATED', 'BUYER_APPROVED') then
        raise exception 'Invalid transition from CAPTURING to %', new.status;
      end if;
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
-- 4. HARDENED ADMIN_RECOVER_AND_BIND_PAYPAL_ORDER RPC (F-20261109-03)
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
  -- 1. Dual-layer role assertion with JSON claims fallback
  if not (
    session_user in ('postgres', 'supabase_admin', 'service_role')
    or (
      session_user = 'authenticator'
      and (
        coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
        or (
          current_setting('request.jwt.claims', true) is not null
          and current_setting('request.jwt.claims', true) ~ '^\s*\{.*\}\s*$'
          and (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
        )
      )
    )
  ) then
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

  -- 5. Eligible states: RECONCILIATION_REQUIRED, ORDER_CREATING, or CAPTURING
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

-- ============================================================================
-- 5. HARDENED ADMIN_RESOLVE_RECONCILIATION_WITHOUT_PAYMENT RPC (F-20261109-01, F-20261109-03)
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
  -- 1. Dual-layer role assertion with JSON claims fallback
  if not (
    session_user in ('postgres', 'supabase_admin', 'service_role')
    or (
      session_user = 'authenticator'
      and (
        coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
        or (
          current_setting('request.jwt.claims', true) is not null
          and current_setting('request.jwt.claims', true) ~ '^\s*\{.*\}\s*$'
          and (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
        )
      )
    )
  ) then
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

  -- 5. Initial state must be RECONCILIATION_REQUIRED or CAPTURING
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

  -- 7. Financial Ledger Protection (Finding F-20261109-01):
  -- If a completed capture exists on the ledger for this payment intent, reject resolution without payment.
  -- Locks rows for update within the transaction to guarantee strict concurrency protection.
  perform 1
  from public.payment_transactions pt
  where pt.payment_intent_id = v_intent.id
    and pt.status = 'COMPLETED'
  for update;

  if found then
    return jsonb_build_object(
      'success', false,
      'error', 'COMPLETED_CAPTURE_EXISTS',
      'payment_intent_id', v_intent.id
    );
  end if;

  -- 8. Authoritative Provider Evidence Validation (Finding F-20261109-01)
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

  -- Branch 8A: ORDER_NOT_FOUND_ON_PROVIDER
  -- Prohibits claiming order not found if a provider_order_id is already bound to this intent
  if v_evidence_type = 'ORDER_NOT_FOUND_ON_PROVIDER' then
    if v_intent.provider_order_id is not null then
      return jsonb_build_object(
        'success', false,
        'error', 'CONTRADICTORY_EVIDENCE_ORDER_EXISTS',
        'provider_order_id', v_intent.provider_order_id
      );
    end if;

    if not (p_evidence ? 'provider_replay_status') or (p_evidence->>'provider_replay_status') <> '404' then
      return jsonb_build_object('success', false, 'error', 'UNVERIFIED_ORDER_NOT_CREATED');
    end if;
  end if;

  -- Branch 8B: ORDER_VERIFIED_INACTIVE (Strict Provider Order ID Binding)
  if v_evidence_type = 'ORDER_VERIFIED_INACTIVE' then
    -- Stored order ID must be present
    if v_intent.provider_order_id is null then
      return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISSING_ON_INTENT');
    end if;

    -- Evidence must supply order_id
    if not (p_evidence ? 'order_id') or char_length(trim(coalesce(p_evidence->>'order_id', ''))) = 0 then
      return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISSING_IN_EVIDENCE');
    end if;

    -- Evidence order ID must strictly match stored provider_order_id
    if trim(p_evidence->>'order_id') <> v_intent.provider_order_id then
      return jsonb_build_object(
        'success', false,
        'error', 'ORDER_ID_MISMATCH',
        'expected_order_id', v_intent.provider_order_id,
        'supplied_order_id', trim(p_evidence->>'order_id')
      );
    end if;

    -- Provider status must be strictly VOIDED or EXPIRED
    v_order_status := upper(trim(coalesce(p_evidence->>'paypal_order_status', '')));
    if v_order_status not in ('VOIDED', 'EXPIRED') then
      return jsonb_build_object(
        'success', false,
        'error', 'ORDER_STATUS_NOT_INACTIVE',
        'status', v_order_status
      );
    end if;
  end if;

  -- Branch 8C: MANUAL_OPERATOR_VERIFICATION
  if v_evidence_type = 'MANUAL_OPERATOR_VERIFICATION' then
    if not (p_evidence ? 'ticket_reference') or char_length(trim(coalesce(p_evidence->>'ticket_reference', ''))) = 0 then
      return jsonb_build_object('success', false, 'error', 'MISSING_OPERATOR_TICKET_REFERENCE');
    end if;
  end if;

  -- 9. Sanitize reason code
  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);

  -- 10. Atomic transition to FAILED or CANCELLED
  update public.payment_intents
  set status = v_clean_status,
      reconciliation_reason = v_sanitized_reason,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- 11. Audit event logging
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
