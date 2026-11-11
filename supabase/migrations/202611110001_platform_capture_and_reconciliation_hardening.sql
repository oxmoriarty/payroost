-- PayRoost Phase 3B.R3: PayPal Platform Multi-Party Capture & Reconciliation Hardening
--
-- Objectives:
-- 1. Platform Defense-in-Depth: Validates persisted Platform metadata (payment_mode, seller_merchant_id,
--    seller_payer_id) against expected_merchant_id and verified provider capture responses inside
--    record_paypal_order_captured and reconcile_and_complete_payment_intent while keeping legacy
--    MERCHANT historical records fully functional.
-- 2. Milestone & Payment State Separation (Phase 3B.R3 Section 4):
--    Stops automatically mutating public.milestones.status = 'ACCEPTED' when payment capture or
--    reconciliation completes. Payment state lives on payment_intents / payment_transactions, while
--    milestone work-state transitions remain independent and protected by existing trigger invariants.
-- 3. Strictly preserves all lease fencing, dual-layer role assertions, append-only ledger guards,
--    search_path = '' hardening, and service_role privilege restrictions.

-- ============================================================================
-- 1. REPLACE record_paypal_order_captured (WITHOUT AUTO-ACCEPTING MILESTONES)
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
  v_existing_tx public.payment_transactions%rowtype;
  v_conflicting_tx public.payment_transactions%rowtype;
  v_clean_capture_id text;
  v_clean_capture_status text;
  v_clean_payee_id text;
  v_intent_mode text;
  v_canonical_seller_merchant text;
  v_canonical_seller_payer text;
  v_purchase_units jsonb;
  v_pu jsonb;
  v_pu_payee text;
  v_captures jsonb;
  v_cap jsonb;
  v_cap_count integer := 0;
  v_cap_currency text;
  v_cap_value_text text;
  v_cap_cents bigint;
  v_cap_payee text;
