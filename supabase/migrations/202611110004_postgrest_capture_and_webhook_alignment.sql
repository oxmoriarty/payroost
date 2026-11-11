-- PayRoost Phase R Corrective Migration: PostgREST Capture Auth, Webhook State Alignment & Profile Backfill
--
-- Forward-only remediation addressing issues identified in the Supabase Migration Readiness Audit
-- without altering any previously authored migration file:
-- 1. Restores the PostgREST-compatible dual-layer service-role / authenticator JWT claim check in
--    public.record_paypal_order_captured(...) and public.reconcile_and_complete_payment_intent(...)
--    while preserving all R3 Platform verification, lease fencing, ledger, and milestone guards.
-- 2. Aligns webhook capture processing across public.validate_payment_transaction_insert(),
--    public.prevent_payment_transactions_mutation(), and public.record_paypal_webhook_capture_state(...)
--    so verified PayPal capture webhooks (PENDING, DENIED/DECLINED/FAILED, COMPLETED) succeed safely
--    when intents are in ORDER_CREATED or BUYER_APPROVED, and delayed PENDING -> FAILED transitions work
--    without relaxing terminal state, payee, amount, currency, or unprivileged insert protections.
-- 3. Normalizes missing or blank provider_webhook_events.resource_type values to the documented sentinel
--    'UNKNOWN' inside public.claim_paypal_webhook_event(...) and sets a column default without dropping
--    NOT NULL / non-empty integrity or overwriting genuine PayPal resource types.
-- 4. Safely and idempotently backfills public.profiles rows for any pre-existing auth.users records
--    created prior to on_auth_user_created trigger deployment, using only non-sensitive display metadata.

-- ============================================================================
-- 1. RESTORE POSTGREST-COMPATIBLE SERVICE-ROLE AUTH IN record_paypal_order_captured
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
  -- Dual-layer session role assertion (supports direct DBA roles and Supabase PostgREST authenticator + JWT)
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
-- 2. RESTORE POSTGREST-COMPATIBLE SERVICE-ROLE AUTH IN reconcile_and_complete_payment_intent
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
  -- 1. Dual-layer session role assertion (supports direct DBA roles and Supabase PostgREST authenticator + JWT)
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

-- ============================================================================
-- 3. CORRECT WEBHOOK CAPTURE STATE VALIDATION, MUTATION TRIGGER & RPC ORDERING
-- ============================================================================

