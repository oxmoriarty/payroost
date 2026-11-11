-- PayRoost Phase 3B.R4: PayPal Platform Webhook Processing & Idempotent Event Store
--
-- Enhancements:
-- 1. Additive columns & indexes on public.provider_webhook_events to track resource linkage,
--    payment_intent_id, payment_transaction_id, explicit payment_mode, processing_outcome
--    (RECEIVED, VERIFIED, PROCESSING, PROCESSED, DUPLICATE, FAILED, REQUIRES_RECONCILIATION),
--    attempt_count, duplicate_delivery_count, event_created_at, last_processed_at,
--    and PII-minimized sanitized_metadata.
-- 2. Updates protect_payment_intent_immutability() to allow service-role reconciliation
--    transitions ORDER_CREATED/BUYER_APPROVED -> COMPLETED/FAILED when
--    payroost.reconciliation_active = 'true' (aligning reconcile_and_complete_payment_intent
--    with webhook-driven capture completion/decline while keeping terminal states immutable
--    and blocking all unprivileged transitions).
-- 3. Introduces service-role-only SECURITY DEFINER RPCs:
--    - claim_paypal_webhook_event(...)
--    - finalize_paypal_webhook_event(...)
--    - record_paypal_webhook_order_approved(...)
--    - record_paypal_webhook_capture_state(...)
--    and keeps admin_reprocess_webhook_event(...) synchronized with new tracking columns.
-- 4. Strictly preserves public.milestones.status (never auto-accepts deliverables/milestones).

-- ============================================================================
-- 1. ADDITIVE SCHEMA EXTENSIONS FOR public.provider_webhook_events
-- ============================================================================

