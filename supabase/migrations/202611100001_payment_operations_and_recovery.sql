-- PayRoost Phase 3B.4.4: Payment Recovery & Operations Hardening
--
-- Enhancements:
-- 1. Hardens protect_payment_intent_immutability() to permit ORDER_CREATED -> RECONCILIATION_REQUIRED
--    and BUYER_APPROVED -> RECONCILIATION_REQUIRED transitions under authorized administrative reconciliation.
-- 2. Hardens admin_mark_intent_reconciliation_required() with dual-layer service_role authorization
--    (including request.jwt.claims JSON fallback), audit logging into activity_events, and actor attribution.
-- 3. Introduces admin_clear_expired_lease() for safe recovery of intents stranded in ORDER_CREATING or
--    CAPTURING with expired worker leases, setting RECONCILIATION_REQUIRED, clearing lease tokens, and
--    recording durable audit events into activity_events.

-- ============================================================================
-- 1. DROP PREVIOUS OVERLOADS
-- ============================================================================

drop function if exists public.admin_mark_intent_reconciliation_required(uuid, text);
drop function if exists public.admin_clear_expired_lease(uuid, text);

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
      -- Dual-Layer Check: Caller must be a trusted service role or superuser
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
    elsif old.status = 'ORDER_CREATED' and new.status not in ('BUYER_APPROVED', 'CAPTURING', 'CANCELLED', 'RECONCILIATION_REQUIRED') then
      raise exception 'Invalid transition from ORDER_CREATED to %', new.status;
    elsif old.status = 'BUYER_APPROVED' and new.status not in ('CAPTURING', 'CANCELLED', 'RECONCILIATION_REQUIRED') then
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
-- 3. HARDENED ADMIN_MARK_INTENT_RECONCILIATION_REQUIRED RPC
-- ============================================================================

create or replace function public.admin_mark_intent_reconciliation_required(
  p_payment_intent_id uuid,
  p_reason_code text,
  p_actor text default 'system_reconciliation_service'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_sanitized_reason text;
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

  if p_payment_intent_id is null or p_reason_code is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  -- 2. Set reconciliation active flag for trigger bypass
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 3. Lock intent row
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 4. Terminal states cannot be marked reconciliation required
  if v_intent.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- 5. Concurrency: Reject if an active worker holds an unexpired order creation lease
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'ORDER_CREATION',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  -- 6. Concurrency: Reject if an active worker holds an unexpired capture lease
  if v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_type', 'CAPTURE',
      'lease_expires_at', v_intent.capture_lease_expires_at
    );
  end if;

  v_actor := substr(trim(coalesce(p_actor, 'system_reconciliation_service')), 1, 100);
  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);

  -- 7. Update status and clear leases
  update public.payment_intents
  set status = 'RECONCILIATION_REQUIRED',
      reconciliation_reason = v_sanitized_reason,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- 8. Durable audit event logging
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    'payment.marked_reconciliation_required',
    'Payment intent ' || v_intent.id::text || ' marked RECONCILIATION_REQUIRED: ' || v_sanitized_reason,
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'previousStatus', v_intent.status,
      'newStatus', 'RECONCILIATION_REQUIRED',
      'reasonCode', v_sanitized_reason,
      'providerOrderId', v_intent.provider_order_id,
      'actor', v_actor
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'milestone_id', v_intent.milestone_id,
    'previous_status', v_intent.status,
    'status', 'RECONCILIATION_REQUIRED',
    'reason_code', v_sanitized_reason
  );
end;
$$;

revoke all on function public.admin_mark_intent_reconciliation_required(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_mark_intent_reconciliation_required(uuid, text, text) to service_role;

-- ============================================================================
-- 4. ADMIN_CLEAR_EXPIRED_LEASE RPC
-- ============================================================================

create or replace function public.admin_clear_expired_lease(
  p_payment_intent_id uuid,
  p_actor text default 'system_reconciliation_service'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_actor text;
  v_has_expired_creation boolean;
  v_has_expired_capture boolean;
  v_target_status text;
  v_reason text;
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

  if p_payment_intent_id is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  -- 2. Privileged reconciliation active
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 3. Lock intent
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 4. Terminal status check
  if v_intent.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- 5. Verify lease expiry
  v_has_expired_creation := (
    v_intent.order_creation_lease_expires_at is not null
    and v_intent.order_creation_lease_expires_at <= clock_timestamp()
  );

  v_has_expired_capture := (
    v_intent.capture_lease_expires_at is not null
    and v_intent.capture_lease_expires_at <= clock_timestamp()
  );

  -- Check if an active unexpired lease is currently held
  if (v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp()) or
     (v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > clock_timestamp()) then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'creation_lease_expires_at', v_intent.order_creation_lease_expires_at,
      'capture_lease_expires_at', v_intent.capture_lease_expires_at
    );
  end if;

  if not v_has_expired_creation and not v_has_expired_capture then
    return jsonb_build_object('success', false, 'error', 'NO_EXPIRED_LEASE_FOUND');
  end if;

  v_actor := substr(trim(coalesce(p_actor, 'system_reconciliation_service')), 1, 100);

  -- 6. Determine target status
  if v_intent.status = 'ORDER_CREATING' then
    v_target_status := 'RECONCILIATION_REQUIRED';
    v_reason := 'EXPIRED_ORDER_CREATION_LEASE_CLEARED';
  elsif v_intent.status = 'CAPTURING' then
    v_target_status := 'RECONCILIATION_REQUIRED';
    v_reason := 'EXPIRED_CAPTURE_LEASE_CLEARED';
  else
    v_target_status := v_intent.status;
    v_reason := 'EXPIRED_LEASE_TOKENS_CLEARED';
  end if;

  -- 7. Update intent
  update public.payment_intents
  set status = v_target_status,
      reconciliation_reason = coalesce(v_reason, reconciliation_reason),
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- 8. Audit event
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    'payment.expired_lease_cleared',
    'Cleared expired lease tokens for payment intent ' || v_intent.id::text || ' (transitioned to ' || v_target_status || ')',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'previousStatus', v_intent.status,
      'newStatus', v_target_status,
      'reasonCode', v_reason,
      'actor', v_actor,
      'clearedCreationLease', v_has_expired_creation,
      'clearedCaptureLease', v_has_expired_capture
    )
  );

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'previous_status', v_intent.status,
    'status', v_target_status,
    'reason_code', v_reason
  );
end;
$$;

revoke all on function public.admin_clear_expired_lease(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_clear_expired_lease(uuid, text) to service_role;
