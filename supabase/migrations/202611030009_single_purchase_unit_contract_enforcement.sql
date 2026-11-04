-- Payroost Phase 3A.1.8: Single Purchase-Unit Contract Enforcement
-- Remediates:
-- 1. Enforces jsonb_array_length(p_canonical_payload->'purchase_units') = 1 at creation time
--    in create_client_payment_intent and create_sandbox_demo_payment_intent.
--    Rejects missing, non-array, empty (length = 0), multiple (length > 1), and non-object purchase units.
-- 2. Enforces jsonb_array_length(p_raw_order_response->'purchase_units') = 1 at reconciliation time
--    in reconcile_and_complete_payment_intent. Rejects missing, non-array, empty, multiple,
--    and unrelated additional purchase units in the authoritative PayPal order response.
-- 3. Preserves dual exact matching (custom_id = intent UUID, reference_id = milestone UUID),
--    contradictory identifier rejection, mandatory COMPLETED order status, mandatory COMPLETED capture status,
--    single capture occurrence, zero-float monetary validation, append-only ledger invariants,
--    SECURITY DEFINER, empty search_path, and strict role permissions.

-- ============================================================================
-- 1. UPDATE CLIENT-SESSION PAYMENT INTENT CREATION RPC
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
  v_pu jsonb;
  v_custom_id_text text;
  v_ref_id_text text;
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

  if jsonb_array_length(p_canonical_payload->'purchase_units') = 0 then
    raise exception 'Canonical payload purchase_units array must not be empty';
  end if;

  if jsonb_array_length(p_canonical_payload->'purchase_units') <> 1 then
    raise exception 'Canonical payload purchase_units must contain exactly 1 element, received %',
      jsonb_array_length(p_canonical_payload->'purchase_units');
  end if;

  v_pu := p_canonical_payload->'purchase_units'->0;

  if jsonb_typeof(v_pu) <> 'object' then
    raise exception 'Canonical payload purchase_units[0] must be a valid JSON object';
  end if;

  v_custom_id_text := trim(coalesce(v_pu->>'custom_id', ''));
  if char_length(v_custom_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory custom_id';
  end if;

  begin
    v_intent_id := v_custom_id_text::uuid;
  exception when others then
    raise exception 'Canonical payload purchase_units[0].custom_id must be a valid UUID, received %', v_custom_id_text;
  end;

  v_ref_id_text := trim(coalesce(v_pu->>'reference_id', ''));
  if char_length(v_ref_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory reference_id';
  end if;

  if v_ref_id_text <> v_milestone.id::text then
    raise exception 'Canonical payload purchase_units[0].reference_id % does not match milestone ID %',
      v_ref_id_text, v_milestone.id::text;
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

-- ============================================================================
-- 2. UPDATE OWNER-ONLY SANDBOX DEMO RPC
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
  v_pu jsonb;
  v_custom_id_text text;
  v_ref_id_text text;
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

  if jsonb_array_length(p_canonical_payload->'purchase_units') = 0 then
    raise exception 'Canonical payload purchase_units array must not be empty';
  end if;

  if jsonb_array_length(p_canonical_payload->'purchase_units') <> 1 then
    raise exception 'Canonical payload purchase_units must contain exactly 1 element, received %',
      jsonb_array_length(p_canonical_payload->'purchase_units');
  end if;

  v_pu := p_canonical_payload->'purchase_units'->0;

  if jsonb_typeof(v_pu) <> 'object' then
    raise exception 'Canonical payload purchase_units[0] must be a valid JSON object';
  end if;

  v_custom_id_text := trim(coalesce(v_pu->>'custom_id', ''));
  if char_length(v_custom_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory custom_id';
  end if;

  begin
    v_intent_id := v_custom_id_text::uuid;
  exception when others then
    raise exception 'Canonical payload purchase_units[0].custom_id must be a valid UUID, received %', v_custom_id_text;
  end;

  v_ref_id_text := trim(coalesce(v_pu->>'reference_id', ''));
  if char_length(v_ref_id_text) = 0 then
    raise exception 'Canonical payload purchase_units[0] missing mandatory reference_id';
  end if;

  if v_ref_id_text <> v_milestone.id::text then
    raise exception 'Canonical payload purchase_units[0].reference_id % does not match milestone ID %',
      v_ref_id_text, v_milestone.id::text;
  end if;

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

-- ============================================================================
-- 3. REVISE RECONCILE_AND_COMPLETE_PAYMENT_INTENT WITH SINGLE PURCHASE UNIT
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
  
  v_target_pu jsonb;
  v_pu_custom_id text;
  v_pu_ref_id text;
  v_pu_amount_text text;
  v_pu_currency text;
  v_pu_merchant_id text;
  
  v_cap_item jsonb;
  v_capture_occurrence_count int := 0;
begin
  -- 1. Set transaction-local flag so triggers permit the authorized recovery transition
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

  -- 5. Recovery Eligibility Guard: Must be in RECONCILIATION_REQUIRED
  if v_intent.status <> 'RECONCILIATION_REQUIRED' then
    raise exception 'Intent status % is not eligible for reconciliation recovery; must be RECONCILIATION_REQUIRED', v_intent.status;
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

  if v_parsed_cents <= 0 then
    raise exception 'Capture amount must be strictly positive';
  end if;

  if v_parsed_cents <> v_intent.expected_amount_cents then
    raise exception 'Parsed capture cents % does not match expected cents %',
      v_parsed_cents, v_intent.expected_amount_cents;
  end if;

  -- 8.5 Payee merchant ID validation
  if not (p_raw_capture_response ? 'payee') or not (p_raw_capture_response->'payee' ? 'merchant_id') then
    raise exception 'Capture response missing payee.merchant_id';
  end if;

  v_capture_merchant_id := trim(p_raw_capture_response->'payee'->>'merchant_id');
  if v_capture_merchant_id <> v_intent.expected_merchant_id then
    raise exception 'Capture payee merchant ID % does not match expected merchant ID %',
      v_capture_merchant_id, v_intent.expected_merchant_id;
  end if;

  -- 8.6 Mandatory capture order linkage
  if not (p_raw_capture_response ? 'supplementary_data') or
     not (p_raw_capture_response->'supplementary_data' ? 'related_ids') or
     not (p_raw_capture_response->'supplementary_data'->'related_ids' ? 'order_id') then
    raise exception 'Capture response missing mandatory supplementary_data.related_ids.order_id';
  end if;

  v_capture_order_id := p_raw_capture_response->'supplementary_data'->'related_ids'->>'order_id';
  if v_capture_order_id <> v_intent.provider_order_id then
    raise exception 'Capture related order ID % does not match intent provider order ID %',
      v_capture_order_id, v_intent.provider_order_id;
  end if;

  -- ==========================================================================
  -- 9. VALIDATE ORDER DETAILS RESPONSE (p_raw_order_response)
  -- ==========================================================================

  -- 9.1 Order ID match
  if coalesce(p_raw_order_response->>'id', '') <> v_intent.provider_order_id then
    raise exception 'Order details ID % does not match intent provider order ID %',
      coalesce(p_raw_order_response->>'id', '<missing>'), v_intent.provider_order_id;
  end if;

  -- 9.2 Strict Order Status Rule: MUST be COMPLETED. APPROVED is strictly rejected.
  if coalesce(p_raw_order_response->>'status', '') <> 'COMPLETED' then
    raise exception 'Authoritative PayPal order status must be COMPLETED, received %',
      coalesce(p_raw_order_response->>'status', '<missing>');
  end if;

  -- 9.3 Single Purchase-Unit Array Validation: MUST contain exactly 1 element
  if not (p_raw_order_response ? 'purchase_units') or
     jsonb_typeof(p_raw_order_response->'purchase_units') <> 'array' then
    raise exception 'Order response purchase_units must be a valid JSON array';
  end if;

  if jsonb_array_length(p_raw_order_response->'purchase_units') = 0 then
    raise exception 'Order response purchase_units array must not be empty';
  end if;

  if jsonb_array_length(p_raw_order_response->'purchase_units') <> 1 then
    raise exception 'Order response purchase_units must contain exactly 1 element, received %',
      jsonb_array_length(p_raw_order_response->'purchase_units');
  end if;

  v_target_pu := p_raw_order_response->'purchase_units'->0;

  if jsonb_typeof(v_target_pu) <> 'object' then
    raise exception 'Purchase unit element in order response must be a JSON object';
  end if;

  -- 9.4 Strict Dual Identifier Match on the Single Purchase Unit
  v_pu_custom_id := trim(coalesce(v_target_pu->>'custom_id', ''));
  v_pu_ref_id := trim(coalesce(v_target_pu->>'reference_id', ''));

  -- Contradictory identifier rejection
  if v_pu_custom_id = v_intent.id::text and v_pu_ref_id <> v_intent.milestone_id::text then
    raise exception 'Purchase unit contains correct custom_id % but contradictory reference_id % (expected milestone %)',
      v_pu_custom_id, v_pu_ref_id, v_intent.milestone_id::text;
  end if;

  if v_pu_ref_id = v_intent.milestone_id::text and v_pu_custom_id <> v_intent.id::text then
    raise exception 'Purchase unit contains correct reference_id % but contradictory custom_id % (expected intent %)',
      v_pu_ref_id, v_pu_custom_id, v_intent.id::text;
  end if;

  -- Strict equality on both identifiers
  if v_pu_custom_id <> v_intent.id::text or v_pu_ref_id <> v_intent.milestone_id::text then
    raise exception 'Purchase unit matching intent ID % and milestone ID % not found in order response',
      v_intent.id::text, v_intent.milestone_id::text;
  end if;

  -- 9.5 Purchase unit currency validation
  if not (v_target_pu ? 'amount') or not (v_target_pu->'amount' ? 'currency_code') then
    raise exception 'Matched purchase unit missing amount.currency_code';
  end if;

  v_pu_currency := v_target_pu->'amount'->>'currency_code';
  if v_pu_currency <> 'USD' then
    raise exception 'Purchase unit currency % is unsupported; expected USD', v_pu_currency;
  end if;

  if v_pu_currency <> v_intent.expected_currency then
    raise exception 'Purchase unit currency % does not match intent expected currency %',
      v_pu_currency, v_intent.expected_currency;
  end if;

  -- 9.6 Purchase unit amount validation
  if not (v_target_pu->'amount' ? 'value') then
    raise exception 'Matched purchase unit missing amount.value';
  end if;

  v_pu_amount_text := v_target_pu->'amount'->>'value';
  if v_pu_amount_text <> v_intent.expected_amount_canonical then
    raise exception 'Purchase unit amount % does not match expected intent amount %',
      v_pu_amount_text, v_intent.expected_amount_canonical;
  end if;

  -- 9.7 Purchase unit payee merchant ID validation
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

  if not (v_target_pu ? 'payments') or jsonb_typeof(v_target_pu->'payments') <> 'object' then
    raise exception 'Matched purchase unit missing mandatory payments object';
  end if;

  if not (v_target_pu->'payments' ? 'captures') or
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
  -- 12. INSERT VERIFIED CAPTURE INTO APPEND-ONLY LEDGER
  -- ==========================================================================
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

  -- ==========================================================================
  -- 13. ATOMICALLY UPDATE INTENT STATUS TO COMPLETED
  -- ==========================================================================
  update public.payment_intents
  set status = 'COMPLETED',
      completed_at = now(),
      capture_lease_expires_at = null
  where id = p_intent_id;

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
      'providerCaptureId', v_clean_capture_id,
      'providerOrderId', v_intent.provider_order_id,
      'notes', p_resolution_notes
    )
  );

  return true;
end;
$$;

-- Restrict privileged reconciliation RPC strictly to service_role
revoke all on function public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text) from public, anon, authenticated;