alter table public.provider_webhook_events
  add column if not exists resource_type text,
  add column if not exists resource_id text,
  add column if not exists payment_intent_id uuid references public.payment_intents(id) on delete set null,
  add column if not exists payment_transaction_id uuid references public.payment_transactions(id) on delete set null,
  add column if not exists payment_mode text,
  add column if not exists processing_outcome text not null default 'RECEIVED',
  add column if not exists attempt_count integer not null default 0,
  add column if not exists duplicate_delivery_count integer not null default 0,
  add column if not exists event_created_at timestamptz,
  add column if not exists last_processed_at timestamptz,
  add column if not exists sanitized_metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'provider_webhook_events_payment_mode_check'
      and conrelid = 'public.provider_webhook_events'::regclass
  ) then
    alter table public.provider_webhook_events
      add constraint provider_webhook_events_payment_mode_check
      check (payment_mode is null or payment_mode in ('PLATFORM', 'MERCHANT'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'provider_webhook_events_processing_outcome_check'
      and conrelid = 'public.provider_webhook_events'::regclass
  ) then
    alter table public.provider_webhook_events
      add constraint provider_webhook_events_processing_outcome_check
      check (
        processing_outcome in (
          'RECEIVED',
          'VERIFIED',
          'PROCESSING',
          'PROCESSED',
          'DUPLICATE',
          'FAILED',
          'REQUIRES_RECONCILIATION'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'provider_webhook_events_attempt_count_check'
      and conrelid = 'public.provider_webhook_events'::regclass
  ) then
    alter table public.provider_webhook_events
      add constraint provider_webhook_events_attempt_count_check
      check (attempt_count >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'provider_webhook_events_duplicate_count_check'
      and conrelid = 'public.provider_webhook_events'::regclass
  ) then
    alter table public.provider_webhook_events
      add constraint provider_webhook_events_duplicate_count_check
      check (duplicate_delivery_count >= 0);
  end if;
end $$;

create index if not exists provider_webhook_events_resource_id_idx
  on public.provider_webhook_events (resource_id);

create index if not exists provider_webhook_events_intent_id_idx
  on public.provider_webhook_events (payment_intent_id);

create index if not exists provider_webhook_events_outcome_idx
  on public.provider_webhook_events (processing_outcome);

create index if not exists provider_webhook_events_retry_queue_idx
  on public.provider_webhook_events (status, next_attempt_at)
  where status in ('RECEIVED', 'FAILED', 'RETRY', 'PROCESSING');

alter table public.provider_webhook_events enable row level security;
revoke all on public.provider_webhook_events from public, anon, authenticated;

-- ============================================================================
-- 2. HARDENED PAYMENT INTENT IMMUTABILITY TRIGGER (RECONCILIATION ALIGNMENT)
-- ============================================================================

create or replace function public.protect_payment_intent_immutability()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_is_privileged_service boolean;
  v_is_reconciliation_active boolean;
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

  -- 2. State transition validation
  if old.status <> new.status then
    -- Terminal states cannot transition
    if old.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
      raise exception 'Terminal payment intent state % cannot transition to %', old.status, new.status;
    end if;

    -- Ambiguous state cannot transition automatically unless authorized privileged reconciliation is active
    if old.status = 'RECONCILIATION_REQUIRED' then
      if not v_is_privileged_service then
        raise exception 'Unauthorized: Only service_role can perform reconciliation transitions';
      end if;

      if not v_is_reconciliation_active then
        raise exception 'Payment intent in RECONCILIATION_REQUIRED cannot transition without privileged intervention';
      end if;

      if new.status not in ('COMPLETED', 'FAILED', 'CANCELLED', 'ORDER_CREATED') then
        raise exception 'Payment intent in RECONCILIATION_REQUIRED can only transition to COMPLETED, FAILED, CANCELLED, or ORDER_CREATED via privileged reconciliation';
      end if;
    end if;

    -- Valid state transitions
    if old.status = 'ORDER_CREATING' and new.status not in ('ORDER_CREATED', 'FAILED', 'RECONCILIATION_REQUIRED') then
      raise exception 'Invalid transition from ORDER_CREATING to %', new.status;
    elsif old.status = 'ORDER_CREATED' then
      if new.status in ('COMPLETED', 'FAILED') then
        if not (v_is_privileged_service and v_is_reconciliation_active) then
          raise exception 'Invalid transition from ORDER_CREATED to %', new.status;
        end if;
      elsif new.status not in ('BUYER_APPROVED', 'CAPTURING', 'CANCELLED', 'RECONCILIATION_REQUIRED') then
        raise exception 'Invalid transition from ORDER_CREATED to %', new.status;
      end if;
    elsif old.status = 'BUYER_APPROVED' then
      if new.status in ('COMPLETED', 'FAILED') then
        if not (v_is_privileged_service and v_is_reconciliation_active) then
          raise exception 'Invalid transition from BUYER_APPROVED to %', new.status;
        end if;
      elsif new.status not in ('CAPTURING', 'CANCELLED', 'RECONCILIATION_REQUIRED') then
        raise exception 'Invalid transition from BUYER_APPROVED to %', new.status;
      end if;
    elsif old.status = 'CAPTURING' then
      if new.status = 'CANCELLED' then
        if not v_is_privileged_service then
          raise exception 'Unauthorized: Only service_role can perform CAPTURING to CANCELLED reconciliation';
        end if;

        if not v_is_reconciliation_active then
          raise exception 'Payment intent transition from CAPTURING to CANCELLED requires privileged reconciliation intervention';
        end if;

        if old.capture_lease_expires_at is not null and old.capture_lease_expires_at > clock_timestamp() then
          raise exception 'Payment intent in CAPTURING cannot transition to CANCELLED while an active capture lease is held';
        end if;

        if old.order_creation_lease_expires_at is not null and old.order_creation_lease_expires_at > clock_timestamp() then
          raise exception 'Payment intent in CAPTURING cannot transition to CANCELLED while an active order creation lease is held';
        end if;
      elsif new.status not in ('COMPLETED', 'RECONCILING', 'RECONCILIATION_REQUIRED', 'FAILED', 'ORDER_CREATED', 'BUYER_APPROVED') then
        raise exception 'Invalid transition from CAPTURING to %', new.status;
      end if;
    elsif old.status = 'RECONCILING' then
      if new.status = 'FAILED' then
        if not (v_is_privileged_service and v_is_reconciliation_active) then
          raise exception 'Invalid transition from RECONCILING to %', new.status;
        end if;
      elsif new.status not in ('COMPLETED', 'BUYER_APPROVED', 'RECONCILIATION_REQUIRED') then
        raise exception 'Invalid transition from RECONCILING to %', new.status;
      end if;
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
-- 3. CLAIM PAYPAL WEBHOOK EVENT RPC (ATOMIC DEDUPLICATION & LEASE FENCING)
-- ============================================================================

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
  v_clean_resource_type := substr(trim(coalesce(p_resource_type, '')), 1, 128);
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
    nullif(v_clean_resource_type, ''),
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

  -- 10. Claim lease for processing
  update public.provider_webhook_events
  set status = 'PROCESSING',
      processing_outcome = 'PROCESSING',
      signature_verified = true,
      resource_type = coalesce(nullif(v_clean_resource_type, ''), resource_type),
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
-- 4. FINALIZE PAYPAL WEBHOOK EVENT RPC
-- ============================================================================

create or replace function public.finalize_paypal_webhook_event(
  p_event_row_id uuid,
  p_status text,
  p_processing_outcome text,
  p_payment_intent_id uuid default null,
  p_payment_transaction_id uuid default null,
  p_payment_mode text default null,
  p_resource_id text default null,
  p_error_details text default null,
  p_retry_delay_seconds integer default 60,
  p_sanitized_metadata jsonb default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_clean_status text;
  v_clean_outcome text;
  v_clean_mode text;
  v_retry_delay integer;
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
    return jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED');
  end if;

  if p_event_row_id is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_status := upper(trim(coalesce(p_status, '')));
  v_clean_outcome := upper(trim(coalesce(p_processing_outcome, '')));
  v_clean_mode := upper(trim(coalesce(p_payment_mode, '')));

  if v_clean_status not in ('PROCESSED', 'RETRY', 'FAILED') then
    return jsonb_build_object('success', false, 'error', 'INVALID_WEBHOOK_STATUS');
  end if;

  if v_clean_outcome not in ('VERIFIED', 'PROCESSED', 'DUPLICATE', 'FAILED', 'REQUIRES_RECONCILIATION') then
    return jsonb_build_object('success', false, 'error', 'INVALID_PROCESSING_OUTCOME');
  end if;

  if v_clean_mode <> '' and v_clean_mode not in ('PLATFORM', 'MERCHANT') then
    return jsonb_build_object('success', false, 'error', 'INVALID_PAYMENT_MODE');
  end if;

  v_retry_delay := greatest(5, least(coalesce(p_retry_delay_seconds, 60), 86400));

  update public.provider_webhook_events
  set status = v_clean_status,
      processing_outcome = v_clean_outcome,
      payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id),
      payment_transaction_id = coalesce(p_payment_transaction_id, payment_transaction_id),
      payment_mode = coalesce(nullif(v_clean_mode, ''), payment_mode),
      resource_id = coalesce(nullif(substr(trim(coalesce(p_resource_id, '')), 1, 128), ''), resource_id),
      lease_expires_at = null,
      error_details = case when p_error_details is not null then substr(p_error_details, 1, 500) else null end,
      last_processed_at = now(),
      processed_at = case when v_clean_status = 'PROCESSED' then coalesce(processed_at, now()) else processed_at end,
      next_attempt_at = case
        when v_clean_status = 'RETRY' then clock_timestamp() + make_interval(secs => v_retry_delay)
        else null
      end,
      retry_count = case when v_clean_status = 'RETRY' then retry_count + 1 else retry_count end,
      sanitized_metadata = case
        when p_sanitized_metadata is not null then coalesce(sanitized_metadata, '{}'::jsonb) || p_sanitized_metadata
        else sanitized_metadata
      end
  where id = p_event_row_id;

  if not found then
    return jsonb_build_object('success', false, 'error', 'WEBHOOK_EVENT_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'success', true,
    'event_row_id', p_event_row_id,
    'status', v_clean_status,
    'processing_outcome', v_clean_outcome
  );
end;
$$;

revoke all on function public.finalize_paypal_webhook_event(
  uuid, text, text, uuid, uuid, text, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_paypal_webhook_event(
  uuid, text, text, uuid, uuid, text, text, text, integer, jsonb
) to service_role;

-- ============================================================================
-- 5. RECORD CHECKOUT.ORDER.APPROVED WEBHOOK TRANSITION RPC
-- ============================================================================

create or replace function public.record_paypal_webhook_order_approved(
  p_payment_intent_id uuid,
  p_provider_order_id text,
  p_provider_event_id text,
  p_event_created_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.payment_intents%rowtype;
  v_clean_order_id text;
  v_clean_event_id text;
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
  v_clean_event_id := trim(coalesce(p_provider_event_id, ''));

  if p_payment_intent_id is null or v_clean_order_id = '' or v_clean_event_id = '' then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  if v_intent.provider_order_id is null or v_intent.provider_order_id <> v_clean_order_id then
    return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISMATCH');
  end if;

  -- Out-of-order / already-progressed protection: never regress advanced or terminal states
  if v_intent.status in (
    'BUYER_APPROVED',
    'CAPTURING',
    'RECONCILING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'RECONCILIATION_REQUIRED'
  ) then
    return jsonb_build_object(
      'success', true,
      'transitioned', false,
      'stale_or_duplicate', true,
      'current_status', v_intent.status
    );
  end if;

  if v_intent.status <> 'ORDER_CREATED' then
    return jsonb_build_object(
      'success', false,
      'error', 'INVALID_INTENT_STATUS',
      'current_status', v_intent.status
    );
  end if;

  update public.payment_intents
  set status = 'BUYER_APPROVED',
      updated_at = now()
  where id = v_intent.id;

  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    'System',
    'payment.webhook_order_approved',
    'PayPal webhook confirmed buyer approval for order ' || v_clean_order_id,
    jsonb_build_object(
      'paymentIntentId', v_intent.id,
      'milestoneId', v_intent.milestone_id,
      'providerOrderId', v_clean_order_id,
      'providerEventId', v_clean_event_id,
      'eventCreatedAt', p_event_created_at
    )
  );

  return jsonb_build_object(
    'success', true,
    'transitioned', true,
    'current_status', 'BUYER_APPROVED'
  );
end;
$$;

revoke all on function public.record_paypal_webhook_order_approved(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_paypal_webhook_order_approved(uuid, text, text, timestamptz) to service_role;

-- ============================================================================
-- 6. RECORD PAYPAL CAPTURE STATE WEBHOOK RPC (PENDING / DENIED)
-- ============================================================================

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

  -- Lock payment intent row
  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  -- Validate order & payee & financial bindings
  if v_intent.provider_order_id is not null and v_clean_order_id <> '' and v_intent.provider_order_id <> v_clean_order_id then
    return jsonb_build_object('success', false, 'error', 'ORDER_ID_MISMATCH');
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

  if v_clean_status = 'PENDING' then
    if v_intent.status in ('FAILED', 'CANCELLED') then
      return jsonb_build_object(
        'success', false,
        'error', 'TERMINAL_INTENT_CONFLICT',
        'current_status', v_intent.status
      );
    end if;

    if v_existing_tx.id is not null then
      v_tx_id := v_existing_tx.id;
    else
      -- Check if another PENDING capture already exists on this intent
      select * into v_other_pending_tx
      from public.payment_transactions
      where payment_intent_id = v_intent.id
        and transaction_type = 'CAPTURE'
        and status = 'PENDING'
      limit 1;

      if found then
        return jsonb_build_object('success', false, 'error', 'CAPTURE_ID_CONFLICT');
      end if;

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

    update public.payment_intents
    set status = 'RECONCILIATION_REQUIRED',
        reconciliation_reason = 'PAYPAL_CAPTURE_PENDING',
        provider_order_id = coalesce(provider_order_id, nullif(v_clean_order_id, '')),
        capture_lease_expires_at = null,
        capture_lease_token = null,
        updated_at = now()
    where id = v_intent.id;

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
        'providerEventId', v_clean_event_id
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

  if v_intent.status <> 'FAILED' then
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
  end if;

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
      'providerEventId', v_clean_event_id
    )
  );

  return jsonb_build_object(
    'success', true,
    'transitioned', (v_intent.status <> 'FAILED'),
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
-- 7. SYNC admin_reprocess_webhook_event WITH R4 TRACKING COLUMNS
-- ============================================================================

create or replace function public.admin_reprocess_webhook_event(
  p_webhook_event_id uuid,
  p_payment_intent_id uuid,
  p_status text,
  p_error_details text default null,
  p_actor text default 'operator'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.provider_webhook_events%rowtype;
  v_intent public.payment_intents%rowtype;
  v_clean_status text;
  v_actor text;
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

  if p_webhook_event_id is null or p_payment_intent_id is null or p_status is null then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  v_clean_status := upper(trim(p_status));
  if v_clean_status not in ('PROCESSED', 'FAILED') then
    return jsonb_build_object('success', false, 'error', 'INVALID_WEBHOOK_STATUS');
  end if;

  select * into v_event
  from public.provider_webhook_events
  where id = p_webhook_event_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'WEBHOOK_EVENT_NOT_FOUND');
  end if;

  if not v_event.signature_verified then
    return jsonb_build_object('success', false, 'error', 'UNVERIFIED_WEBHOOK_EVENT');
  end if;

  select * into v_intent
  from public.payment_intents
  where id = p_payment_intent_id
  for share;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTENT_NOT_FOUND');
  end if;

  v_actor := substr(trim(coalesce(p_actor, 'operator')), 1, 100);

  update public.provider_webhook_events
  set status = v_clean_status,
      processing_outcome = case when v_clean_status = 'PROCESSED' then 'PROCESSED' else 'FAILED' end,
      payment_intent_id = coalesce(payment_intent_id, v_intent.id),
      processed_at = case when v_clean_status = 'PROCESSED' then now() else null end,
      last_processed_at = now(),
      error_details = case when p_error_details is not null then substr(p_error_details, 1, 500) else null end,
      lease_expires_at = null
  where id = v_event.id;

  insert into public.activity_events (project_id, actor_label, event_type, summary, metadata)
  values (
    v_intent.project_id,
    v_actor,
    'payment.webhook_reprocessed',
    'Webhook event ' || v_event.provider_event_id || ' reprocessed with outcome ' || v_clean_status,
    jsonb_build_object(
      'webhookEventId', v_event.id,
      'providerEventId', v_event.provider_event_id,
      'eventType', v_event.event_type,
      'paymentIntentId', v_intent.id,
      'resultingWebhookStatus', v_clean_status,
      'actor', v_actor
    )
  );

  return jsonb_build_object(
    'success', true,
    'webhook_event_id', v_event.id,
    'status', v_clean_status
  );
end;
$$;

revoke all on function public.admin_reprocess_webhook_event(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_reprocess_webhook_event(uuid, uuid, text, text, text) to service_role;
