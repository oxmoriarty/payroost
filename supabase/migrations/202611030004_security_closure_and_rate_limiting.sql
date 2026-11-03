-- Payroost Phase 2B: Security Closure and Workflow Hardening
-- Enforces:
-- 1. Database-backed persistent atomic rate limiting (public.rate_limit_buckets & consume_rate_limit).
-- 2. Disallowing project owner email as client email (preventing trivial single-account self-approval).
-- 3. Strict column-level privilege lockdown on public.projects and public.agreement_versions,
--    ensuring custom transaction settings cannot be used as an authorization bypass.
-- 4. Strict binding of OTP challenges to project, agreement version, action, and verified client email.
-- 5. Owner session rejection in submit_public_review_with_otp (defense-in-depth).

-- ============================================================================
-- 1. Persistent Atomic Rate Limiting
-- ============================================================================

create table if not exists public.rate_limit_buckets (
  bucket_key text primary key,
  count integer not null default 1 check (count >= 1),
  reset_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_buckets_reset_idx
  on public.rate_limit_buckets(reset_at);

alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from public, anon, authenticated;

-- Atomic rate limiter RPC using PostgreSQL row-level locks on upsert
create or replace function public.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_row public.rate_limit_buckets%rowtype;
  v_allowed boolean;
  v_reset_at timestamptz;
begin
  -- Periodic opportunistic cleanup of expired buckets (approx 2% of calls)
  if (random() < 0.02) then
    delete from public.rate_limit_buckets where reset_at < v_now;
  end if;

  insert into public.rate_limit_buckets as b (bucket_key, count, reset_at)
  values (p_key, 1, v_now + (p_window_seconds || ' seconds')::interval)
  on conflict (bucket_key) do update
  set
    count = case
      when b.reset_at <= v_now then 1
      else b.count + 1
    end,
    reset_at = case
      when b.reset_at <= v_now then v_now + (p_window_seconds || ' seconds')::interval
      else b.reset_at
    end
  returning * into v_row;

  v_allowed := (v_row.count <= p_limit);
  v_reset_at := v_row.reset_at;

  return jsonb_build_object(
    'allowed', v_allowed,
    'current', v_row.count,
    'limit', p_limit,
    'resetAt', v_reset_at
  );
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer) to anon, authenticated;

-- ============================================================================
-- 2. Prevent Freelancer from Setting Client Email to Their Own Email
-- ============================================================================

create or replace function public.protect_project_verified_client_email()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_owner_email text;
begin
  -- Check: Disallow client_email matching the project owner's registered email
  select email into v_owner_email from auth.users where id = new.owner_id;
  if v_owner_email is not null and lower(trim(new.client_email)) = lower(trim(v_owner_email)) then
    raise exception 'Client email cannot be identical to the project owner email';
  end if;

  -- Prevent direct modification of client_email_verified_at unless internal verification flag is set
  if (old.client_email_verified_at is distinct from new.client_email_verified_at) then
    if current_setting('payroost.verification_active', true) is distinct from 'true' then
      raise exception 'Client email verification status cannot be updated directly';
    end if;
  end if;

  -- If client_email changes:
  if (old.client_email is distinct from new.client_email) then
    -- Reset verification status
    new.client_email_verified_at := null;

    -- Invalidate existing active review links for this project
    update public.review_links
    set revoked_at = now()
    where project_id = old.id and revoked_at is null;

    -- Invalidate existing unconsumed verification tokens
    update public.client_email_verifications
    set consumed_at = now()
    where project_id = old.id and consumed_at is null;

    -- Invalidate existing unconsumed OTP challenges
    update public.review_link_otp_challenges
    set consumed_at = now()
    where project_id = old.id and consumed_at is null;

    -- Record activity audit event
    insert into public.activity_events (project_id, actor_label, event_type, summary)
    values (
      old.id,
      'System',
      'client_email.changed',
      'Client email changed to ' || new.client_email || '; verification and active links invalidated.'
    );
  end if;

  return new;
end;
$$;

-- Also prevent owner email as client email on project INSERT
create or replace function public.check_new_project_client_email()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_owner_email text;
begin
  select email into v_owner_email from auth.users where id = new.owner_id;
  if v_owner_email is not null and lower(trim(new.client_email)) = lower(trim(v_owner_email)) then
    raise exception 'Client email cannot be identical to the project owner email';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_check_client_email_insert on public.projects;
create trigger projects_check_client_email_insert
  before insert on public.projects
  for each row execute procedure public.check_new_project_client_email();

-- ============================================================================
-- 3. Column-Level Privilege Lockdown (Eliminating Custom Setting Bypass)
-- ============================================================================

