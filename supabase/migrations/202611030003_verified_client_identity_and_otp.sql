-- Payroost Phase 2A.4: Verified Client Identity and Secure Agreement Decisions
-- Enforces:
-- 1. Client email verification prior to agreement submission for review.
-- 2. Immutability/protection of verified client email against unauthorized modification.
-- 3. Automatic invalidation of verifications, review links, and challenges upon client email change.
-- 4. Server-controlled review-link creation (revoking direct client INSERT on review_links).
-- 5. Enforcing exactly one active review link per agreement version.
-- 6. OTP challenge storage and atomic verification with attempts cap.
-- 7. Secure reviewer attribution strictly derived from verified client email.

-- ============================================================================
-- 1. Projects: Client Email Verification Column and Protection Trigger
-- ============================================================================

alter table public.projects
  add column if not exists client_email_verified_at timestamptz default null;

-- Trigger to protect verified email status and handle client email changes
create or replace function public.protect_project_verified_client_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
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

drop trigger if exists projects_protect_verified_email on public.projects;
create trigger projects_protect_verified_email
  before update on public.projects
  for each row execute procedure public.protect_project_verified_client_email();

-- ============================================================================
-- 2. Client Email Verifications Table
-- ============================================================================

create table if not exists public.client_email_verifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  client_email text not null check (char_length(client_email) <= 320),
  token_hash text not null unique check (char_length(token_hash) = 64),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists client_email_verifications_token_idx
  on public.client_email_verifications(token_hash)
  where (consumed_at is null);

alter table public.client_email_verifications enable row level security;
revoke all on public.client_email_verifications from public, anon, authenticated;

