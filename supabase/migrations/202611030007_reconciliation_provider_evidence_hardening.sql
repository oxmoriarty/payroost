-- Payroost Phase 3A.1.4: Reconciliation Provider-Evidence Hardening
-- Hardens reconcile_and_complete_payment_intent so that financial, payee, and order
-- linkage data recorded in the ledger is cross-checked against authoritative provider evidence itself.
--
-- Enforces:
-- 1. Dual-evidence validation requiring both PayPal Capture details and PayPal Order details.
-- 2. Strict monetary parsing without floating-point arithmetic.
-- 3. Mandatory order linkage in capture supplementary_data.related_ids.order_id.
-- 4. Mandatory order-to-purchase-unit binding matching internal intent reference in canonical_payload_json.
-- 5. Rejection of multiple ambiguous purchase units.
-- 6. Rejection of contradictory legacy arguments if provided.
-- 7. Direct derivation of ledger amount, currency, and payee from verified provider JSON.
-- 8. Strict service-role-only privilege restriction.

-- ============================================================================
-- 1. DROP PREVIOUS RECONCILIATION FUNCTION SIGNATURE
-- ============================================================================

drop function if exists public.reconcile_and_complete_payment_intent(uuid, text, bigint, text, jsonb, text);

-- ============================================================================
-- 2. CREATE HARDENED RECONCILIATION RECOVERY RPC
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
  
  v_canonical_custom_id text;
  v_canonical_ref_id text;
  v_canonical_top_custom_id text;
  v_has_canonical_ref boolean := false;
  
  v_matched_pu_count int := 0;
  v_target_pu jsonb;
  v_pu_item jsonb;
  v_pu_custom_id text;
  v_pu_ref_id text;
  v_pu_amount_text text;
  v_pu_currency text;
  v_pu_merchant_id text;
  
  v_has_capture_link boolean := false;
  v_cap_item jsonb;
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

  -- 8.4 Amount validation with strict monetary parsing
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

  -- Strict integer cents computation without floats
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

  -- 9.2 Order status consistency with completed capture
  if coalesce(p_raw_order_response->>'status', '') not in ('COMPLETED', 'APPROVED') then
    raise exception 'Order details status % is inconsistent with completed capture (must be COMPLETED or APPROVED)',
      coalesce(p_raw_order_response->>'status', '<missing>');
  end if;

  -- 9.3 Purchase units array validation
  if not (p_raw_order_response ? 'purchase_units') or
     jsonb_typeof(p_raw_order_response->'purchase_units') <> 'array' or
     jsonb_array_length(p_raw_order_response->'purchase_units') = 0 then
    raise exception 'Expected purchase unit is missing from order response';
  end if;

  -- 9.4 Extract canonical reference from stored canonical_payload_json
  v_canonical_custom_id := null;
  v_canonical_ref_id := null;
  v_canonical_top_custom_id := null;

  if (v_intent.canonical_payload_json ? 'purchase_units') and
     jsonb_typeof(v_intent.canonical_payload_json->'purchase_units') = 'array' and
     jsonb_array_length(v_intent.canonical_payload_json->'purchase_units') > 0 then
    v_canonical_custom_id := v_intent.canonical_payload_json->'purchase_units'->0->>'custom_id';
    v_canonical_ref_id := v_intent.canonical_payload_json->'purchase_units'->0->>'reference_id';
  end if;

  if (v_intent.canonical_payload_json ? 'custom_id') then
    v_canonical_top_custom_id := v_intent.canonical_payload_json->>'custom_id';
  end if;

  if v_canonical_custom_id is not null or v_canonical_ref_id is not null or v_canonical_top_custom_id is not null then
    v_has_canonical_ref := true;
  end if;

  if not v_has_canonical_ref then
    raise exception 'Payment intent canonical order payload is missing a reliable internal reference';
  end if;

  -- 9.5 Locate unique matching purchase unit
  v_matched_pu_count := 0;
  for v_pu_item in select * from jsonb_array_elements(p_raw_order_response->'purchase_units') loop
    v_pu_custom_id := v_pu_item->>'custom_id';
    v_pu_ref_id := v_pu_item->>'reference_id';

    -- Check if this unit matches the canonical intent references
    if (v_canonical_custom_id is not null and v_pu_custom_id = v_canonical_custom_id) or
       (v_canonical_top_custom_id is not null and v_pu_custom_id = v_canonical_top_custom_id) or
       (v_canonical_ref_id is not null and v_pu_ref_id = v_canonical_ref_id) or
       (v_pu_custom_id = v_intent.id::text) or
       (v_pu_ref_id = v_intent.milestone_id::text) then
      v_matched_pu_count := v_matched_pu_count + 1;
      v_target_pu := v_pu_item;
    end if;
  end loop;

  if v_matched_pu_count = 0 then
    raise exception 'Purchase unit matching internal reference not found in order response';
  end if;

  if v_matched_pu_count > 1 then
    raise exception 'Multiple ambiguous purchase units matched in order response';
  end if;

  -- 9.6 Assert purchase unit internal reference matches canonical payload
  if v_canonical_custom_id is not null then
    if coalesce(v_target_pu->>'custom_id', '') <> v_canonical_custom_id then
      raise exception 'Purchase unit custom_id % does not match intent identifier % in canonical payload',
        coalesce(v_target_pu->>'custom_id', '<missing>'), v_canonical_custom_id;
    end if;
  end if;

  if v_canonical_ref_id is not null then
    if coalesce(v_target_pu->>'reference_id', '') <> v_canonical_ref_id then
      raise exception 'Purchase unit reference_id % does not match reference % in canonical payload',
        coalesce(v_target_pu->>'reference_id', '<missing>'), v_canonical_ref_id;
    end if;
  end if;

  -- 9.7 Purchase unit currency validation
  if not (v_target_pu ? 'amount') or not (v_target_pu->'amount' ? 'currency_code') then
    raise exception 'Purchase unit missing amount.currency_code';
  end if;

  v_pu_currency := v_target_pu->'amount'->>'currency_code';
  if v_pu_currency <> 'USD' then
    raise exception 'Purchase unit currency % is unsupported; expected USD', v_pu_currency;
  end if;

  if v_pu_currency <> v_intent.expected_currency then
    raise exception 'Purchase unit currency % does not match intent expected currency %',
      v_pu_currency, v_intent.expected_currency;
  end if;

  -- 9.8 Purchase unit amount validation
  if not (v_target_pu->'amount' ? 'value') then
    raise exception 'Purchase unit missing amount.value';
  end if;

  v_pu_amount_text := v_target_pu->'amount'->>'value';
  if v_pu_amount_text <> v_intent.expected_amount_canonical then
    raise exception 'Purchase unit amount % does not match expected intent amount %',
      v_pu_amount_text, v_intent.expected_amount_canonical;
  end if;

  -- 9.9 Purchase unit payee merchant ID (where available)
  if v_target_pu ? 'payee' and v_target_pu->'payee' ? 'merchant_id' then
    v_pu_merchant_id := trim(v_target_pu->'payee'->>'merchant_id');
    if v_pu_merchant_id <> v_intent.expected_merchant_id then
      raise exception 'Purchase unit payee merchant ID % does not match expected merchant ID %',
        v_pu_merchant_id, v_intent.expected_merchant_id;
    end if;
  end if;

  -- 9.10 Expected capture presence in purchase unit's captures record
  if v_target_pu ? 'payments' and v_target_pu->'payments' ? 'captures' and
     jsonb_typeof(v_target_pu->'payments'->'captures') = 'array' and
     jsonb_array_length(v_target_pu->'payments'->'captures') > 0 then
    v_has_capture_link := false;
    for v_cap_item in select * from jsonb_array_elements(v_target_pu->'payments'->'captures') loop
      if coalesce(v_cap_item->>'id', '') = v_clean_capture_id then
        v_has_capture_link := true;
      end if;
    end loop;
    if not v_has_capture_link then
      raise exception 'Purchase unit captures record does not contain expected capture ID %', v_clean_capture_id;
    end if;
  end if;

  -- ==========================================================================
  -- 10. REJECT CONTRADICTORY LEGACY ARGUMENTS (IF PROVIDED)
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
  -- 11. INSERT VERIFIED CAPTURE INTO APPEND-ONLY LEDGER
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
  -- 12. ATOMICALLY UPDATE INTENT STATUS TO COMPLETED
  -- ==========================================================================
  update public.payment_intents
  set status = 'COMPLETED',
      completed_at = now(),
      capture_lease_expires_at = null
  where id = p_intent_id;

  -- ==========================================================================
  -- 13. RECORD AUDIT ACTIVITY EVENT
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
