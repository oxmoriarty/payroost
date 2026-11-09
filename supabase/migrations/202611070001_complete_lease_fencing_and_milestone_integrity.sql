-- PayRoost Phase 3B.4.1.3: Complete Lease Fencing, Milestone Integrity and Idempotency Safety
--
-- Objectives:
-- 1. Milestone Coordination Trigger: Enforces durable database invariant preventing cancellation,
--    deletion, or financial modification of a milestone while an active order-creation lease or payment intent is in progress.
-- 2. Fenced claim_order_creation_lease: Locks milestone FOR SHARE and validates payable status inside the claim transaction.
-- 3. Fenced mark_intent_reconciliation_required: Requires caller to prove active lease ownership via mandatory p_lease_token,
--    preventing stale workers from invalidating newer workers' leases or protected terminal states.
-- 4. Administrative admin_mark_intent_reconciliation_required: Dedicated service-role maintenance RPC for manual/operator
--    escalation when no active worker lease is running.
-- 5. Drop legacy unfenced mark_intent_reconciliation_required(uuid, text) overload.
-- 6. Grant execute permissions exclusively to service_role with empty safe search_path.

-- ============================================================================
-- 1. DURABLE MILESTONE PAYMENT COORDINATION TRIGGER
-- ============================================================================

create or replace function public.protect_milestone_payment_invariants()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_active_intent_count integer;
begin
  if tg_op = 'DELETE' then
    select count(*) into v_active_intent_count
    from public.payment_intents
    where milestone_id = old.id
      and (
        status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING')
        or (status = 'ORDER_CREATING' and order_creation_lease_expires_at is not null and order_creation_lease_expires_at > clock_timestamp())
      );

    if v_active_intent_count > 0 then
      raise exception 'Milestone % cannot be deleted while an active payment intent or order-creation lease exists', old.id;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Check if status or financial terms are being modified
    if (old.status is distinct from new.status) or
       (old.amount_minor is distinct from new.amount_minor) or
       (old.currency is distinct from new.currency) then

      select count(*) into v_active_intent_count
      from public.payment_intents
      where milestone_id = old.id
        and (
          status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING')
          or (status = 'ORDER_CREATING' and order_creation_lease_expires_at is not null and order_creation_lease_expires_at > clock_timestamp())
        );

      if v_active_intent_count > 0 then
        if new.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED') then
          raise exception 'Milestone % cannot be cancelled or moved to non-payable status % while an active payment operation or lease is in progress', old.id, new.status;
        end if;

        if (old.amount_minor is distinct from new.amount_minor) or (old.currency is distinct from new.currency) then
          raise exception 'Milestone % financial attributes (amount/currency) cannot be modified while an active payment operation or lease is in progress', old.id;
        end if;
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists milestones_protect_payment_invariants on public.milestones;
create trigger milestones_protect_payment_invariants
  before update or delete on public.milestones
  for each row execute procedure public.protect_milestone_payment_invariants();

-- ============================================================================
-- 2. UPDATED claim_order_creation_lease WITH MILESTONE LOCKING
-- ============================================================================

create or replace function public.claim_order_creation_lease(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_seconds integer default 45
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_milestone public.milestones%rowtype;
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

  -- 6. Lock and validate milestone payable status inside the claim transaction
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

  -- 7. Check active lease for concurrency protection
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > now() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  -- 8. Generate fresh cryptographically random lease fencing token
  v_lease_token := gen_random_uuid();

  -- 9. Grant/renew lease and assign fencing token
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

-- ============================================================================
-- 3. FENCED mark_intent_reconciliation_required (FOR IN-FLIGHT WORKERS)
-- ============================================================================

-- Drop the legacy unfenced 2-parameter function to eliminate any insecure call path
drop function if exists public.mark_intent_reconciliation_required(uuid, text);

create or replace function public.mark_intent_reconciliation_required(
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
  -- 1. Validate mandatory arguments
  if p_session_token_hash is null or p_payment_intent_id is null or p_lease_token is null or p_reason_code is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  -- 2. Lock and validate payment intent
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 3. Lock and validate session
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

  -- 4. Never downgrade protected terminal or successful states
  if v_intent.status in ('ORDER_CREATED', 'COMPLETED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- 5. Fencing validation: caller must strictly hold the active lease token
  if v_intent.order_creation_lease_token is distinct from p_lease_token then
    return jsonb_build_object(
      'success', false,
      'error', 'STALE_LEASE_TOKEN'
    );
  end if;

  -- 6. Must be in ORDER_CREATING state
  if v_intent.status <> 'ORDER_CREATING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- 7. Controlled sanitization of reason code (strictly uppercase alphanumeric and underscore)
  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);

  -- 8. Atomic transition and lease clearing
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
    'reason_code', v_sanitized_reason
  );
end;
$$;

revoke all on function public.mark_intent_reconciliation_required(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_intent_reconciliation_required(text, uuid, uuid, text) to service_role;

-- ============================================================================
-- 4. DEDICATED ADMINISTRATIVE RECONCILIATION RPC
-- ============================================================================

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

  -- If an active worker lease is held, reject admin intervention to prevent collision
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);

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
    'reason_code', v_sanitized_reason
  );
end;
$$;

revoke all on function public.admin_mark_intent_reconciliation_required(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_mark_intent_reconciliation_required(uuid, text) to service_role;