-- RPC to create a client verification token (called by server when project created or email resent)
create or replace function public.create_client_email_verification(
  p_project_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  project_row public.projects%rowtype;
begin
  select * into project_row from public.projects where id = p_project_id;
  if not found then
    raise exception 'Project not found';
  end if;

  -- Ensure caller is project owner
  if auth.uid() is null or project_row.owner_id <> auth.uid() then
    raise exception 'Forbidden: Only the project owner can request verification';
  end if;

  -- Invalidate previous unconsumed verification tokens for this project
  update public.client_email_verifications
  set consumed_at = now()
  where project_id = p_project_id and consumed_at is null;

  insert into public.client_email_verifications (
    project_id,
    client_email,
    token_hash,
    expires_at
  ) values (
    p_project_id,
    project_row.client_email,
    p_token_hash,
    p_expires_at
  );

  return jsonb_build_object(
    'projectId', project_row.id,
    'clientEmail', project_row.client_email
  );
end;
$$;

revoke all on function public.create_client_email_verification(uuid, text, timestamptz) from public;
grant execute on function public.create_client_email_verification(uuid, text, timestamptz) to authenticated;

-- RPC to verify client email via token hash
create or replace function public.verify_client_email(
  p_token_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  verif_row public.client_email_verifications%rowtype;
  project_row public.projects%rowtype;
begin
  select * into verif_row
  from public.client_email_verifications
  where token_hash = p_token_hash
  for update;

  if not found or verif_row.consumed_at is not null or verif_row.expires_at <= now() then
    raise exception 'Verification token invalid or expired';
  end if;

  select * into project_row
  from public.projects
  where id = verif_row.project_id
  for update;

  if not found then
    raise exception 'Project not found';
  end if;

  -- Mark verification token as consumed
  update public.client_email_verifications
  set consumed_at = now()
  where id = verif_row.id;

  -- Set transaction flag so the trigger permits updating client_email_verified_at
  perform set_config('payroost.verification_active', 'true', true);

  -- Update verified timestamp
  update public.projects
  set client_email_verified_at = now()
  where id = project_row.id and client_email = verif_row.client_email;

  -- Record activity audit event
  insert into public.activity_events (project_id, actor_label, event_type, summary)
  values (
    project_row.id,
    'Client',
    'client_email.verified',
    'Client email verified (' || verif_row.client_email || ')'
  );

  return jsonb_build_object(
    'projectId', project_row.id,
    'clientEmail', verif_row.client_email,
    'projectTitle', project_row.title
  );
end;
$$;

revoke all on function public.verify_client_email(text) from public;
grant execute on function public.verify_client_email(text) to anon, authenticated;

-- ============================================================================
-- 3. Review Link Creation Hardening
-- ============================================================================

-- Revoke direct INSERT on review_links from authenticated (fixes Attack Path B)
revoke insert on public.review_links from authenticated;

-- Enforce exactly one active review link per agreement version
create unique index if not exists review_links_active_version_idx
  on public.review_links(agreement_version_id)
  where (revoked_at is null);

-- RPC for secure review link creation
create or replace function public.create_project_review_link(
  p_project_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  project_row public.projects%rowtype;
  agreement_row public.agreements%rowtype;
  version_row public.agreement_versions%rowtype;
  new_link_id uuid;
begin
  select * into project_row from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'Project not found';
  end if;

  -- Owner authorization check
  if auth.uid() is null or project_row.owner_id <> auth.uid() then
    raise exception 'Forbidden: Only the project owner can send agreements for review';
  end if;

  -- MANDATORY CHECK: Client email must be verified
  if project_row.client_email_verified_at is null then
    raise exception 'Client email must be verified before sending agreement for review';
  end if;

  select * into agreement_row from public.agreements where project_id = project_row.id for update;
  if not found or agreement_row.current_version_id is null then
    raise exception 'No agreement draft exists for this project';
  end if;

  select * into version_row from public.agreement_versions where id = agreement_row.current_version_id for update;
  if not found or version_row.status <> 'DRAFT' then
    raise exception 'Agreement is not in sendable draft status';
  end if;

  -- Revoke any existing active links for this version
  update public.review_links
  set revoked_at = now()
  where agreement_version_id = version_row.id and revoked_at is null;

  -- Insert new review link
  insert into public.review_links (
    project_id,
    agreement_version_id,
    token_hash,
    intended_email,
    expires_at
  ) values (
    project_row.id,
    version_row.id,
    p_token_hash,
    project_row.client_email,
    p_expires_at
  ) returning id into new_link_id;

  -- Transition agreement version and agreement
  update public.agreement_versions
  set status = 'PENDING_CLIENT', sent_at = now()
  where id = version_row.id;

  update public.agreements
  set status = 'PENDING_CLIENT'
  where id = agreement_row.id;

  update public.projects
  set status = 'AWAITING_CLIENT'
  where id = project_row.id and status in ('DRAFT', 'AWAITING_CLIENT');

  -- Record activity audit event
  insert into public.activity_events (project_id, actor_label, event_type, summary)
  values (
    project_row.id,
    'Freelancer',
    'agreement.sent',
    'Sent agreement version ' || version_row.version_number || ' for client review'
  );

  return new_link_id;
end;
$$;

revoke all on function public.create_project_review_link(uuid, text, timestamptz) from public;
grant execute on function public.create_project_review_link(uuid, text, timestamptz) to authenticated;

-- ============================================================================
-- 4. OTP Challenges Table
-- ============================================================================

create table if not exists public.review_link_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  review_link_id uuid not null references public.review_links(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  agreement_version_id uuid not null references public.agreement_versions(id) on delete cascade,
  client_email text not null check (char_length(client_email) <= 320),
  action text not null check (action in ('APPROVE', 'REQUEST_CHANGES')),
  otp_hmac text not null check (char_length(otp_hmac) = 64),
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists review_link_otp_challenges_active_idx
  on public.review_link_otp_challenges(review_link_id, action)
  where (consumed_at is null);

alter table public.review_link_otp_challenges enable row level security;
revoke all on public.review_link_otp_challenges from public, anon, authenticated;

-- RPC to request an OTP challenge for an action
create or replace function public.request_review_otp(
  p_token_hash text,
  p_action text,
  p_otp_hmac text,
  p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  link_row public.review_links%rowtype;
  project_row public.projects%rowtype;
  version_row public.agreement_versions%rowtype;
begin
  if p_action not in ('APPROVE', 'REQUEST_CHANGES') then
    raise exception 'Invalid review action for OTP request';
  end if;

  select * into link_row
  from public.review_links
  where token_hash = p_token_hash
  for update;

  if not found or link_row.revoked_at is not null or link_row.expires_at <= now() then
    raise exception 'Review link unavailable';
  end if;

  select * into project_row
  from public.projects
  where id = link_row.project_id;

  if not found or project_row.client_email_verified_at is null then
    raise exception 'Client email must be verified';
  end if;

  select * into version_row
  from public.agreement_versions
  where id = link_row.agreement_version_id;

  if not found or version_row.status <> 'PENDING_CLIENT' then
    raise exception 'Agreement is not awaiting client decision';
  end if;

  -- Invalidate previous unconsumed challenges for this review link
  update public.review_link_otp_challenges
  set consumed_at = now()
  where review_link_id = link_row.id and consumed_at is null;

  -- Insert new challenge
  insert into public.review_link_otp_challenges (
    review_link_id,
    project_id,
    agreement_version_id,
    client_email,
    action,
    otp_hmac,
    expires_at
  ) values (
    link_row.id,
    link_row.project_id,
    link_row.agreement_version_id,
    project_row.client_email,
    p_action,
    p_otp_hmac,
    p_expires_at
  );

  return jsonb_build_object(
    'clientEmail', project_row.client_email,
    'projectTitle', project_row.title
  );
end;
$$;

revoke all on function public.request_review_otp(text, text, text, timestamptz) from public;
grant execute on function public.request_review_otp(text, text, text, timestamptz) to anon, authenticated;

-- ============================================================================
-- 5. Submit Public Review with OTP & Verified Identity Attribution
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
  -- Set transaction-local flag so immutability trigger permits authorized review transition
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

  select * into version_row
  from public.agreement_versions
  where id = link_row.agreement_version_id
  for update;

  if not found or version_row.status <> 'PENDING_CLIENT' then
    raise exception 'Agreement already decided';
  end if;

  -- Locate active challenge for this review link and action
  select * into challenge_row
  from public.review_link_otp_challenges
  where review_link_id = link_row.id
    and action = p_action
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

revoke all on function public.submit_public_review_with_otp(text, text, text, text) from public;
grant execute on function public.submit_public_review_with_otp(text, text, text, text) to anon, authenticated;

-- Deprecate legacy submit_public_review to force OTP authentication
create or replace function public.submit_public_review(
  p_token_hash text, p_action text, p_note text, p_actor_label text
) returns text language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'OTP authentication required. Use submit_public_review_with_otp.';
end;
$$;

revoke all on function public.submit_public_review(text, text, text, text) from public;
grant execute on function public.submit_public_review(text, text, text, text) to anon, authenticated;
