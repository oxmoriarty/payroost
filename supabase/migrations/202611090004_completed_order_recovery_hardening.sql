-- PayRoost Phase 3B.4.3.1: Completed-Order Recovery Hardening
--
-- Remediates:
-- 1. AUDIT-3B43-01 (HIGH): Fenced Already-Completed Order Recovery & Payee Resolution.
--    - Adds p_lease_token parameter to public.reconcile_and_complete_payment_intent().
--    - Allows active worker holding a matching capture lease token to reconcile an intent in CAPTURING.
--    - Fixes payee.merchant_id inspection: in PayPal Orders v2, payee is authoritative on the matched
--      purchase unit (p_raw_order_response->'purchase_units'->0->'payee'). Removes mandatory payee
--      requirement from p_raw_capture_response while verifying that any payee present on capture does not contradict.
--
-- 2. AUDIT-3B43-03 (LOW): Defense-in-Depth Evidence Validation in record_paypal_order_captured().
--    - Cross-verifies that if p_raw_capture_response contains amount or payee attributes (either on
--      purchase_units or at top-level), they strictly match p_amount_cents, USD currency, and p_payee_merchant_id.
--    - Preserves existing ledger mutation invariants and service_role security.

-- ============================================================================
-- 1. DROP PREVIOUS 7-PARAMETER SIGNATURE OF RECONCILE_AND_COMPLETE_PAYMENT_INTENT
-- ============================================================================

drop function if exists public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text);

-- ============================================================================
-- 2. HARDENED RECONCILE_AND_COMPLETE_PAYMENT_INTENT RPC (AUDIT-3B43-01)
-- ============================================================================

