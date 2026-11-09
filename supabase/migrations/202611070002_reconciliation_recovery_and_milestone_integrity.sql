-- PayRoost Phase 3B.4.1.4 Remediation: Reconciliation Recovery and Milestone Payment Lifecycle Integrity
--
-- Objectives:
-- 1. Milestone Payment-Invariant Trigger Hardening (F-01):
--    Updates protect_milestone_payment_invariants() so milestones associated with payment intents
--    in RECONCILIATION_REQUIRED cannot be deleted, cancelled, or have their financial attributes
--    modified while an ambiguous provider transaction is under review.
-- 2. Payment Intent Immutability Update (F-02):
--    Updates protect_payment_intent_immutability() so that under privileged reconciliation
--    (payroost.reconciliation_active = 'true'), intents in RECONCILIATION_REQUIRED can transition
--    to COMPLETED, FAILED, or CANCELLED, but never to unapproved states.
-- 3. Administrative Reconciliation Recovery RPC (F-02):
--    Implements admin_resolve_reconciliation_without_payment(...) allowing authorized service-role
--    personnel to transition RECONCILIATION_REQUIRED intents to FAILED or CANCELLED with authoritative
--    PayPal provider evidence, unblocking the milestone partial unique index while logging full audit events.
-- 4. Access Lockdown:
--    Restricts all privileged execution strictly to service_role with SECURITY DEFINER and search_path = ''.

-- ============================================================================
-- 1. HARDENED MILESTONE PAYMENT COORDINATION TRIGGER (F-01)
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
        status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')
        or (status = 'ORDER_CREATING' and order_creation_lease_expires_at is not null and order_creation_lease_expires_at > clock_timestamp())
      );

    if v_active_intent_count > 0 then
      raise exception 'Milestone % cannot be deleted while an active payment intent, reconciliation, or order-creation lease exists', old.id;
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
          status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')
          or (status = 'ORDER_CREATING' and order_creation_lease_expires_at is not null and order_creation_lease_expires_at > clock_timestamp())
        );

      if v_active_intent_count > 0 then
        if new.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED') then
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

drop trigger if exists milestones_protect_payment_invariants on public.milestones;
create trigger milestones_protect_payment_invariants
  before update or delete on public.milestones
  for each row execute procedure public.protect_milestone_payment_invariants();

-- ============================================================================
-- 2. UPDATED PAYMENT INTENT IMMUTABILITY & TRANSITION TRIGGER (F-02)
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
      if current_setting('payroost.reconciliation_active', true) is distinct from 'true' then
        raise exception 'Payment intent in RECONCILIATION_REQUIRED cannot transition without privileged intervention';
      end if;
      if new.status not in ('COMPLETED', 'FAILED', 'CANCELLED') then
        raise exception 'Payment intent in RECONCILIATION_REQUIRED can only transition to COMPLETED, FAILED, or CANCELLED via privileged reconciliation';
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
-- 3. ADMINISTRATIVE RECONCILIATION RECOVERY RPC (WITHOUT PAYMENT) (F-02)
-- ============================================================================

create or replace function public.admin_resolve_reconciliation_without_payment(
  p_intent_id uuid,
  p_target_status text,
  p_reason_code text,
  p_evidence jsonb,
  p_notes text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_sanitized_reason text;
  v_clean_status text;
  v_evidence_type text;
  v_confirmed_by text;
  v_order_status text;
begin
  -- 1. Enable privileged reconciliation transaction flag
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 2. Validate mandatory input arguments
  if p_intent_id is null or p_target_status is null or p_reason_code is null or p_evidence is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_status := upper(trim(p_target_status));
  if v_clean_status not in ('FAILED', 'CANCELLED') then
    return jsonb_build_object('success', false, 'error', 'INVALID_TARGET_STATUS', 'target_status', v_clean_status);
  end if;

  -- 3. Row lock payment intent
  select * into v_intent
  from public.payment_intents
  where id = p_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 4. Initial state must strictly be RECONCILIATION_REQUIRED
  if v_intent.status <> 'RECONCILIATION_REQUIRED' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_INITIAL_STATUS',
      'current_status', v_intent.status
    );
  end if;

  -- 5. Concurrency protection: Reject if an active worker lease is running
  if v_intent.order_creation_lease_expires_at is not null and v_intent.order_creation_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'lease_expires_at', v_intent.order_creation_lease_expires_at
    );
  end if;

  -- 6. Financial ledger protection: If a completed capture exists, reject without-payment resolution
  if exists (
    select 1 from public.payment_transactions
    where payment_intent_id = v_intent.id
      and status = 'COMPLETED'
  ) then
    return jsonb_build_object('success', false, 'error', 'COMPLETED_CAPTURE_EXISTS');
  end if;

  -- 7. Controlled sanitization of reason code (strictly uppercase alphanumeric and underscore, max 64 chars)
  v_sanitized_reason := regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g');
  v_sanitized_reason := substr(v_sanitized_reason, 1, 64);
  if char_length(v_sanitized_reason) = 0 then
    return jsonb_build_object('success', false, 'error', 'INVALID_REASON_CODE');
  end if;

  -- 8. Authoritative Provider Evidence Validation
  if jsonb_typeof(p_evidence) <> 'object' then
    return jsonb_build_object('success', false, 'error', 'INVALID_EVIDENCE_FORMAT');
  end if;

  v_evidence_type := upper(trim(coalesce(p_evidence->>'evidence_type', '')));
  v_confirmed_by := trim(coalesce(p_evidence->>'confirmed_by', ''));

  if char_length(v_evidence_type) = 0 or char_length(v_confirmed_by) = 0 then
    return jsonb_build_object('success', false, 'error', 'INCOMPLETE_EVIDENCE_METADATA');
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

  -- 9. Atomic state transition and lease clearing
  update public.payment_intents
  set status = v_clean_status,
      reconciliation_reason = v_sanitized_reason,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  -- 10. Audit Activity Logging
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    'System Admin',
    case when v_clean_status = 'CANCELLED' then 'payment.reconciliation_cancelled' else 'payment.reconciliation_failed' end,
    'Payment intent ' || v_intent.id::text || ' resolved to ' || v_clean_status || ' via administrative reconciliation (' || v_sanitized_reason || ')',
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
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

revoke all on function public.admin_resolve_reconciliation_without_payment(uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.admin_resolve_reconciliation_without_payment(uuid, text, text, jsonb, text) to service_role;