-- 3a. Update BEFORE INSERT trigger function on public.payment_transactions
create or replace function public.validate_payment_transaction_insert()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_parent public.payment_transactions%rowtype;
  v_existing_refunds bigint;
  v_is_privileged_service boolean;
  v_is_reconciliation_active boolean;
  v_webhook_event_id text;
  v_raw_order_status text;
  v_raw_order_id text;
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

    if new.provider <> v_intent.provider then
      raise exception 'Capture provider % does not match intent provider %', new.provider, v_intent.provider;
    end if;

    if new.status not in ('COMPLETED', 'PENDING', 'FAILED') then
      raise exception 'Invalid status % for CAPTURE transaction', new.status;
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

    v_is_privileged_service := (
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
    );
    v_is_reconciliation_active := (
      current_setting('payroost.reconciliation_active', true) = 'true'
    );
    v_webhook_event_id := trim(coalesce(current_setting('payroost.webhook_capture_event_id', true), ''));

    -- Strict state invariants for capture insertion:
    --   * CAPTURING / RECONCILING / COMPLETED: permitted (COMPLETED forbids inserting non-COMPLETED captures;
    --     partial unique index still blocks multiple COMPLETED/PENDING captures per intent).
    --   * RECONCILIATION_REQUIRED: permitted strictly under privileged active reconciliation.
    --   * ORDER_CREATED / BUYER_APPROVED: permitted strictly under privileged active reconciliation when
    --     provider_order_id is already bound, no COMPLETED capture exists yet, and either verified COMPLETED
    --     order reconciliation evidence is attached OR a verified provider_webhook_events row is active.
    --   * ORDER_CREATING / FAILED / CANCELLED: always rejected.
    if v_intent.status in ('CAPTURING', 'RECONCILING', 'COMPLETED') then
      if v_intent.status = 'COMPLETED' and new.status <> 'COMPLETED' then
        raise exception 'Cannot record % capture for already COMPLETED intent', new.status;
      end if;
    elsif v_intent.status = 'RECONCILIATION_REQUIRED' then
      if not (v_is_privileged_service and v_is_reconciliation_active) then
        raise exception 'Cannot record capture for intent in status %', v_intent.status;
      end if;
    elsif v_intent.status in ('ORDER_CREATED', 'BUYER_APPROVED') then
      if not (v_is_privileged_service and v_is_reconciliation_active) then
        raise exception 'Cannot record capture for intent in status %', v_intent.status;
      end if;

      if v_intent.provider_order_id is null or char_length(trim(v_intent.provider_order_id)) = 0 then
        raise exception 'Cannot record capture for % intent without a bound provider_order_id', v_intent.status;
      end if;

      if exists (
        select 1
        from public.payment_transactions pt
        where pt.payment_intent_id = v_intent.id
          and pt.transaction_type = 'CAPTURE'
          and pt.status = 'COMPLETED'
      ) then
        raise exception 'Intent % already has a COMPLETED capture transaction', v_intent.id;
      end if;

      if new.status = 'COMPLETED' then
        v_raw_order_status := upper(trim(coalesce(new.raw_response->'order'->>'status', '')));
        v_raw_order_id := trim(coalesce(new.raw_response->'order'->>'id', ''));

        if not (
          (
            new.raw_response ? 'order'
            and v_raw_order_status = 'COMPLETED'
            and v_raw_order_id = v_intent.provider_order_id
          )
          or (
            v_webhook_event_id <> ''
            and exists (
              select 1
              from public.provider_webhook_events pwe
              where pwe.provider = 'PAYPAL'
                and pwe.provider_event_id = v_webhook_event_id
                and pwe.signature_verified is true
                and (pwe.payment_intent_id is null or pwe.payment_intent_id = v_intent.id)
            )
          )
        ) then
          raise exception 'Cannot record COMPLETED capture for intent in status % without verified order or webhook evidence', v_intent.status;
        end if;
      else
        if v_webhook_event_id = ''
           or not exists (
             select 1
             from public.provider_webhook_events pwe
             where pwe.provider = 'PAYPAL'
               and pwe.provider_event_id = v_webhook_event_id
               and pwe.signature_verified is true
               and (pwe.payment_intent_id is null or pwe.payment_intent_id = v_intent.id)
           ) then
          raise exception 'Cannot record % capture for intent in status % without a verified webhook event context', new.status, v_intent.status;
        end if;
      end if;
    else
      raise exception 'Cannot record capture for intent in status %', v_intent.status;
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

-- 3b. Update BEFORE UPDATE / DELETE ledger trigger to allow verified PENDING -> FAILED webhook settlement
create or replace function public.prevent_payment_transactions_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Financial transaction ledger is strictly append-only and records cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    -- Dual-Layer Check 1: Caller must be a trusted service role or superuser
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
      raise exception 'Unauthorized: Only service_role can update payment transactions';
    end if;

    -- Dual-Layer Check 2: Transaction-local privileged execution flag
    if current_setting('payroost.ledger_mutation_authorized', true) is distinct from 'true' then
      raise exception 'Financial transaction ledger is strictly append-only; update not authorized';
    end if;

    -- Only CAPTURE transactions can transition from PENDING
    if old.transaction_type <> 'CAPTURE' then
      raise exception 'Only CAPTURE transactions can transition from PENDING to COMPLETED or FAILED';
    end if;

    -- Only PENDING -> COMPLETED or PENDING -> FAILED (with reconciliation_active) is permitted
    if old.status <> 'PENDING' or new.status not in ('COMPLETED', 'FAILED') then
      raise exception 'Invalid status transition on payment transaction: % to %; only PENDING to COMPLETED or FAILED is permitted',
        old.status, new.status;
    end if;

    if new.status = 'FAILED' and current_setting('payroost.reconciliation_active', true) is distinct from 'true' then
      raise exception 'Transitioning PENDING capture transaction to FAILED requires active privileged reconciliation';
    end if;

    -- Assert strict immutability of financial, relational, and identity attributes
    if (old.id <> new.id or
        old.payment_intent_id <> new.payment_intent_id or
        (old.parent_transaction_id is distinct from new.parent_transaction_id) or
        old.transaction_type <> new.transaction_type or
        old.provider <> new.provider or
        old.provider_reference_id <> new.provider_reference_id or
        old.amount_cents <> new.amount_cents or
        old.currency <> new.currency or
        old.payee_merchant_id <> new.payee_merchant_id or
        old.created_at <> new.created_at) then
      raise exception 'Payment transaction immutable financial, relational, and identity attributes cannot be modified';
    end if;

    -- Populate captured_at only when settling to COMPLETED; keep existing value on FAILED
    if new.status = 'COMPLETED' then
      new.captured_at := coalesce(new.captured_at, now());
    else
      new.captured_at := old.captured_at;
    end if;

    return new;
  end if;

  return null;