create or replace function public.reconcile_and_complete_payment_intent(
  p_intent_id uuid,
  p_provider_capture_id text,
  p_raw_capture_response jsonb,
  p_raw_order_response jsonb,
  p_resolution_notes text default null,
  p_amount_cents bigint default null,
  p_payee_merchant_id text default null,
  p_lease_token uuid default null
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
  v_existing_capture public.payment_transactions%rowtype;

  v_target_pu jsonb;
  v_pu_custom_id text;
  v_pu_ref_id text;
  v_pu_amount_text text;
  v_pu_currency text;
  v_pu_merchant_id text;

  v_cap_item jsonb;
  v_capture_occurrence_count int := 0;
begin
  -- 1. Set transaction-local flags so triggers permit authorized recovery transition
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

  -- 5. Recovery Eligibility Guard: RECONCILIATION_REQUIRED or CAPTURING
  if v_intent.status not in ('RECONCILIATION_REQUIRED', 'CAPTURING') then
    raise exception 'Intent status % is not eligible for reconciliation recovery; must be RECONCILIATION_REQUIRED or CAPTURING', v_intent.status;
  end if;

  -- If in CAPTURING, check lease fencing:
  -- If lease is unexpired, caller MUST hold the active fencing lease token
  if v_intent.status = 'CAPTURING' and v_intent.capture_lease_expires_at is not null and v_intent.capture_lease_expires_at > clock_timestamp() then
    if p_lease_token is null or v_intent.capture_lease_token is distinct from p_lease_token then
      raise exception 'Cannot reconcile CAPTURING intent while an active worker lease is held';
    end if;
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

  if v_parsed_cents <> v_intent.expected_amount_cents then
    raise exception 'Parsed capture cents % do not match expected intent cents %',
      v_parsed_cents, v_intent.expected_amount_cents;
  end if;

  -- 8.5 Payee merchant verification on capture (AUDIT-3B43-01 remediation)
  -- In PayPal Orders v2, payee is authoritative on the purchase unit.
  -- If payee is explicitly present on the capture object, verify it does not contradict.
  if (p_raw_capture_response ? 'payee') and (p_raw_capture_response->'payee' ? 'merchant_id') then
    v_capture_merchant_id := trim(p_raw_capture_response->'payee'->>'merchant_id');
    if v_capture_merchant_id <> v_intent.expected_merchant_id then
      raise exception 'Capture payee merchant ID % does not match expected merchant ID %',
        v_capture_merchant_id, v_intent.expected_merchant_id;
    end if;
  end if;

  -- 8.6 Optional custom_id validation
  if (p_raw_capture_response ? 'custom_id') and
     char_length(trim(coalesce(p_raw_capture_response->>'custom_id', ''))) > 0 and
     trim(p_raw_capture_response->>'custom_id') <> v_intent.id::text then
    raise exception 'Capture custom_id % does not match payment intent ID %',
      p_raw_capture_response->>'custom_id', v_intent.id::text;
  end if;

  -- ==========================================================================
  -- 9. VALIDATE AUTHORITATIVE ORDER RESPONSE (p_raw_order_response)
  -- ==========================================================================

  -- 9.1 Top-level order ID and status
  v_capture_order_id := trim(coalesce(p_raw_order_response->>'id', ''));
  if v_capture_order_id <> v_intent.provider_order_id then
    raise exception 'Order response ID % does not match intent provider_order_id %',
      v_capture_order_id, v_intent.provider_order_id;
  end if;

  if coalesce(p_raw_order_response->>'status', '') <> 'COMPLETED' then
    raise exception 'Authoritative PayPal order status must be COMPLETED, received %',
      coalesce(p_raw_order_response->>'status', '<missing>');
  end if;

  -- 9.2 Purchase unit contract enforcement
  if not (p_raw_order_response ? 'purchase_units') or
     jsonb_typeof(p_raw_order_response->'purchase_units') <> 'array' or
     jsonb_array_length(p_raw_order_response->'purchase_units') <> 1 then
    raise exception 'Order response purchase_units must contain exactly 1 element, received %',
      coalesce(jsonb_array_length(p_raw_order_response->'purchase_units')::text, 'null');
  end if;

  v_target_pu := p_raw_order_response->'purchase_units'->0;
  if jsonb_typeof(v_target_pu) <> 'object' then
    raise exception 'Order purchase_units[0] must be an object';
  end if;

  -- 9.3 Custom ID and Reference ID bindings
  v_pu_custom_id := trim(coalesce(v_target_pu->>'custom_id', ''));
  v_pu_ref_id := trim(coalesce(v_target_pu->>'reference_id', ''));

  if v_pu_custom_id = v_intent.id::text and v_pu_ref_id <> v_intent.milestone_id::text then
    raise exception 'Purchase unit contains correct custom_id % but contradictory reference_id % (expected milestone %)',
      v_pu_custom_id, v_pu_ref_id, v_intent.milestone_id::text;
  end if;

  if v_pu_ref_id = v_intent.milestone_id::text and v_pu_custom_id <> v_intent.id::text then
    raise exception 'Purchase unit contains correct reference_id % but contradictory custom_id % (expected intent %)',
      v_pu_ref_id, v_pu_custom_id, v_intent.id::text;
  end if;

  if v_pu_custom_id <> v_intent.id::text or v_pu_ref_id <> v_intent.milestone_id::text then
    raise exception 'Purchase unit matching intent ID % and milestone ID % not found in order response',
      v_intent.id::text, v_intent.milestone_id::text;
  end if;

  -- 9.4 Currency and Amount
  if not (v_target_pu ? 'amount') or not (v_target_pu->'amount' ? 'currency_code') then
    raise exception 'Matched purchase unit missing amount.currency_code';
  end if;

  v_pu_currency := v_target_pu->'amount'->>'currency_code';
  if v_pu_currency <> 'USD' or v_pu_currency <> v_intent.expected_currency then
    raise exception 'Purchase unit currency % does not match expected USD', v_pu_currency;
  end if;

  if not (v_target_pu->'amount' ? 'value') or (v_target_pu->'amount'->>'value') <> v_intent.expected_amount_canonical then
    raise exception 'Purchase unit amount does not match expected amount %', v_intent.expected_amount_canonical;
  end if;

  -- 9.5 Payee merchant (authoritative on matched purchase unit, AUDIT-3B43-01 remediation)
  if not (v_target_pu ? 'payee') or not (v_target_pu->'payee' ? 'merchant_id') then
    raise exception 'Matched purchase unit missing payee.merchant_id';
  end if;

  v_pu_merchant_id := trim(v_target_pu->'payee'->>'merchant_id');
  if v_pu_merchant_id <> v_intent.expected_merchant_id then
    raise exception 'Purchase unit payee merchant ID % does not match expected merchant ID %',
      v_pu_merchant_id, v_intent.expected_merchant_id;
  end if;
  v_capture_merchant_id := v_pu_merchant_id;

  -- ==========================================================================
  -- 10. MANDATORY CAPTURE LINKAGE WITHIN MATCHED PURCHASE UNIT
  -- ==========================================================================

  if not (v_target_pu ? 'payments') or jsonb_typeof(v_target_pu->'payments') <> 'object' or
     not (v_target_pu->'payments' ? 'captures') or
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
  -- 12. INSERT OR UPDATE VERIFIED CAPTURE INTO FINANCIAL LEDGER
  -- ==========================================================================
  select * into v_existing_capture
  from public.payment_transactions
  where payment_intent_id = p_intent_id
    and provider_reference_id = v_clean_capture_id
    and transaction_type = 'CAPTURE'
  limit 1;

  if found then
    if v_existing_capture.status = 'COMPLETED' then
      -- Idempotent return (already recorded as completed)
      null;
    elsif v_existing_capture.status = 'PENDING' then
      -- Authorized in-place update from PENDING to COMPLETED
      perform set_config('payroost.ledger_mutation_authorized', 'true', true);

      update public.payment_transactions
      set status = 'COMPLETED',
          raw_response = jsonb_build_object(
            'capture', p_raw_capture_response,
            'order', p_raw_order_response
          ),
          captured_at = now()
      where id = v_existing_capture.id;
    else
      raise exception 'Existing transaction for capture % has unsupported status %',
        v_clean_capture_id, v_existing_capture.status;
    end if;
  else
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
  end if;

  -- ==========================================================================
  -- 13. ATOMICALLY UPDATE INTENT STATUS TO COMPLETED FIRST
  -- ==========================================================================
  update public.payment_intents
  set status = 'COMPLETED',
      completed_at = coalesce(completed_at, now()),
      capture_lease_expires_at = null,
      capture_lease_token = null,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      reconciliation_reason = null,
      updated_at = now()
  where id = p_intent_id;

  -- ==========================================================================
  -- 13.1 ATOMICALLY UPDATE MILESTONE STATUS TO ACCEPTED SECOND
  -- ==========================================================================
  update public.milestones
  set status = 'ACCEPTED',
      updated_at = now()
  where id = v_intent.milestone_id;

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
      'milestoneId', v_intent.milestone_id,
      'providerCaptureId', v_clean_capture_id,
      'providerOrderId', v_intent.provider_order_id,
      'notes', p_resolution_notes
    )
  );

  return true;