begin
  -- Dual-layer session role assertion
  if session_user not in ('service_role', 'postgres', 'supabase_admin') then
    return jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED');
  end if;

  -- Validate inputs
  if p_session_token_hash is null
     or p_payment_intent_id is null
     or p_lease_token is null
     or p_provider_capture_id is null
     or p_capture_status is null
     or p_amount_cents is null
     or p_payee_merchant_id is null
     or p_raw_capture_response is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_capture_id := trim(p_provider_capture_id);
  if char_length(v_clean_capture_id) < 1 or char_length(v_clean_capture_id) > 64 then
    return jsonb_build_object('success', false, 'error', 'INVALID_CAPTURE_ID');
  end if;

  v_clean_capture_status := upper(trim(p_capture_status));
  if v_clean_capture_status not in ('COMPLETED', 'PENDING', 'DECLINED', 'FAILED') then
    return jsonb_build_object('success', false, 'error', 'UNSUPPORTED_CAPTURE_STATUS');
  end if;

  v_clean_payee_id := trim(p_payee_merchant_id);

  -- 1. Lock payment intent row
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- 2. Lock and validate session
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

  -- 3. Idempotent return if intent already COMPLETED
  if v_intent.status = 'COMPLETED' then
    if v_clean_capture_status = 'PENDING' then
      return jsonb_build_object(
        'success', false,
        'error', 'INVALID_REGRESSION',
        'message', 'Capture already completed; do not regress to PENDING'
      );
    end if;

    select * into v_existing_tx
    from public.payment_transactions
    where payment_intent_id = v_intent.id
      and transaction_type = 'CAPTURE'
      and status = 'COMPLETED'
    order by created_at desc
    limit 1;

    return jsonb_build_object(
      'success', true,
      'already_recorded', true,
      'payment_intent_id', v_intent.id,
      'milestone_id', v_intent.milestone_id,
      'status', 'COMPLETED',
      'capture_id', coalesce(v_existing_tx.provider_reference_id, v_clean_capture_id)
    );
  end if;

  -- 4. Require CAPTURING status and matching lease fencing token
  if v_intent.status <> 'CAPTURING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'status', v_intent.status
    );
  end if;

  if v_intent.capture_lease_token is distinct from p_lease_token then
    return jsonb_build_object('success', false, 'error', 'STALE_LEASE_TOKEN');
  end if;

  -- 5. Verify Platform metadata integrity if intent is explicit PLATFORM mode
  v_intent_mode := upper(trim(coalesce(v_intent.canonical_payload_json->>'payment_mode', '')));
  if v_intent_mode = 'PLATFORM' then
    v_canonical_seller_merchant := trim(coalesce(v_intent.canonical_payload_json->>'seller_merchant_id', ''));
    v_canonical_seller_payer := trim(coalesce(v_intent.canonical_payload_json->>'seller_payer_id', ''));

    if v_canonical_seller_merchant <> v_intent.expected_merchant_id then
      return jsonb_build_object('success', false, 'error', 'SELLER_METADATA_MISMATCH');
    end if;

    if char_length(v_canonical_seller_payer) < 3 or char_length(v_canonical_seller_payer) > 64 then
      return jsonb_build_object('success', false, 'error', 'SELLER_PAYER_ID_MISSING');
    end if;
  end if;

  -- 6. Cross-check expected merchant & amount invariants
  if v_clean_payee_id <> v_intent.expected_merchant_id then
    return jsonb_build_object('success', false, 'error', 'MERCHANT_MISMATCH');
  end if;

  if p_amount_cents <> v_intent.expected_amount_cents then
    return jsonb_build_object('success', false, 'error', 'AMOUNT_MISMATCH');
  end if;

  -- 7. Defense-in-depth validation of raw provider evidence payload (if structured order/capture returned)
  if p_raw_capture_response ? 'purchase_units' then
    v_purchase_units := p_raw_capture_response->'purchase_units';
    if jsonb_typeof(v_purchase_units) <> 'array' or jsonb_array_length(v_purchase_units) <> 1 then
      return jsonb_build_object('success', false, 'error', 'RAW_PURCHASE_UNIT_INVALID');
    end if;

    v_pu := v_purchase_units->0;
    if v_pu ? 'reference_id' and trim(coalesce(v_pu->>'reference_id', '')) <> v_intent.milestone_id::text then
      return jsonb_build_object('success', false, 'error', 'RAW_REFERENCE_ID_MISMATCH');
    end if;

    v_pu_payee := trim(coalesce(v_pu->'payee'->>'merchant_id', ''));
    if v_pu_payee <> '' and v_pu_payee <> v_intent.expected_merchant_id then
      return jsonb_build_object('success', false, 'error', 'RAW_MERCHANT_MISMATCH');
    end if;

    v_captures := v_pu->'payments'->'captures';
    if jsonb_typeof(v_captures) = 'array' then
      for v_cap in select value from jsonb_array_elements(v_captures)
      loop
        if trim(coalesce(v_cap->>'id', '')) = v_clean_capture_id then
          v_cap_count := v_cap_count + 1;

          v_cap_currency := upper(trim(coalesce(v_cap->'amount'->>'currency_code', '')));
          if v_cap_currency <> '' and v_cap_currency <> 'USD' then
            return jsonb_build_object('success', false, 'error', 'RAW_CURRENCY_MISMATCH');
          end if;

          v_cap_value_text := trim(coalesce(v_cap->'amount'->>'value', ''));
          if v_cap_value_text <> '' then
            if v_cap_value_text !~ '^[0-9]+(\.[0-9]{1,2})?$' then
              return jsonb_build_object('success', false, 'error', 'RAW_AMOUNT_MISMATCH');
            end if;
            v_cap_cents := round((v_cap_value_text::numeric) * 100)::bigint;
            if v_cap_cents <> v_intent.expected_amount_cents then
              return jsonb_build_object('success', false, 'error', 'RAW_AMOUNT_MISMATCH');
            end if;
          end if;

          v_cap_payee := trim(coalesce(v_cap->'payee'->>'merchant_id', ''));
          if v_cap_payee <> '' and v_cap_payee <> v_intent.expected_merchant_id then
            return jsonb_build_object('success', false, 'error', 'RAW_MERCHANT_MISMATCH');
          end if;
        end if;
      end loop;

      if v_cap_count = 0 then
        return jsonb_build_object('success', false, 'error', 'RAW_CAPTURE_NOT_FOUND');
      end if;
    end if;
  end if;

  -- 8. Protect against cross-intent replay of the same provider capture ID
  select * into v_conflicting_tx
  from public.payment_transactions
  where provider = 'PAYPAL'
    and transaction_type = 'CAPTURE'
    and provider_reference_id = v_clean_capture_id
    and payment_intent_id <> v_intent.id
  limit 1;

  if found then
    return jsonb_build_object('success', false, 'error', 'CAPTURE_ID_CONFLICT');
  end if;

  -- 9. Check existing capture ledger entry on this intent
  select * into v_existing_tx
  from public.payment_transactions
  where payment_intent_id = v_intent.id
    and transaction_type = 'CAPTURE'
    and provider_reference_id = v_clean_capture_id
  limit 1;

  -- 10. Branch on verified capture status
  if v_clean_capture_status = 'COMPLETED' then
    if found then
      if v_existing_tx.status = 'COMPLETED' then
        null;
      elsif v_existing_tx.status = 'PENDING' then
        perform set_config('payroost.ledger_mutation_authorized', 'true', true);
        update public.payment_transactions
        set status = 'COMPLETED',
            raw_response = p_raw_capture_response,
            captured_at = now()
        where id = v_existing_tx.id;
      else
        return jsonb_build_object('success', false, 'error', 'INVALID_EXISTING_TX_STATUS');
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
        raw_response,
        captured_at
      ) values (
        v_intent.id,
        'CAPTURE',
        'PAYPAL',
        v_clean_capture_id,
        'COMPLETED',
        v_intent.expected_amount_cents,
        'USD',
        v_intent.expected_merchant_id,
        p_raw_capture_response,
        now()
      );
    end if;

    -- Transition intent to COMPLETED and release lease; DO NOT auto-accept milestone
    update public.payment_intents
    set status = 'COMPLETED',
        completed_at = coalesce(completed_at, now()),
        capture_lease_expires_at = null,
        capture_lease_token = null,
        reconciliation_reason = null,
        updated_at = now()
    where id = v_intent.id;

    update public.client_portal_sessions
    set last_active_at = now()
    where id = v_session.id;

    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'Client',
      'payment.order_captured',
      'Payment of $' || v_intent.expected_amount_canonical || ' captured and verified via PayPal',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id,
        'payeeMerchantId', v_intent.expected_merchant_id,
        'paymentMode', coalesce(nullif(v_intent_mode, ''), 'MERCHANT')
      )
    );

    return jsonb_build_object(
      'success', true,
      'already_recorded', false,
      'payment_intent_id', v_intent.id,
      'milestone_id', v_intent.milestone_id,
      'status', 'COMPLETED',
      'capture_id', v_clean_capture_id
    );
  elsif v_clean_capture_status = 'PENDING' then
    if found then
      if v_existing_tx.status = 'COMPLETED' then
        return jsonb_build_object(
          'success', false,
          'error', 'INVALID_REGRESSION',
          'message', 'Capture already completed; do not regress to PENDING'
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
        v_intent.expected_amount_cents,
        'USD',
        v_intent.expected_merchant_id,
        p_raw_capture_response
      );
    end if;

    perform set_config('payroost.reconciliation_active', 'true', true);

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
      'PayPal capture ' || v_clean_capture_id || ' is PENDING settlement verification',
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id,
        'paymentMode', coalesce(nullif(v_intent_mode, ''), 'MERCHANT')
      )
    );

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'milestone_id', v_intent.milestone_id,
      'status', 'PENDING',
      'intent_status', 'RECONCILIATION_REQUIRED',
      'capture_id', v_clean_capture_id
    );
  else
    -- DECLINED or FAILED: record non-completed failed capture event & fail intent cleanly without mutating milestone
    if not found then
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
        'FAILED',
        v_intent.expected_amount_cents,
        'USD',
        v_intent.expected_merchant_id,
        p_raw_capture_response
      );
    end if;

    update public.payment_intents
    set status = 'FAILED',
        reconciliation_reason = 'PAYPAL_CAPTURE_' || v_clean_capture_status,
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.capture_failed',
      'PayPal capture ' || v_clean_capture_id || ' returned status ' || v_clean_capture_status,
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', v_intent.provider_order_id,
        'providerCaptureId', v_clean_capture_id,
        'captureStatus', v_clean_capture_status,
        'paymentMode', coalesce(nullif(v_intent_mode, ''), 'MERCHANT')
      )
    );

    return jsonb_build_object(
      'success', true,
      'payment_intent_id', v_intent.id,
      'milestone_id', v_intent.milestone_id,
      'status', v_clean_capture_status,
      'intent_status', 'FAILED',
      'capture_id', v_clean_capture_id
    );
  end if;