end;
$$;

-- 3c. Replace record_paypal_webhook_capture_state with verified webhook check, Platform metadata guard,
--     safe state ordering (update intent to RECONCILIATION_REQUIRED before PENDING tx insert),
--     and strict terminal/stale conflict handling
create or replace function public.record_paypal_webhook_capture_state(
  p_payment_intent_id uuid,
  p_provider_order_id text,
  p_provider_capture_id text,
  p_capture_status text,
  p_payee_merchant_id text,
  p_amount_cents bigint,
  p_currency text,
  p_sanitized_raw_capture jsonb,
  p_provider_event_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_webhook_event public.provider_webhook_events%rowtype;
  v_existing_completed_tx public.payment_transactions%rowtype;
  v_existing_tx public.payment_transactions%rowtype;
  v_other_pending_tx public.payment_transactions%rowtype;
  v_conflicting_tx public.payment_transactions%rowtype;
  v_clean_order_id text;
  v_clean_capture_id text;
  v_clean_status text;
  v_clean_currency text;
  v_clean_merchant text;
  v_clean_event_id text;
  v_intent_mode text;
  v_canonical_seller_merchant text;
  v_canonical_seller_payer text;
  v_tx_id uuid;
begin
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

  v_clean_order_id := trim(coalesce(p_provider_order_id, ''));
  v_clean_capture_id := trim(coalesce(p_provider_capture_id, ''));
  v_clean_status := upper(trim(coalesce(p_capture_status, '')));
  v_clean_currency := upper(trim(coalesce(p_currency, '')));
  v_clean_merchant := trim(coalesce(p_payee_merchant_id, ''));
  v_clean_event_id := trim(coalesce(p_provider_event_id, ''));

  if p_payment_intent_id is null
     or char_length(v_clean_capture_id) < 1
     or char_length(v_clean_capture_id) > 64
     or v_clean_status not in ('PENDING', 'DENIED', 'DECLINED', 'FAILED')
     or p_amount_cents is null
     or p_amount_cents <= 0
     or v_clean_currency <> 'USD'
     or v_clean_merchant = ''
     or v_clean_event_id = ''
     or p_sanitized_raw_capture is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  -- Verify persisted, signature-verified webhook event context before touching financial state
  select * into v_webhook_event
  from public.provider_webhook_events
  where provider = 'PAYPAL'
    and provider_event_id = v_clean_event_id
  for share;

  if not found or v_webhook_event.signature_verified is distinct from true then
    return jsonb_build_object('success', false, 'error', 'UNVERIFIED_WEBHOOK_EVENT');
  end if;

  if v_webhook_event.payment_intent_id is not null
     and v_webhook_event.payment_intent_id <> p_payment_intent_id then
    return jsonb_build_object('success', false, 'error', 'WEBHOOK_INTENT_MISMATCH');
  end if;

  -- Lock payment intent row
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- Validate order & payee & financial bindings
  if v_intent.provider_order_id is not null
     and v_clean_order_id <> ''
     and v_intent.provider_order_id <> v_clean_order_id then
    return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISMATCH');
  end if;

  if v_intent.status in ('ORDER_CREATED', 'BUYER_APPROVED')
     and (v_intent.provider_order_id is null or char_length(trim(v_intent.provider_order_id)) = 0) then
    return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISSING');
  end if;

  if p_amount_cents <> v_intent.expected_amount_cents then
    return jsonb_build_object('success', false, 'error', 'AMOUNT_MISMATCH');
  end if;

  if v_clean_currency <> v_intent.expected_currency then
    return jsonb_build_object('success', false, 'error', 'CURRENCY_MISMATCH');
  end if;

  if v_clean_merchant <> v_intent.expected_merchant_id then
    return jsonb_build_object('success', false, 'error', 'MERCHANT_MISMATCH');
  end if;

  -- Verify Platform metadata integrity if intent is explicit PLATFORM mode
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

  -- Cross-intent capture ID replay prevention
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

  -- Active capture worker lease fence: defer via retry
  if v_intent.status = 'CAPTURING'
     and v_intent.capture_lease_expires_at is not null
     and v_intent.capture_lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'success', false,
      'error', 'LEASE_ACTIVE',
      'current_status', v_intent.status
    );
  end if;

  -- Non-regression protection for already COMPLETED intent or completed capture ledger
  select * into v_existing_completed_tx
  from public.payment_transactions
  where payment_intent_id = v_intent.id
    and transaction_type = 'CAPTURE'
    and status = 'COMPLETED'
  limit 1;

  if v_intent.status = 'COMPLETED' or found then
    return jsonb_build_object(
      'success', true,
      'transitioned', false,
      'stale_event', true,
      'current_status', v_intent.status,
      'payment_transaction_id', v_existing_completed_tx.id
    );
  end if;

  -- Look up existing ledger entry for this capture ID on this intent
  select * into v_existing_tx
  from public.payment_transactions
  where payment_intent_id = v_intent.id
    and transaction_type = 'CAPTURE'
    and provider_reference_id = v_clean_capture_id
  limit 1;

  perform set_config('payroost.reconciliation_active', 'true', true);
  perform set_config('payroost.webhook_capture_event_id', v_clean_event_id, true);

  if v_clean_status = 'PENDING' then
    if v_intent.status in ('FAILED', 'CANCELLED') then
      return jsonb_build_object(
        'success', false,
        'error', 'TERMINAL_INTENT_CONFLICT',
        'current_status', v_intent.status
      );
    end if;

    if v_intent.status = 'ORDER_CREATING' then
      return jsonb_build_object(
        'success', false,
        'error', 'INVALID_TRANSITION',
        'current_status', v_intent.status
      );
    end if;

    if v_existing_tx.id is not null then
      if v_existing_tx.status = 'FAILED' then
        return jsonb_build_object('success', false, 'error', 'INVALID_EXISTING_TX_STATUS');
      end if;
      v_tx_id := v_existing_tx.id;
    else
      -- Verify no conflicting PENDING capture exists BEFORE updating payment_intents
      select * into v_other_pending_tx
      from public.payment_transactions
      where payment_intent_id = v_intent.id
        and transaction_type = 'CAPTURE'
        and status = 'PENDING'
      limit 1;

      if found then
        return jsonb_build_object('success', false, 'error', 'CAPTURE_ID_CONFLICT');
      end if;
    end if;

    -- Transition intent to RECONCILIATION_REQUIRED BEFORE inserting the PENDING capture row so
    -- state and trigger validation remain aligned across ORDER_CREATED / BUYER_APPROVED / CAPTURING / RECONCILING.
    update public.payment_intents
    set status = 'RECONCILIATION_REQUIRED',
        reconciliation_reason = 'PAYPAL_CAPTURE_PENDING',
        provider_order_id = coalesce(provider_order_id, nullif(v_clean_order_id, '')),
        order_creation_lease_expires_at = null,
        order_creation_lease_token = null,
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

    if v_existing_tx.id is null then
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
        p_sanitized_raw_capture
      )
      returning id into v_tx_id;
    end if;

    insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
    values (
      v_intent.project_id,
      'System',
      'payment.webhook_capture_pending',
      'PayPal webhook reported PENDING capture ' || v_clean_capture_id,
      jsonb_build_object(
        'paymentIntentId', v_intent.id,
        'milestoneId', v_intent.milestone_id,
        'providerOrderId', coalesce(v_intent.provider_order_id, nullif(v_clean_order_id, '')),
        'providerCaptureId', v_clean_capture_id,
        'providerEventId', v_clean_event_id,
        'paymentMode', coalesce(nullif(v_intent_mode, ''), 'MERCHANT')
      )
    );

    return jsonb_build_object(
      'success', true,
      'transitioned', true,
      'current_status', 'RECONCILIATION_REQUIRED',
      'payment_transaction_id', v_tx_id
    );
  end if;

  -- DENIED / DECLINED / FAILED path
  if v_intent.status = 'CANCELLED' then
    return jsonb_build_object(
      'success', false,
      'error', 'TERMINAL_INTENT_CONFLICT',
      'current_status', v_intent.status
    );
  end if;

  if v_intent.status = 'FAILED' then
    if v_existing_tx.id is not null and v_existing_tx.status = 'FAILED' then
      return jsonb_build_object(
        'success', true,
        'transitioned', false,
        'stale_event', true,
        'current_status', 'FAILED',
        'payment_transaction_id', v_existing_tx.id
      );
    end if;

    return jsonb_build_object(
      'success', false,
      'error', 'TERMINAL_INTENT_CONFLICT',
      'current_status', v_intent.status
    );
  end if;

  if v_intent.status = 'ORDER_CREATING' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRANSITION',
      'current_status', v_intent.status
    );
  end if;

  if v_existing_tx.id is not null then
    v_tx_id := v_existing_tx.id;
    if v_existing_tx.status = 'PENDING' then
      perform set_config('payroost.ledger_mutation_authorized', 'true', true);
      update public.payment_transactions
      set status = 'FAILED',
          raw_response = p_sanitized_raw_capture
      where id = v_existing_tx.id;
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
      'FAILED',
      v_intent.expected_amount_cents,
      'USD',
      v_intent.expected_merchant_id,
      p_sanitized_raw_capture
    )
    returning id into v_tx_id;
  end if;

  -- Fail intent cleanly after recording failed capture ledger entry; DO NOT mutate milestones
  update public.payment_intents
  set status = 'FAILED',
      reconciliation_reason = 'PAYPAL_CAPTURE_' || v_clean_status,
      provider_order_id = coalesce(provider_order_id, nullif(v_clean_order_id, '')),
      order_creation_lease_expires_at = null,
      order_creation_lease_token = null,
      capture_lease_expires_at = null,
      capture_lease_token = null,
      updated_at = now()
  where id = v_intent.id;

  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    'System',
    'payment.webhook_capture_denied',
    'PayPal webhook reported ' || v_clean_status || ' capture ' || v_clean_capture_id,
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'providerOrderId', coalesce(v_intent.provider_order_id, nullif(v_clean_order_id, '')),
      'providerCaptureId', v_clean_capture_id,
      'captureStatus', v_clean_status,
      'providerEventId', v_clean_event_id,
      'paymentMode', coalesce(nullif(v_intent_mode, ''), 'MERCHANT')
    )
  );

  return jsonb_build_object(
    'success', true,
    'transitioned', true,
    'current_status', 'FAILED',
    'payment_transaction_id', v_tx_id
  );
