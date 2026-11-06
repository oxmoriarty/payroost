-- PayRoost Phase 3B.3.1: Harden Canonical Payment-Intent Financial Invariants
--
-- Objectives:
-- 1. Strengthen create_client_payment_intent to validate that the canonical purchase unit
--    payload's amount, currency, and payee merchant ID independently agree with the locked
--    milestone and server expectation using exact integer cents (no floating-point arithmetic).
-- 2. Maintain strict single-purchase-unit contract (custom_id = intent UUID, reference_id = milestone ID).
-- 3. Maintain service-role-only execution boundary on create_client_payment_intent.
-- 4. Apply the identical financial validations to create_sandbox_demo_payment_intent for invariant consistency.
-- 5. Preserve the active payment intent partial unique index and state machine.
--    NOTE: Unsafe lease reaping is explicitly deferred to Phase 3B.4 order-creation recovery,
--    ensuring intents are never prematurely marked failed without checking provider state.

-- 1. Hardened create_client_payment_intent
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
  v_pu jsonb;
  v_custom_id_text text;
  v_ref_id_text text;
  v_pu_amount_val text;
  v_pu_amount_cents bigint;
  v_pu_currency text;
  v_pu_merchant_id text;
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

  if v_session.project_id <> v_milestone.project_id then
    raise exception 'Forbidden: Client portal session does not belong to this project';
  end if;

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

  v_canonical_amount := (v_milestone.amount_minor / 100)::text || '.' || lpad((v_milestone.amount_minor % 100)::text, 2, '0');

  -- 7. Validate Single Purchase-Unit Canonical Contract
  if p_canonical_payload is null or jsonb_typeof(p_canonical_payload) <> 'object' then
    raise exception 'Canonical payload must be a valid JSON object';
  end if;

  if not (p_canonical_payload ? 'purchase_units') or
     jsonb_typeof(p_canonical_payload->'purchase_units') <> 'array' then
    raise exception 'Canonical payload missing mandatory purchase_units array';
  end if;

  if jsonb_array_length(p_canonical_payload->'purchase_units') <> 1 then
    raise exception 'Canonical payload purchase_units must contain exactly 1 element, received %',
      jsonb_array_length(p_canonical_payload->'purchase_units');
  end if;

  v_pu := p_canonical_payload->'purchase_units'->0;

  if jsonb_typeof(v_pu) <> 'object' then
    raise exception 'Canonical payload purchase_units[0] must be a valid JSON object';
  end if;

  -- Validate custom_id matches a valid UUID (used as payment intent ID)
  v_custom_id_text := trim(coalesce(v_pu->>'custom_id', ''));
  if char_length(v_custom_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory custom_id';
  end if;

  begin
    v_intent_id := v_custom_id_text::uuid;
  exception when others then
    raise exception 'Canonical payload purchase_units[0].custom_id must be a valid UUID, received %', v_custom_id_text;
  end;

  -- Validate reference_id matches the milestone UUID
  v_ref_id_text := trim(coalesce(v_pu->>'reference_id', ''));
  if char_length(v_ref_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory reference_id';
  end if;

  if v_ref_id_text <> v_milestone.id::text then
    raise exception 'Canonical payload purchase_units[0].reference_id % does not match milestone ID %',
      v_ref_id_text, v_milestone.id::text;
  end if;

  -- Validate amount object and exact 2-decimal format
  if not (v_pu ? 'amount') or jsonb_typeof(v_pu->'amount') <> 'object' then
    raise exception 'Canonical payload purchase_units[0] missing mandatory amount object';
  end if;

  v_pu_amount_val := trim(coalesce(v_pu->'amount'->>'value', ''));
  if v_pu_amount_val !~ '^(0|[1-9]\d*)\.\d{2}$' then
    raise exception 'Canonical payload purchase_units[0].amount.value must be a valid canonical USD decimal string with exactly 2 decimal places, received %', v_pu_amount_val;
  end if;

  -- Strict integer cents arithmetic: verify amount in cents matches milestone minor amount
  v_pu_amount_cents := (split_part(v_pu_amount_val, '.', 1)::bigint * 100) + (split_part(v_pu_amount_val, '.', 2)::bigint);
  if v_pu_amount_cents <> v_milestone.amount_minor then
    raise exception 'Canonical payload purchase_units[0].amount.value cents % does not match milestone amount minor %',
      v_pu_amount_cents, v_milestone.amount_minor;
  end if;

  -- Currency verification
  v_pu_currency := trim(coalesce(v_pu->'amount'->>'currency_code', ''));
  if v_pu_currency <> 'USD' or v_pu_currency <> v_milestone.currency then
    raise exception 'Canonical payload purchase_units[0].amount.currency_code % does not match milestone currency USD', v_pu_currency;
  end if;

  -- Payee merchant ID verification (when payee is present)
  if v_pu ? 'payee' then
    if jsonb_typeof(v_pu->'payee') <> 'object' then
      raise exception 'Canonical payload purchase_units[0].payee must be a valid JSON object';
    end if;
    v_pu_merchant_id := trim(coalesce(v_pu->'payee'->>'merchant_id', ''));
    if char_length(v_pu_merchant_id) > 0 and v_pu_merchant_id <> trim(p_expected_merchant_id) then
      raise exception 'Canonical payload purchase_units[0].payee.merchant_id % does not match expected merchant ID %',
        v_pu_merchant_id, trim(p_expected_merchant_id);
    end if;
  end if;

  -- 8. Insert payment intent with pre-validated intent ID
  insert into public.payment_intents (
    id,
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
    v_intent_id,
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
  );

  -- Renew session activity
  update public.client_portal_sessions
  set last_active_at = now()
  where id = v_session.id;

  return v_intent_id;
end;
$$;

revoke all on function public.create_client_payment_intent(text, uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_client_payment_intent(text, uuid, text, uuid, uuid, jsonb) to service_role;

-- 2. Hardened create_sandbox_demo_payment_intent
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
  v_pu jsonb;
  v_custom_id_text text;
  v_ref_id_text text;
  v_pu_amount_val text;
  v_pu_amount_cents bigint;
  v_pu_currency text;
  v_pu_merchant_id text;
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

  -- Validate Single Purchase-Unit Canonical Contract
  if p_canonical_payload is null or jsonb_typeof(p_canonical_payload) <> 'object' then
    raise exception 'Canonical payload must be a valid JSON object';
  end if;

  if not (p_canonical_payload ? 'purchase_units') or
     jsonb_typeof(p_canonical_payload->'purchase_units') <> 'array' then
    raise exception 'Canonical payload missing mandatory purchase_units array';
  end if;

  if jsonb_array_length(p_canonical_payload->'purchase_units') <> 1 then
    raise exception 'Canonical payload purchase_units must contain exactly 1 element, received %',
      jsonb_array_length(p_canonical_payload->'purchase_units');
  end if;

  v_pu := p_canonical_payload->'purchase_units'->0;

  if jsonb_typeof(v_pu) <> 'object' then
    raise exception 'Canonical payload purchase_units[0] must be a valid JSON object';
  end if;

  -- Validate custom_id matches a valid UUID
  v_custom_id_text := trim(coalesce(v_pu->>'custom_id', ''));
  if char_length(v_custom_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory custom_id';
  end if;

  begin
    v_intent_id := v_custom_id_text::uuid;
  exception when others then
    raise exception 'Canonical payload purchase_units[0].custom_id must be a valid UUID, received %', v_custom_id_text;
  end;

  -- Validate reference_id matches the milestone UUID
  v_ref_id_text := trim(coalesce(v_pu->>'reference_id', ''));
  if char_length(v_ref_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory reference_id';
  end if;

  if v_ref_id_text <> v_milestone.id::text then
    raise exception 'Canonical payload purchase_units[0].reference_id % does not match milestone ID %',
      v_ref_id_text, v_milestone.id::text;
  end if;

  -- Validate amount object and exact 2-decimal format
  if not (v_pu ? 'amount') or jsonb_typeof(v_pu->'amount') <> 'object' then
    raise exception 'Canonical payload purchase_units[0] missing mandatory amount object';
  end if;

  v_pu_amount_val := trim(coalesce(v_pu->'amount'->>'value', ''));
  if v_pu_amount_val !~ '^(0|[1-9]\d*)\.\d{2}$' then
    raise exception 'Canonical payload purchase_units[0].amount.value must be a valid canonical USD decimal string with exactly 2 decimal places, received %', v_pu_amount_val;
  end if;

  -- Strict integer cents arithmetic
  v_pu_amount_cents := (split_part(v_pu_amount_val, '.', 1)::bigint * 100) + (split_part(v_pu_amount_val, '.', 2)::bigint);
  if v_pu_amount_cents <> v_milestone.amount_minor then
    raise exception 'Canonical payload purchase_units[0].amount.value cents % does not match milestone amount minor %',
      v_pu_amount_cents, v_milestone.amount_minor;
  end if;

  -- Currency verification
  v_pu_currency := trim(coalesce(v_pu->'amount'->>'currency_code', ''));
  if v_pu_currency <> 'USD' or v_pu_currency <> v_milestone.currency then
    raise exception 'Canonical payload purchase_units[0].amount.currency_code % does not match milestone currency USD', v_pu_currency;
  end if;

  -- Payee merchant ID verification
  if v_pu ? 'payee' then
    if jsonb_typeof(v_pu->'payee') <> 'object' then
      raise exception 'Canonical payload purchase_units[0].payee must be a valid JSON object';
    end if;
    v_pu_merchant_id := trim(coalesce(v_pu->'payee'->>'merchant_id', ''));
    if char_length(v_pu_merchant_id) > 0 and v_pu_merchant_id <> trim(p_expected_merchant_id) then
      raise exception 'Canonical payload purchase_units[0].payee.merchant_id % does not match expected merchant ID %',
        v_pu_merchant_id, trim(p_expected_merchant_id);
    end if;
  end if;

  -- Insert payment intent
  insert into public.payment_intents (
    id,
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
    v_intent_id,
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
  );

  return v_intent_id;
end;
$$;

revoke all on function public.create_sandbox_demo_payment_intent(uuid, text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_sandbox_demo_payment_intent(uuid, text, uuid, uuid, jsonb) to authenticated;