end;
$$;

revoke all on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_paypal_order_captured(text, uuid, uuid, text, text, bigint, text, jsonb) to service_role;

-- ============================================================================
-- 2. REPLACE reconcile_and_complete_payment_intent (WITHOUT AUTO-ACCEPTING MILESTONES)
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
  v_milestone public.milestones%rowtype;
  v_agreement_version public.agreement_versions%rowtype;
  v_existing_capture public.payment_transactions%rowtype;
  v_conflicting_capture public.payment_transactions%rowtype;
  v_clean_capture_id text;
  v_order_id text;
  v_order_status text;
  v_purchase_units jsonb;
  v_pu jsonb;
  v_target_pu jsonb := null;
  v_matched_pu_count integer := 0;
  v_pu_ref text;
  v_pu_merchant text;
  v_captures jsonb;
  v_cap jsonb;
  v_target_capture jsonb := null;
  v_capture_occurrence_count integer := 0;
  v_capture_status text;
  v_capture_currency text;
  v_capture_value_text text;
  v_parsed_cents bigint;
  v_capture_merchant_id text;
  v_capture_custom_id text;
  v_pu_custom_id text;
  v_intent_mode text;
  v_canonical_seller_merchant text;
  v_canonical_seller_payer text;
begin
  -- 1. Dual-layer session role assertion
  if session_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Unauthorized: Only service_role can invoke reconcile_and_complete_payment_intent';
  end if;

  -- 2. Set transaction-local reconciliation flag
  perform set_config('payroost.reconciliation_active', 'true', true);

  -- 3. Validate mandatory arguments
  if p_intent_id is null
     or p_provider_capture_id is null
     or p_raw_capture_response is null
     or p_raw_order_response is null then
    raise exception 'Missing required reconciliation arguments';
  end if;

  v_clean_capture_id := trim(p_provider_capture_id);
  if char_length(v_clean_capture_id) < 1 or char_length(v_clean_capture_id) > 64 then
    raise exception 'Invalid capture ID format';
  end if;

  -- 4. Lock payment intent and related records
  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if not found then
    raise exception 'Payment intent % not found', p_intent_id;
  end if;

  select * into v_milestone from public.milestones where id = v_intent.milestone_id for update;
  if not found then
    raise exception 'Milestone % not found for intent %', v_intent.milestone_id, p_intent_id;
  end if;

  select * into v_agreement_version from public.agreement_versions where id = v_intent.agreement_version_id for share;
  if not found or v_agreement_version.status <> 'APPROVED' then
    raise exception 'Agreement version % is not APPROVED', v_intent.agreement_version_id;
  end if;

  -- Verify Platform canonical metadata if intent is PLATFORM
  v_intent_mode := upper(trim(coalesce(v_intent.canonical_payload_json->>'payment_mode', '')));
  if v_intent_mode = 'PLATFORM' then
    v_canonical_seller_merchant := trim(coalesce(v_intent.canonical_payload_json->>'seller_merchant_id', ''));
    v_canonical_seller_payer := trim(coalesce(v_intent.canonical_payload_json->>'seller_payer_id', ''));

    if v_canonical_seller_merchant <> v_intent.expected_merchant_id then
      raise exception 'Canonical seller_merchant_id % does not match expected_merchant_id %',
        v_canonical_seller_merchant, v_intent.expected_merchant_id;
    end if;

    if char_length(v_canonical_seller_payer) < 3 or char_length(v_canonical_seller_payer) > 64 then
      raise exception 'Platform intent % missing valid canonical seller_payer_id', p_intent_id;
    end if;
  end if;

  -- 5. Lease fencing check when intent is actively CAPTURING
  if v_intent.status = 'CAPTURING'
     and v_intent.capture_lease_expires_at is not null
     and v_intent.capture_lease_expires_at > clock_timestamp() then
    if p_lease_token is null or v_intent.capture_lease_token is distinct from p_lease_token then
      raise exception 'Cannot reconcile CAPTURING intent while an active worker lease is held';
    end if;
  end if;

  -- 6. Eligible intent state check
  if v_intent.status = 'COMPLETED' then
    -- Check if capture ledger already exists idempotently
    select * into v_existing_capture
    from public.payment_transactions
    where payment_intent_id = p_intent_id
      and provider_reference_id = v_clean_capture_id
      and transaction_type = 'CAPTURE'
      and status = 'COMPLETED'
    limit 1;

    if found then
      return true;
    end if;
  elsif v_intent.status not in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED') then
    raise exception 'Intent % in status % cannot be reconciled to COMPLETED', p_intent_id, v_intent.status;
  end if;

  -- 7. Cross-intent duplicate capture ID check
  select * into v_conflicting_capture
  from public.payment_transactions
  where provider = 'PAYPAL'
    and transaction_type = 'CAPTURE'
    and provider_reference_id = v_clean_capture_id
    and payment_intent_id <> p_intent_id
  limit 1;

  if found then
    raise exception 'Capture ID % is already bound to another payment intent %', v_clean_capture_id, v_conflicting_capture.payment_intent_id;
  end if;

  -- 8. Verify raw order response linkage and COMPLETED status
  v_order_id := trim(coalesce(p_raw_order_response->>'id', ''));
  if v_order_id = '' or (v_intent.provider_order_id is not null and v_order_id <> v_intent.provider_order_id) then
    raise exception 'Provider order ID mismatch: expected %, got %', v_intent.provider_order_id, v_order_id;
  end if;

  v_order_status := upper(trim(coalesce(p_raw_order_response->>'status', '')));
  if v_order_status <> 'COMPLETED' then
    raise exception 'Provider order % status is %, expected COMPLETED', v_order_id, v_order_status;
  end if;

  -- 9. Single purchase-unit verification (match by reference_id = milestone_id)
  v_purchase_units := p_raw_order_response->'purchase_units';
  if jsonb_typeof(v_purchase_units) <> 'array' or jsonb_array_length(v_purchase_units) <> 1 then
    raise exception 'Expected exactly 1 purchase unit on PayPal order %, found %',
      v_order_id, coalesce(jsonb_array_length(v_purchase_units), 0);
  end if;

  for v_pu in select value from jsonb_array_elements(v_purchase_units)
  loop
    v_pu_ref := trim(coalesce(v_pu->>'reference_id', ''));
    if v_pu_ref = v_intent.milestone_id::text then
      v_matched_pu_count := v_matched_pu_count + 1;
      v_target_pu := v_pu;
    end if;
  end loop;

  if v_matched_pu_count <> 1 or v_target_pu is null then
    raise exception 'Purchase unit reference_id did not uniquely match milestone %', v_intent.milestone_id;
  end if;

  -- Validate payee merchant_id strictly on matched purchase unit
  if not (v_target_pu ? 'payee') or not (v_target_pu->'payee' ? 'merchant_id') then
    raise exception 'Matched purchase unit missing payee.merchant_id';
  end if;

  v_pu_merchant := trim(coalesce(v_target_pu->'payee'->>'merchant_id', ''));
  if v_pu_merchant <> v_intent.expected_merchant_id then
    raise exception 'Purchase unit payee merchant_id % does not match expected %', v_pu_merchant, v_intent.expected_merchant_id;
  end if;

  -- 10. Find and strictly verify target capture inside matched purchase unit
  v_captures := v_target_pu->'payments'->'captures';
  if jsonb_typeof(v_captures) <> 'array' then
    raise exception 'Matched purchase unit missing payments.captures array';
  end if;

  v_pu_custom_id := trim(coalesce(v_target_pu->>'custom_id', ''));

  for v_cap in select value from jsonb_array_elements(v_captures)
  loop
    if trim(coalesce(v_cap->>'id', '')) = v_clean_capture_id then
      v_capture_occurrence_count := v_capture_occurrence_count + 1;
      v_target_capture := v_cap;

      v_capture_status := upper(trim(coalesce(v_cap->>'status', '')));
      if v_capture_status <> 'COMPLETED' then
        raise exception 'Capture % status is %, expected COMPLETED', v_clean_capture_id, v_capture_status;
      end if;

      v_capture_currency := upper(trim(coalesce(v_cap->'amount'->>'currency_code', '')));
      if v_capture_currency <> 'USD' then
        raise exception 'Capture currency % invalid, expected USD', v_capture_currency;
      end if;

      v_capture_value_text := trim(coalesce(v_cap->'amount'->>'value', ''));
      if v_capture_value_text !~ '^[0-9]+(\.[0-9]{1,2})?$' then
        raise exception 'Malformed capture amount value %', v_capture_value_text;
      end if;

      v_parsed_cents := round((v_capture_value_text::numeric) * 100)::bigint;
      if v_parsed_cents <> v_intent.expected_amount_cents then
        raise exception 'Capture amount cents % does not match expected %', v_parsed_cents, v_intent.expected_amount_cents;
      end if;

      v_capture_custom_id := trim(coalesce(v_cap->>'custom_id', ''));
      if v_capture_custom_id <> '' and v_capture_custom_id <> p_intent_id::text then
        raise exception 'Capture custom_id % does not match intent %', v_capture_custom_id, p_intent_id;
      elsif v_pu_custom_id <> '' and v_pu_custom_id <> p_intent_id::text then
        raise exception 'Purchase unit custom_id % does not match intent %', v_pu_custom_id, p_intent_id;
      end if;

      v_capture_merchant_id := coalesce(
        nullif(trim(coalesce(v_cap->'payee'->>'merchant_id', '')), ''),
        v_pu_merchant
      );

      if v_capture_merchant_id <> v_intent.expected_merchant_id then
        raise exception 'Capture payee merchant_id % does not match expected %', v_capture_merchant_id, v_intent.expected_merchant_id;
      end if;
    end if;
  end loop;

  if v_capture_occurrence_count = 0 then
    raise exception 'Expected capture ID % not found in matched purchase unit captures', v_clean_capture_id;
  end if;

  if v_capture_occurrence_count > 1 then
    raise exception 'Duplicate occurrence of capture ID % in matched purchase unit captures', v_clean_capture_id;
  end if;

  -- 11. Reject contradictory optional parameters
  if p_amount_cents is not null and p_amount_cents <> v_parsed_cents then
    raise exception 'Contradictory argument: p_amount_cents % does not match verified provider capture amount %',
      p_amount_cents, v_parsed_cents;
  end if;

  if p_payee_merchant_id is not null and trim(p_payee_merchant_id) <> v_capture_merchant_id then
    raise exception 'Contradictory argument: p_payee_merchant_id % does not match verified provider capture payee %',
      p_payee_merchant_id, v_capture_merchant_id;
  end if;

  -- 12. Insert or upgrade verified capture in financial ledger
  select * into v_existing_capture
  from public.payment_transactions
  where payment_intent_id = p_intent_id
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
      raw_response,
      captured_at
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
      ),
      now()
    );
  end if;

  -- 13. Transition intent status to COMPLETED; preserve independent milestone work-state
  update public.payment_intents
  set status = 'COMPLETED',
      completed_at = coalesce(completed_at, now()),
      provider_order_id = coalesce(provider_order_id, v_order_id),
      capture_lease_expires_at = null,
      capture_lease_token = null,
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      reconciliation_reason = null,
      updated_at = now()
  where id = p_intent_id;

  -- 14. Record audit activity event
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
      'providerOrderId', coalesce(v_intent.provider_order_id, v_order_id),
      'payeeMerchantId', v_capture_merchant_id,
      'paymentMode', coalesce(nullif(v_intent_mode, ''), 'MERCHANT'),
      'notes', p_resolution_notes
    )
  );

  return true;
end;
$$;

revoke all on function public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_and_complete_payment_intent(uuid, text, jsonb, jsonb, text, bigint, text, uuid) to service_role;
