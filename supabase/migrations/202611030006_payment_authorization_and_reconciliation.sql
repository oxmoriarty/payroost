-- Payroost Phase 3A.1.2: Payment Authorization and Reconciliation Recovery
-- Enforces:
-- 1. Complete revocation of public, anon, and authenticated execution on legacy create_payment_intent.
-- 2. New create_client_payment_intent RPC requiring an active, unexpired, unrevoked client portal session
--    hash strictly bound to the milestone's project and current verified client email.
-- 3. Dedicated create_sandbox_demo_payment_intent RPC strictly restricted to authenticated project owners.
-- 4. Updating protect_payment_intent_immutability and validate_payment_transaction_insert to allow
--    controlled transition from RECONCILIATION_REQUIRED to COMPLETED strictly when
--    transaction-local setting payroost.reconciliation_active is 'true'.
-- 5. Privileged reconcile_and_complete_payment_intent RPC with deep capture payload verification,
--    order linkage, ledger append-only idempotency, and audit event logging.
-- 6. Strict privilege lockdown ensuring recovery and client intent RPCs are accessible only to authorized roles.

-- ============================================================================
-- 1. REVOKE PUBLIC ACCESS ON LEGACY CREATE_PAYMENT_INTENT
-- ============================================================================

revoke all on function public.create_payment_intent(uuid, text, uuid, uuid, jsonb, boolean) from public, anon, authenticated;

-- ============================================================================
-- 2. CLIENT-SESSION AUTHORIZED PAYMENT INTENT CREATION RPC
-- ============================================================================

