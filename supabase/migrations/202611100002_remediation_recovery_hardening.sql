-- PayRoost Phase 3B.4.4.1: Payment Operations Recovery Remediation Hardening
--
-- Forward-only remediation addressing findings AUDIT-3B44-01 through AUDIT-3B44-04:
-- 1. Hardens admin_resolve_reconciliation_without_payment() to completely remove the
--    unverified caller-supplied MANUAL_OPERATOR_VERIFICATION evidence type (AUDIT-3B44-01).
-- 2. Adds signature_verified column to public.provider_webhook_events with index (AUDIT-3B44-02).
-- 3. Introduces public.admin_reprocess_webhook_event() RPC committing webhook status updates
--    and activity_events audit records atomically in a single database transaction (AUDIT-3B44-02, AUDIT-3B44-04).
-- 4. Re-enforces strict service_role dual-layer authorization with JSON claims fallback across all functions.

-- ============================================================================
-- 1. ADD SIGNATURE_VERIFIED COLUMN TO PROVIDER_WEBHOOK_EVENTS
-- ============================================================================

alter table public.provider_webhook_events
  add column if not exists signature_verified boolean not null default false;

create index if not exists provider_webhook_events_verification_idx
  on public.provider_webhook_events(signature_verified, status);

-- ============================================================================
-- 2. HARDENED ADMIN_RESOLVE_RECONCILIATION_WITHOUT_PAYMENT RPC
-- ============================================================================
-- Removes MANUAL_OPERATOR_VERIFICATION to ensure caller-supplied text can never
-- bypass authoritative provider verification or cancel an unresolved ghost order.

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

  -- 7. Completed-Capture Guard (Critical Financial Safety)
  if exists (
    select 1
    from public.payment_transactions pt
    where pt.payment_intent_id = v_intent.id
      and pt.transaction_type = 'CAPTURE'
      and pt.status = 'COMPLETED'
    for update
  ) then
    return jsonb_build_object('success', false, 'error', 'COMPLETED_CAPTURE_EXISTS');
  end if;

  -- 8. Authoritative Provider Evidence Validation
  -- Strictly only accepts provider-verified evidence types:
  -- ORDER_NOT_FOUND_ON_PROVIDER or ORDER_VERIFIED_INACTIVE.
  -- Caller-supplied MANUAL_OPERATOR_VERIFICATION is strictly rejected.
  v_evidence_type := upper(trim(coalesce(p_evidence->>'evidence_type', '')));
  v_confirmed_by := trim(coalesce(p_evidence->>'confirmed_by', ''));

  if v_evidence_type not in ('ORDER_NOT_FOUND_ON_PROVIDER', 'ORDER_VERIFIED_INACTIVE') then
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
        'error', 'ORDER_NOT_INACTIVE_ON_PROVIDER',
        'provider_order_status', v_order_status
      );
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

  -- 11. Atomic audit event logging
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    'payment.reconciliation_resolved_without_payment',
    'Payment intent ' || v_intent.id::text || ' resolved to ' || v_clean_status || ' without payment: ' || v_sanitized_reason,
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'previousStatus', v_intent.status,
      'newStatus', v_clean_status,
      'reasonCode', v_sanitized_reason,
      'evidence', p_evidence,
      'notes', p_notes,
      'actor', v_actor
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

-- ============================================================================
-- 3. ATOMIC WEBHOOK REPROCESSING & AUDIT RPC
-- ============================================================================
-- Commits provider_webhook_events status updates and activity_events audit records
-- atomically in a single database transaction. Fails closed if event is unverified.

create or replace function public.admin_reprocess_webhook_event(
  p_webhook_event_id uuid,
  p_payment_intent_id uuid,
  p_status text,
  p_error_details text default null,
  p_actor text default 'system_reconciliation_service'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.provider_webhook_events%rowtype;
  v_intent public.payment_intents%rowtype;
  v_clean_status text;
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

  if p_webhook_event_id is null or p_payment_intent_id is null or p_status is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_status := upper(trim(p_status));
  if v_clean_status not in ('PROCESSED', 'FAILED', 'RETRY') then
    return jsonb_build_object('success', false, 'error', 'INVALID_STATUS', 'status', v_clean_status);
  end if;

  -- 2. Lock and fetch webhook event
  select * into v_event
  from public.provider_webhook_events
  where id = p_webhook_event_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'WEBHOOK_EVENT_NOT_FOUND');
  end if;

  -- 3. Lock and fetch payment intent for project attribution
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 4. Fail closed: Unverified webhook events cannot be processed
  if not v_event.signature_verified then
    return jsonb_build_object('success', false, 'error', 'UNVERIFIED_WEBHOOK_EVENT');
  end if;

  v_actor := substr(trim(coalesce(p_actor, 'system_reconciliation_service')), 1, 100);

  -- 5. Update webhook event status atomically
  update public.provider_webhook_events
  set status = v_clean_status,
      processed_at = case when v_clean_status = 'PROCESSED' then now() else processed_at end,
      error_details = p_error_details,
      lease_expires_at = null
  where id = v_event.id;

  -- 6. Atomic audit event logging
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    'payment.webhook_reprocessed',
    'Operator reprocessed webhook event ' || v_event.provider_event_id || ' with status ' || v_clean_status,
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'webhookEventId', v_event.id,
      'providerEventId', v_event.provider_event_id,
      'eventType', v_event.event_type,
      'status', v_clean_status,
      'errorDetails', p_error_details,
      'actor', v_actor
    )
  );

  return jsonb_build_object(
    'success', true,
    'webhook_event_id', v_event.id,
    'payment_intent_id', v_intent.id,
    'status', v_clean_status
  );
end;
$$;

revoke all on function public.admin_reprocess_webhook_event(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_reprocess_webhook_event(uuid, uuid, text, text, text) to service_role;