end;
$$;

revoke all on function public.record_paypal_webhook_capture_state(
  uuid, text, text, text, text, bigint, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_paypal_webhook_capture_state(
  uuid, text, text, text, text, bigint, text, jsonb, text
) to service_role;

-- ============================================================================
-- 4. RESOLVE provider_webhook_events.resource_type NOT NULL MISMATCH
-- ============================================================================

-- Set documented sentinel default while preserving existing NOT NULL + non-empty CHECK constraint
alter table public.provider_webhook_events
  alter column resource_type set default 'UNKNOWN';

create or replace function public.claim_paypal_webhook_event(
  p_provider_event_id text,
  p_event_type text,
  p_resource_type text,
  p_resource_id text,
  p_payload_sha256 text,
  p_sanitized_payload jsonb,
  p_sanitized_metadata jsonb default '{}'::jsonb,
  p_event_created_at timestamptz default null,
  p_signature_verified boolean default false,
  p_lease_seconds integer default 60,
  p_max_attempts integer default 5,
  p_allow_reprocess boolean default false,
  p_respect_backoff boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.provider_webhook_events%rowtype;
  v_clean_event_id text;
  v_clean_event_type text;
  v_clean_resource_type text;
  v_effective_resource_type text;
  v_clean_resource_id text;
  v_clean_sha256 text;
  v_lease_secs integer;
  v_max_attempts integer;
begin
  -- 1. Dual-layer role assertion
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
    return jsonb_build_object('success', false, 'claimed', false, 'error', 'PERMISSION_DENIED');
  end if;

  -- 2. Fail closed if PayPal signature was not authoritatively verified
  if p_signature_verified is distinct from true then
    return jsonb_build_object('success', false, 'claimed', false, 'error', 'UNVERIFIED_WEBHOOK_EVENT');
  end if;

  v_clean_event_id := substr(trim(coalesce(p_provider_event_id, '')), 1, 128);
  v_clean_event_type := substr(trim(coalesce(p_event_type, '')), 1, 128);
  v_clean_resource_type := nullif(substr(trim(coalesce(p_resource_type, '')), 1, 128), '');
  -- Missing or blank PayPal resource_type normalizes to sentinel 'UNKNOWN' without faking a PayPal resource type
  v_effective_resource_type := coalesce(v_clean_resource_type, 'UNKNOWN');
  v_clean_resource_id := substr(trim(coalesce(p_resource_id, '')), 1, 128);
  v_clean_sha256 := lower(trim(coalesce(p_payload_sha256, '')));

  if char_length(v_clean_event_id) = 0
     or char_length(v_clean_event_type) = 0
     or v_clean_sha256 !~ '^[0-9a-f]{64}$'
     or p_sanitized_payload is null
     or jsonb_typeof(p_sanitized_payload) <> 'object' then
    return jsonb_build_object('success', false, 'claimed', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_lease_secs := greatest(10, least(coalesce(p_lease_seconds, 60), 300));
  v_max_attempts := greatest(1, least(coalesce(p_max_attempts, 5), 25));

  -- 3. Insert atomically on first delivery; suppress race via ON CONFLICT DO NOTHING
  insert into public.provider_webhook_events (
    provider,
    provider_event_id,
    event_type,
    resource_type,
    resource_id,
    payload_sha256,
    payload,
    status,
    processing_outcome,
    signature_verified,
    attempt_count,
    event_created_at,
    sanitized_metadata
  ) values (
    'PAYPAL',
    v_clean_event_id,
    v_clean_event_type,
    v_effective_resource_type,
    nullif(v_clean_resource_id, ''),
    v_clean_sha256,
    p_sanitized_payload,
    'RECEIVED',
    'VERIFIED',
    true,
    0,
    p_event_created_at,
    coalesce(p_sanitized_metadata, '{}'::jsonb)
  )
  on conflict (provider_event_id) do nothing;

  -- 4. Row lock for deterministic serialization of concurrent deliveries
  select * into v_event
  from public.provider_webhook_events
  where provider_event_id = v_clean_event_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'claimed', false, 'error', 'EVENT_ROW_NOT_FOUND');
  end if;

  -- 5. Detect payload digest mismatch under same provider_event_id
  if v_event.payload_sha256 <> v_clean_sha256 then
    update public.provider_webhook_events
    set duplicate_delivery_count = duplicate_delivery_count + 1
    where id = v_event.id;

    return jsonb_build_object(
      'success', true,
      'claimed', false,
      'duplicate', true,
      'conflict', true,
      'error', 'PAYLOAD_HASH_MISMATCH',
      'event_row_id', v_event.id,
      'payment_intent_id', v_event.payment_intent_id,
      'processing_outcome', 'FAILED'
    );
  end if;

  -- 6. Duplicate already-processed delivery check
  if v_event.status = 'PROCESSED' and not p_allow_reprocess then
    update public.provider_webhook_events
    set duplicate_delivery_count = duplicate_delivery_count + 1
    where id = v_event.id;

    return jsonb_build_object(
      'success', true,
      'claimed', false,
      'duplicate', true,
      'event_row_id', v_event.id,
      'payment_intent_id', v_event.payment_intent_id,
      'payment_transaction_id', v_event.payment_transaction_id,
      'processing_outcome', v_event.processing_outcome
    );
  end if;

  -- 7. Active concurrent worker lease suppression
  if v_event.status = 'PROCESSING'
     and v_event.lease_expires_at is not null
     and v_event.lease_expires_at > clock_timestamp() then
    update public.provider_webhook_events
    set duplicate_delivery_count = duplicate_delivery_count + 1
    where id = v_event.id;

    return jsonb_build_object(
      'success', true,
      'claimed', false,
      'duplicate', false,
      'in_progress', true,
      'event_row_id', v_event.id,
      'lease_expires_at', v_event.lease_expires_at
    );
  end if;

  -- 8. Infinite retry loop breaker
  if not p_allow_reprocess and v_event.attempt_count >= v_max_attempts then
    update public.provider_webhook_events
    set status = 'FAILED',
        processing_outcome = 'REQUIRES_RECONCILIATION',
        lease_expires_at = null,
        next_attempt_at = null,
        error_details = coalesce(nullif(error_details, ''), 'MAX_WEBHOOK_ATTEMPTS_EXCEEDED'),
        last_processed_at = now()
    where id = v_event.id;

    return jsonb_build_object(
      'success', true,
      'claimed', false,
      'max_attempts_exceeded', true,
      'event_row_id', v_event.id,
      'payment_intent_id', v_event.payment_intent_id,
      'processing_outcome', 'REQUIRES_RECONCILIATION'
    );
  end if;

  -- 9. Optional retry backoff check (for periodic recovery sweeps)
  if p_respect_backoff
     and not p_allow_reprocess
     and v_event.status = 'RETRY'
     and v_event.next_attempt_at is not null
     and v_event.next_attempt_at > clock_timestamp() then
    return jsonb_build_object(
      'success', true,
      'claimed', false,
      'backoff_active', true,
      'next_attempt_at', v_event.next_attempt_at,
      'event_row_id', v_event.id
    );
  end if;

  -- 10. Claim lease for processing without overwriting a previously persisted genuine resource_type
  update public.provider_webhook_events
  set status = 'PROCESSING',
      processing_outcome = 'PROCESSING',
      signature_verified = true,
      resource_type = case
        when v_clean_resource_type is not null and upper(v_clean_resource_type) <> 'UNKNOWN' then v_clean_resource_type
        when nullif(trim(coalesce(resource_type, '')), '') is not null then resource_type
        else 'UNKNOWN'
      end,
      resource_id = coalesce(nullif(v_clean_resource_id, ''), resource_id),
      event_created_at = coalesce(event_created_at, p_event_created_at),
      attempt_count = attempt_count + 1,
      lease_expires_at = clock_timestamp() + make_interval(secs => v_lease_secs),
      error_details = null,
      sanitized_metadata = coalesce(sanitized_metadata, '{}'::jsonb) || coalesce(p_sanitized_metadata, '{}'::jsonb)
  where id = v_event.id;

  return jsonb_build_object(
    'success', true,
    'claimed', true,
    'event_row_id', v_event.id,
    'attempt_count', v_event.attempt_count + 1,
    'previous_status', v_event.status
  );
end;
$$;

revoke all on function public.claim_paypal_webhook_event(
  text, text, text, text, text, jsonb, jsonb, timestamptz, boolean, integer, integer, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.claim_paypal_webhook_event(
  text, text, text, text, text, jsonb, jsonb, timestamptz, boolean, integer, integer, boolean, boolean
) to service_role;

-- ============================================================================
-- 5. SAFE, IDEMPOTENT PROFILE BACKFILL FOR PRE-EXISTING auth.users
-- ============================================================================

insert into public.profiles (id, display_name)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'display_name', '')
from auth.users u
where not exists (
  select 1
  from public.profiles p
  where p.id = u.id
)
on conflict (id) do nothing;