end;
$$;

revoke all on function public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text, uuid) to service_role;

-- ============================================================================
-- 3. DEFENSE-IN-DEPTH HARDENING FOR RECORD_PAYPAL_ORDER_CAPTURED (AUDIT-3B43-03)
-- ============================================================================

create or replace function public.record_paypal_order_captured(
  p_session_token_hash text,
  p_payment_intent_id uuid,
  p_lease_token uuid,
  p_provider_capture_id text,
  p_capture_status text,
  p_amount_cents bigint,
  p_payee_merchant_id text,
  p_raw_capture_response jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.client_portal_sessions%rowtype;
  v_intent public.payment_intents%rowtype;
  v_clean_capture_id text;
  v_clean_status text;
  v_existing_capture public.payment_transactions%rowtype;
  v_dollars bigint;
  v_cents bigint;
  v_parsed_cents bigint;
begin
  if p_session_token_hash is null or p_payment_intent_id is null or p_lease_token is null or
     p_provider_capture_id is null or p_capture_status is null or p_amount_cents is null or
     p_payee_merchant_id is null or p_raw_capture_response is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_capture_id := trim(p_provider_capture_id);
  if char_length(v_clean_capture_id) < 1 or char_length(v_clean_capture_id) > 64 then
    return jsonb_build_object('success', false, 'error', 'INVALID_CAPTURE_ID');
  end if;

  v_clean_status := upper(trim(p_capture_status));
  if v_clean_status not in ('COMPLETED', 'PENDING', 'FAILED', 'DECLINED') then
    return jsonb_build_object('success', false, 'error', 'UNSUPPORTED_CAPTURE_STATUS');
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

  -- 4. Idempotent check: if already COMPLETED with this exact capture ID
  if v_intent.status = 'COMPLETED' then
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and provider_reference_id = v_clean_capture_id
      and transaction_type = 'CAPTURE'
      and status = 'COMPLETED'
    limit 1;

    if found then
      return jsonb_build_object(
        'success', true,
        'already_recorded', true,
        'payment_intent_id', v_intent.id,
        'capture_id', v_clean_capture_id,
        'status', 'COMPLETED'
      );
    else
      return jsonb_build_object('success', false, 'error', 'COMPLETED_WITH_DIFFERENT_CAPTURE');
    end if;
  end if;

  -- 5. Fencing token validation: caller must strictly hold active capture lease
  if v_intent.capture_lease_token is distinct from p_lease_token then
    return jsonb_build_object('success', false, 'error', 'STALE_LEASE_TOKEN');
  end if;

  -- 6. Status check: must be in CAPTURING
  if v_intent.status <> 'CAPTURING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  -- 7. Check global uniqueness of capture ID across other payment intents
  if exists (
    select 1 from public.payment_transactions
    where provider_reference_id = v_clean_capture_id
      and payment_intent_id <> v_intent.id
  ) then
    return jsonb_build_object('success', false, 'error', 'DUPLICATE_CAPTURE_ID');
  end if;

  -- 8. Financial and Merchant Verification
  if p_amount_cents <> v_intent.expected_amount_cents then
    return jsonb_build_object(
      'success', false,
      'error', 'AMOUNT_MISMATCH',
      'expected_amount_cents', v_intent.expected_amount_cents,
      'received_amount_cents', p_amount_cents
    );
  end if;

  if trim(p_payee_merchant_id) <> v_intent.expected_merchant_id then
    return jsonb_build_object(
      'success', false,
      'error', 'MERCHANT_MISMATCH',
      'expected_merchant_id', v_intent.expected_merchant_id,
      'received_merchant_id', trim(p_payee_merchant_id)
    );
  end if;

  -- 8.1 Defense-in-depth raw evidence validation (AUDIT-3B43-03)
  if jsonb_typeof(p_raw_capture_response) = 'object' then
    -- Purchase-unit level validation (when full order is provided)
    if (p_raw_capture_response ? 'purchase_units') and
       jsonb_typeof(p_raw_capture_response->'purchase_units') = 'array' and
       jsonb_array_length(p_raw_capture_response->'purchase_units') = 1 then

      if (p_raw_capture_response->'purchase_units'->0 ? 'payee') and
         (p_raw_capture_response->'purchase_units'->0->'payee' ? 'merchant_id') and
         trim(p_raw_capture_response->'purchase_units'->0->'payee'->>'merchant_id') <> trim(p_payee_merchant_id) then
        return jsonb_build_object('success', false, 'error', 'RAW_MERCHANT_MISMATCH');
      end if;

      if (p_raw_capture_response->'purchase_units'->0 ? 'amount') and
         (p_raw_capture_response->'purchase_units'->0->'amount' ? 'currency_code') and
         (p_raw_capture_response->'purchase_units'->0->'amount'->>'currency_code') <> 'USD' then
        return jsonb_build_object('success', false, 'error', 'RAW_CURRENCY_MISMATCH');
      end if;
    end if;

    -- Capture-level amount validation
    if (p_raw_capture_response ? 'amount') and jsonb_typeof(p_raw_capture_response->'amount') = 'object' then
      if (p_raw_capture_response->'amount' ? 'currency_code') and
         (p_raw_capture_response->'amount'->>'currency_code') <> 'USD' then
        return jsonb_build_object('success', false, 'error', 'RAW_CURRENCY_MISMATCH');
      end if;

      if (p_raw_capture_response->'amount' ? 'value') and
         (p_raw_capture_response->'amount'->>'value') ~ '^(0|[1-9]\d*)\.\d{2}$' then
        v_dollars := split_part(p_raw_capture_response->'amount'->>'value', '.', 1)::bigint;
        v_cents := split_part(p_raw_capture_response->'amount'->>'value', '.', 2)::bigint;
        v_parsed_cents := (v_dollars * 100) + v_cents;

        if v_parsed_cents <> p_amount_cents then
          return jsonb_build_object('success', false, 'error', 'RAW_AMOUNT_MISMATCH');
        end if;
      end if;
    end if;

    -- Capture-level payee validation
    if (p_raw_capture_response ? 'payee') and (p_raw_capture_response->'payee' ? 'merchant_id') then
      if trim(p_raw_capture_response->'payee'->>'merchant_id') <> trim(p_payee_merchant_id) then
        return jsonb_build_object('success', false, 'error', 'RAW_MERCHANT_MISMATCH');
      end if;
    end if;
  end if;

  -- 9. Handle COMPLETED capture
  if v_clean_status = 'COMPLETED' then
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and provider_reference_id = v_clean_capture_id
      and transaction_type = 'CAPTURE'
    limit 1;

    if found then
      if v_existing_capture.status = 'COMPLETED' then
        null;
      elsif v_existing_capture.status = 'PENDING' then
        perform set_config('payroost.ledger_mutation_authorized', 'true', true);

        update public.payment_transactions
        set status = 'COMPLETED',
            raw_response = p_raw_capture_response,
            captured_at = now()
        where id = v_existing_capture.id;
      else
        return jsonb_build_object('success', false, 'error', 'UNSUPPORTED_EXISTING_STATUS');
      end if;
    else
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
        v_intent.id,
        'CAPTURE',
        'PAYPAL',
        v_clean_capture_id,
        'COMPLETED',
        p_amount_cents,
        'USD',
        trim(p_payee_merchant_id),
        p_raw_capture_response
      );
    end if;

    -- Atomically update payment intent COMPLETED first
    update public.payment_intents
    set status = 'COMPLETED',
      completed_at = now(),
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
    where id = v_intent.id;

    -- Atomically update milestone ACCEPTED second
    update public.milestones
    set status = 'ACCEPTED',
      updated_at = now()
    where id = v_intent.milestone_id;

    -- Record audit activity event
    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.order_captured',
      'Payment of $' || v_intent.expected_amount_canonical || ' captured and completed for milestone',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id,
        'amountCents', p_amount_cents
      )
    );

    -- Renew session activity
    update public.client_portal_sessions
    set last_active_at = now()
    where id = v_session.id;

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'milestone_id', v_intent.milestone_id,
      'capture_id', v_clean_capture_id,
      'status', 'COMPLETED'
    );

  -- 10. Handle PENDING capture
  elsif v_clean_status = 'PENDING' then
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and provider_reference_id = v_clean_capture_id
      and transaction_type = 'CAPTURE'
    limit 1;

    if found then
      if v_existing_capture.status = 'COMPLETED' then
        return jsonb_build_object(
          'success', true,
          'already_recorded', true,
          'payment_intent_id', v_intent.id,
          'capture_id', v_clean_capture_id,
          'status', 'COMPLETED'
        );
      end if;
    else
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
        v_intent.id,
        'CAPTURE',
        'PAYPAL',
        v_clean_capture_id,
        'PENDING',
        p_amount_cents,
        'USD',
        trim(p_payee_merchant_id),
        p_raw_capture_response
      );
    end if;

    update public.payment_intents
    set status = 'RECONCILIATION_REQUIRED',
      reconciliation_reason = 'PAYPAL_CAPTURE_PENDING',
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
    where id = v_intent.id;

    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.capture_pending',
      'Payment capture of $' || v_intent.expected_amount_canonical || ' is pending provider settlement',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id
      )
    );

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'capture_id', v_clean_capture_id,
      'status', 'PENDING',
      'reconciliation_required', true
    );

  -- 11. Handle DECLINED / FAILED capture
  else
    update public.payment_intents
    set status = 'FAILED',
      reconciliation_reason = 'PAYPAL_CAPTURE_DECLINED',
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
    where id = v_intent.id;

    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.capture_failed',
      'Payment capture was declined or failed at provider',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id
      )
    );

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'capture_id', v_clean_capture_id,
      'status', v_clean_status
    );
  end if;
end;
$$;

revoke all on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) to service_role;
