-- PayRoost Phase 3B.4.1.2 Remediation: Server-Side PayPal Order Creation, Lease Fencing and Idempotency RPCs
--
-- Objectives:
-- 1. Schema Extensions: Adds order_creation_lease_token (UUID fencing token) and reconciliation_reason (text) to payment_intents.
-- 2. claim_order_creation_lease: Atomically claims the order creation lease on an existing
--    ORDER_CREATING payment intent using row-level locking (FOR UPDATE). Generates a fresh
--    cryptographically secure fencing token (UUID) returned only to the claiming worker.
-- 3. release_order_creation_lease: Fenced lease release. Validates session/project binding and asserts
--    that the caller holds the matching lease_token before clearing the lease, preventing stale workers
--    from wiping out a newer worker's renewed lease.
-- 4. record_paypal_order_created: Fenced order recording. Validates session/project binding, expected merchant ID,
--    and matching lease_token before transitioning intent to ORDER_CREATED.
-- 5. mark_intent_reconciliation_required: Safely transitions intent to RECONCILIATION_REQUIRED, persisting
--    a bounded, sanitized reconciliation_reason and clearing any active lease.
-- 6. Privilege Lockdown: Restrict all functions strictly to service_role with SECURITY DEFINER and search_path = ''.

-- 1. Schema Extensions
alter table public.payment_intents
  add column if not exists order_creation_lease_token uuid,
  add column if not exists reconciliation_reason text;

-- 2. Atomically Claim Order Creation Lease with Fencing Token
create or replace function public.claim_order_creation_lease(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_seconds integer default 45
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_lease_token uuid;
begin
  -- Validate arguments
  if p_session_token_hash is null or p_payment_intent_id is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
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

  -- 4. Check if already created (safe idempotency return)
  if v_intent.status = 'ORDER_CREATED' and v_intent.provider_order_id is not null then
    return jsonb_build_object(
      'success', true,
      'already_created', true,
      'payment_intent_id', v_intent.id,
      'provider_order_id', v_intent.provider_order_id,
      'status', v_intent.status
    );
  end if;

  -- 5. Check eligibility: must be ORDER_CREATING
  if v_intent.status <> 'ORDER_CREATING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INELIGIBLE_STATUS',
      'status', v_intent.status
    );
  end if;

  -- 6. Check active lease for concurrency protection
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > now() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  -- 7. Generate fresh cryptographically random lease fencing token
  v_lease_token := gen_random_uuid();

  -- 8. Grant/renew lease and assign fencing token
  update public.payment_intents
  set order_creation_lease_expires_at = now() + (greatest(10, least(p_lease_seconds, 120)) || ' seconds')::interval,
      order_creation_lease_token = v_lease_token,
      updated_at = now()
  where id = v_intent.id;

  -- Renew session activity
  update public.client_portal_sessions
  set last_active_at = now()
  where id = v_session.id;

  return jsonb_build_object(
    'success', true,
    'claimed', true,
    'lease_token', v_lease_token,
    'payment_intent_id', v_intent.id,
    'milestone_id', v_intent.milestone_id,
    'project_id', v_intent.project_id,
    'expected_merchant_id', v_intent.expected_merchant_id,
    'order_idempotency_key', v_intent.order_idempotency_key,
    'canonical_payload', v_intent.canonical_payload_json
  );
end;
$$;

revoke all on function public.claim_order_creation_lease(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_order_creation_lease(text, uuid, integer) to service_role;

-- 3. Fenced Release of Order Creation Lease
create or replace function public.release_order_creation_lease(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
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

  -- Assert caller holds the active fencing token
  if v_intent.order_creation_lease_token is distinct from p_lease_token then
    return jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'STALE_LEASE_TOKEN'
    );
  end if;

  if v_intent.status = 'ORDER_CREATING' then
    update public.payment_intents
    set order_creation_lease_expires_at = null,
        order_creation_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    return jsonb_build_object('success', true, 'released', true);
  end if;

  return jsonb_build_object('success', true, 'released', false);
end;
$$;

revoke all on function public.release_order_creation_lease(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_order_creation_lease(text, uuid, uuid) to service_role;

-- 4. Fenced Atomic Recording of Created PayPal Order
create or replace function public.record_paypal_order_created(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_token uuid,
  p_provider_order_id text,
  p_expected_merchant_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_clean_order_id text;
begin
  if p_session_token_hash is null or p_payment_intent_id is null or p_lease_token is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_order_id := trim(coalesce(p_provider_order_id, ''));
  if char_length(v_clean_order_id) < 1 or char_length(v_clean_order_id) > 64 then
    return jsonb_build_object('success', false, 'error', 'INVALID_ORDER_ID');
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

  -- 4. Verify expected merchant matches
  if trim(p_expected_merchant_id) <> v_intent.expected_merchant_id then
    return jsonb_build_object('success', false, 'error', 'MERCHANT_MISMATCH');
  end if;

  -- 5. Idempotent check: if already ORDER_CREATED with this exact provider order ID
  if v_intent.status = 'ORDER_CREATED' and v_intent.provider_order_id = v_clean_order_id then
    return jsonb_build_object(
      'success', true,
      'already_recorded', true,
      'payment_intent_id', v_intent.id,
      'provider_order_id', v_intent.provider_order_id,
      'status', 'ORDER_CREATED'
    );
  end if;

  -- 6. Must be in ORDER_CREATING to transition to ORDER_CREATED
  if v_intent.status <> 'ORDER_CREATING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'status', v_intent.status
    );
  end if;

  -- 7. Fencing token validation: caller must hold active lease token
  if v_intent.order_creation_lease_token is distinct from p_lease_token then
    return jsonb_build_object(
      'success', false,
      'error', 'STALE_LEASE_TOKEN'
    );
  end if;

  -- 8. Provider order ID must not already be set to something else
  if v_intent.provider_order_id is not null and v_intent.provider_order_id <> v_clean_order_id then
    return jsonb_build_object('success', false, 'error', 'ORDER_ID_CONFLICT');
  end if;

  -- 9. Update intent to ORDER_CREATED, clear lease and token
  update public.payment_intents
  set provider_order_id = v_clean_order_id,
      status = 'ORDER_CREATED',
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- Renew session activity
  update public.client_portal_sessions
  set last_active_at = now()
  where id = v_session.id;

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'provider_order_id', v_clean_order_id,
    'status', 'ORDER_CREATED'
  );
end;
$$;

revoke all on function public.record_paypal_order_created(text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_paypal_order_created(text, uuid, uuid, text, text) to service_role;

-- 5. Mark Intent Reconciliation Required (Persisting Bounded Reason)
create or replace function public.mark_intent_reconciliation_required(
  p_payment_intent_id uuid,
  p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_sanitized_reason text;
begin
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  if v_intent.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object('success', false, 'error', 'TERMINAL_STATE');
  end if;

  v_sanitized_reason := substr(trim(coalesce(p_reason, 'Unspecified reconciliation reason')), 1, 500);

  update public.payment_intents
  set status = 'RECONCILIATION_REQUIRED',
      reconciliation_reason = v_sanitized_reason,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  return jsonb_build_object(
    'success', true,
    'payment_intent_id', v_intent.id,
    'status', 'RECONCILIATION_REQUIRED',
    'reason', v_sanitized_reason
  );
end;
$$;

revoke all on function public.mark_intent_reconciliation_required(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_intent_reconciliation_required(uuid, text) to service_role;