-- Explicitly revoke column-level UPDATE on sensitive fields from authenticated and anon
revoke update (client_email_verified_at) on public.projects from public, anon, authenticated;
revoke update (status, approved_at, approved_by_label) on public.agreement_versions from public, anon, authenticated;

-- ============================================================================
-- 4. Hardened OTP Submission with Strict Project & Version Binding
-- ============================================================================

create or replace function public.submit_public_review_with_otp(
  p_token_hash text,
  p_action text,
  p_note text,
  p_otp_hmac text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  link_row public.review_links%rowtype;
  project_row public.projects%rowtype;
  version_row public.agreement_versions%rowtype;
  challenge_row public.review_link_otp_challenges%rowtype;
  client_identity text;
begin
  -- Set transaction-local flag for immutability trigger
  perform set_config('payroost.public_review_active', 'true', true);

  select * into link_row
  from public.review_links
  where token_hash = p_token_hash
  for update;

  if not found or link_row.revoked_at is not null or link_row.expires_at <= now() then
    raise exception 'Review link unavailable';
  end if;

  select * into project_row
  from public.projects
  where id = link_row.project_id
  for update;

  if not found or project_row.client_email_verified_at is null then
    raise exception 'Client email must be verified';
  end if;

  -- Defense-in-depth: Reject approval attempts originating from the project owner's authenticated session
  if auth.uid() is not null and project_row.owner_id = auth.uid() then
    raise exception 'Project owner cannot decide their own agreement';
  end if;

  select * into version_row
  from public.agreement_versions
  where id = link_row.agreement_version_id
  for update;

  if not found or version_row.status <> 'PENDING_CLIENT' then
    raise exception 'Agreement already decided';
  end if;

  -- Locate active challenge with strict multi-column binding:
  -- Must match review_link_id, action, project_id, AND agreement_version_id
  select * into challenge_row
  from public.review_link_otp_challenges
  where review_link_id = link_row.id
    and action = p_action
    and project_id = link_row.project_id
    and agreement_version_id = version_row.id
    and consumed_at is null
    and expires_at > now()
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Active OTP challenge required';
  end if;

  if challenge_row.attempts >= 3 then
    raise exception 'OTP challenge exhausted';
  end if;

  -- Validate OTP HMAC
  if challenge_row.otp_hmac <> p_otp_hmac then
    update public.review_link_otp_challenges
    set attempts = attempts + 1
    where id = challenge_row.id;

    if (challenge_row.attempts + 1) >= 3 then
      raise exception 'Incorrect OTP code. Challenge exhausted.';
    else
      raise exception 'Incorrect OTP code';
    end if;
  end if;

  -- Mark OTP challenge consumed
  update public.review_link_otp_challenges
  set consumed_at = now()
  where id = challenge_row.id;

  -- Derived verified reviewer identity (untrusted actorLabel strictly rejected)
  client_identity := 'Client (' || project_row.client_email || ')';

  if p_action = 'APPROVE' then
    update public.agreement_versions
    set status = 'APPROVED',
        approved_at = now(),
        approved_by_label = client_identity
    where id = version_row.id;

    update public.agreements
    set status = 'APPROVED'
    where id = version_row.agreement_id;

    update public.projects
    set status = 'ACTIVE'
    where id = link_row.project_id and status in ('DRAFT', 'AWAITING_CLIENT');

    insert into public.activity_events (project_id, actor_label, event_type, summary)
    values (
      link_row.project_id,
      client_identity,
      'agreement.approved',
      'Approved agreement version ' || version_row.version_number
    );

    update public.review_links
    set revoked_at = now()
    where id = link_row.id;

    return 'APPROVED';

  elsif p_action = 'REQUEST_CHANGES' then
    if char_length(trim(coalesce(p_note, ''))) < 3 then
      raise exception 'Change request note required';
    end if;

    insert into public.change_requests (
      project_id,
      agreement_version_id,
      review_link_id,
      request_text,
      submitted_by_label
    ) values (
      link_row.project_id,
      version_row.id,
      link_row.id,
      trim(p_note),
      client_identity
    );

    update public.agreement_versions
    set status = 'CHANGES_REQUESTED'
    where id = version_row.id;

    update public.agreements
    set status = 'CHANGES_REQUESTED'
    where id = version_row.agreement_id;

    insert into public.activity_events (project_id, actor_label, event_type, summary)
    values (
      link_row.project_id,
      client_identity,
      'agreement.changes_requested',
      'Requested changes to agreement version ' || version_row.version_number
    );

    update public.review_links
    set revoked_at = now()
    where id = link_row.id;

    return 'CHANGES_REQUESTED';

  else
    raise exception 'Unsupported review action';
  end if;
end;
$$;