create or replace function public.create_client_payment_intent(
  p_session_token_hash text,
  p_milestone_id uuid,
  p_expected_merchant_id text,
  p_order_idempotency_key uuid,
  p_capture_idempotency_key uuid,
  p_canonical_payload jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_milestone public.milestones%rowtype;
  v_project public.projects%rowtype;
  v_agreement_version public.agreement_versions%rowtype;
  v_canonical_amount text;
  v_intent_id uuid;
begin
  -- 1. Lock and validate milestone
  select * into v_milestone from public.milestones where id = p_milestone_id for update;
  if not found then
    raise exception 'Milestone not found';
  end if;

  -- 2. Lock and validate project
  select * into v_project from public.projects where id = v_milestone.project_id for update;
  if not found then
    raise exception 'Project not found';
  end if;

  -- 3. Lock and validate client portal session
  select * into v_session
  from public.client_portal_sessions
  where session_token_hash = p_session_token_hash
  for update;

  if not found or v_session.revoked_at is not null then
    raise exception 'Unauthorized: Client portal session is invalid or revoked';
  end if;

  if now() >= v_session.expires_at then
    raise exception 'Unauthorized: Client portal session has expired (absolute timeout)';
  end if;

  if now() >= v_session.last_active_at + interval '60 minutes' then
    raise exception 'Unauthorized: Client portal session has expired (idle timeout)';
  end if;

  -- Verify session belongs to the milestone's project
  if v_session.project_id <> v_milestone.project_id then
    raise exception 'Forbidden: Client portal session does not belong to this project';
  end if;

  -- Verify project has verified client email matching session
  if v_project.client_email_verified_at is null then
    raise exception 'Forbidden: Project client email is not verified';
  end if;

  if v_project.client_email <> v_session.client_email then
    raise exception 'Forbidden: Client email has changed since session issuance';
  end if;

  -- 4. Check milestone payable status
  if v_milestone.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED') then
    raise exception 'Milestone status % is not payable; must be APPROVED, IN_PROGRESS, or SUBMITTED', v_milestone.status;
  end if;

  -- 5. Lock and verify approved agreement version
  select * into v_agreement_version from public.agreement_versions where id = v_milestone.agreement_version_id for update;
  if not found or v_agreement_version.status <> 'APPROVED' then
    raise exception 'Milestone does not belong to an approved agreement version';
  end if;

  -- 6. Currency and amount validations
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

  -- 7. Insert payment intent
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
    false,
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

  -- Renew session activity
  update public.client_portal_sessions
  set last_active_at = now()
  where id = v_session.id;

  return v_intent_id;
end;
$$;

-- Restrict execution strictly to service_role (privileged backend)
revoke all on function public.create_client_payment_intent(text, uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- ============================================================================
-- 3. DEDICATED OWNER-ONLY SANDBOX DEMONSTRATION RPC
-- ============================================================================

create or replace function public.create_sandbox_demo_payment_intent(
  p_milestone_id uuid,
  p_expected_merchant_id text,
  p_order_idempotency_key uuid,
  p_capture_idempotency_key uuid,
  p_canonical_payload jsonb
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

  -- Strict Owner Authorization Check
  if auth.uid() is null or v_project.owner_id <> auth.uid() then
    raise exception 'Forbidden: Only the authenticated project owner can create sandbox demo payment intents';
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

  -- USD only
  if v_milestone.currency <> 'USD' then
    raise exception 'Currency % is unsupported; only USD is accepted in Phase 3A', v_milestone.currency;
  end if;

  if v_milestone.amount_minor <= 0 then
    raise exception 'Milestone amount must be strictly positive';
  end if;

  if char_length(trim(p_expected_merchant_id)) < 3 or char_length(trim(p_expected_merchant_id)) > 64 then
    raise exception 'Invalid expected merchant ID';
  end if;

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
    true,
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

revoke all on function public.create_sandbox_demo_payment_intent(uuid, text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_sandbox_demo_payment_intent(uuid, text, uuid, uuid, jsonb) to authenticated;

-- ============================================================================
-- 4. UPDATE TRIGGERS TO SUPPORT CONTROLLED PRIVILEGED RECONCILIATION
-- ============================================================================

-- Update protect_payment_intent_immutability to allow RECONCILIATION_REQUIRED -> COMPLETED
-- strictly when transaction-local payroost.reconciliation_active is 'true'
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
      if new.status <> 'COMPLETED' then
        raise exception 'Payment intent in RECONCILIATION_REQUIRED can only transition to COMPLETED via privileged reconciliation';
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

-- Update validate_payment_transaction_insert to permit insertion when intent is in RECONCILIATION_REQUIRED
-- strictly during authorized privileged reconciliation
create or replace function public.validate_payment_transaction_insert()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_parent public.payment_transactions%rowtype;
  v_existing_refunds bigint;
begin
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

    -- Allow insertion when intent is in CAPTURING, RECONCILING, or COMPLETED (idempotent),
    -- OR RECONCILIATION_REQUIRED strictly when privileged reconciliation is active.
    if v_intent.status not in ('CAPTURING', 'RECONCILING', 'COMPLETED') then
      if v_intent.status = 'RECONCILIATION_REQUIRED' and current_setting('payroost.reconciliation_active', true) = 'true' then
        null; -- Permitted under active privileged reconciliation
      else
        raise exception 'Cannot record capture for intent in status %', v_intent.status;
      end if;
    end if;

  -- 2. Refund / Reversal transaction validation
  elsif new.transaction_type in ('REFUND', 'REVERSAL') then
    if new.parent_transaction_id is null then
      raise exception 'Refund or reversal must reference a valid parent capture transaction';
    end if;

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

-- ============================================================================
-- 5. PRIVILEGED RECONCILIATION RECOVERY RPC
-- ============================================================================

create or replace function public.reconcile_and_complete_payment_intent(
  p_intent_id uuid,
  p_provider_capture_id text,
  p_amount_cents bigint,
  p_payee_merchant_id text,
  p_raw_response jsonb,
  p_resolution_notes text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
begin
  -- Set transaction-local flag so triggers permit the authorized recovery transition
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 1. Lock payment intent row
  select * into v_intent
  from public.payment_intents
  where id = p_intent_id
  for update;

  if not found then
    raise exception 'Payment intent not found';
  end if;

  -- 2. Idempotency Check: If already completed with this exact capture, return true
  if v_intent.status = 'COMPLETED' then
    if exists (
      select 1 from public.payment_transactions
      where payment_intent_id = p_intent_id
        and provider_reference_id = trim(p_provider_capture_id)
        and transaction_type = 'CAPTURE'
        and status = 'COMPLETED'
    ) then
      return true; -- Idempotent success
    else
      raise exception 'Payment intent is already COMPLETED with a different capture reference';
    end if;
  end if;

  -- 3. Recovery Eligibility Guard: Must be in RECONCILIATION_REQUIRED
  if v_intent.status <> 'RECONCILIATION_REQUIRED' then
    raise exception 'Intent status % is not eligible for reconciliation recovery; must be RECONCILIATION_REQUIRED', v_intent.status;
  end if;

  -- 4. Environment & Provider Guards
  if v_intent.provider <> 'PAYPAL' then
    raise exception 'Payment intent provider must be PAYPAL';
  end if;

  if v_intent.environment <> 'SANDBOX' then
    raise exception 'Payment intent environment must be SANDBOX in this phase';
  end if;

  -- 5. Capture ID validation
  if char_length(trim(p_provider_capture_id)) < 3 then
    raise exception 'Invalid provider capture ID';
  end if;

  -- Check global capture reference uniqueness across other payment intents
  if exists (
    select 1 from public.payment_transactions
    where provider_reference_id = trim(p_provider_capture_id)
      and payment_intent_id <> p_intent_id
  ) then
    raise exception 'Provider capture ID % is already associated with another payment intent', p_provider_capture_id;
  end if;

  -- 6. Authoritative Capture Status Validation (must be COMPLETED)
  if coalesce(p_raw_response->>'status', '') <> 'COMPLETED' then
    raise exception 'Authoritative PayPal capture status must be COMPLETED, received %', p_raw_response->>'status';
  end if;

  -- 7. Order Linkage Verification (if supplementary data or purchase units contain order_id)
  if v_intent.provider_order_id is not null then
    if p_raw_response ? 'supplementary_data' and (p_raw_response->'supplementary_data'->'related_ids' ? 'order_id') then
      if (p_raw_response->'supplementary_data'->'related_ids'->>'order_id') <> v_intent.provider_order_id then
        raise exception 'Capture related order ID % does not match intent provider order ID %',
          p_raw_response->'supplementary_data'->'related_ids'->>'order_id', v_intent.provider_order_id;
      end if;
    end if;
  end if;

  -- 8. Exact Financial and Identity Validations
  if p_amount_cents <> v_intent.expected_amount_cents then
    raise exception 'Capture amount % does not match expected intent amount %', p_amount_cents, v_intent.expected_amount_cents;
  end if;

  if trim(p_payee_merchant_id) <> v_intent.expected_merchant_id then
    raise exception 'Capture payee merchant ID % does not match expected merchant ID %', p_payee_merchant_id, v_intent.expected_merchant_id;
  end if;

  -- 9. Insert verified capture into append-only ledger
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

  -- 10. Atomically update intent status to COMPLETED
  update public.payment_intents
  set status = 'COMPLETED',
      completed_at = now(),
      capture_lease_expires_at = null
  where id = p_intent_id;

  -- 11. Record audit activity event
  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    'System',
    'payment.reconciliation_completed',
    'Payment of $' || v_intent.expected_amount_canonical || ' recovered and completed via verified reconciliation',
    jsonb_build_object(
      'paymentIntentId', p_intent_id,
      'providerCaptureId', trim(p_provider_capture_id),
      'notes', p_resolution_notes
    )
  );

  return true;
end;
$$;

-- Restrict privileged reconciliation RPC strictly to service_role
revoke all on function public.reconcile_and_complete_payment_intent(uuid, text, bigint, text, jsonb, text) from public, anon, authenticated;
