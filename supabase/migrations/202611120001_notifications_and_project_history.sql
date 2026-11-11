-- PayRoost Phase P2: Persistent Notifications & Project History Hardening
-- Local migration only (not applied remotely in P2).
--
-- Enhances the platform with:
-- 1. public.notifications table supporting both authenticated freelancer users ('USER')
--    and verified client portal recipients ('CLIENT_PORTAL').
-- 2. Strict server-controlled creation, partial unique idempotency indexes, RLS isolation,
--    column-level UPDATE(read_at) restriction, and immutability trigger preventing tampering
--    with ownership, event identity, metadata, or notification content.
-- 3. SECURITY DEFINER AFTER INSERT trigger on public.activity_events that projects
--    authoritative workflow, scope-change, and R3/R4/R5 payment/webhook/reconciliation events
--    into idempotent notifications without modifying existing payment RPCs or webhook logic.

-- ============================================================================
-- 1. PUBLIC.NOTIFICATIONS TABLE
-- ============================================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_activity_event_id uuid references public.activity_events(id) on delete set null,
  recipient_type text not null check (recipient_type in ('USER', 'CLIENT_PORTAL')),
  recipient_user_id uuid references public.profiles(id) on delete cascade,
  recipient_client_email text check (
    recipient_client_email is null
    or (
      recipient_client_email = lower(trim(recipient_client_email))
      and char_length(recipient_client_email) between 3 and 320
    )
  ),
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 3 and 240),
  category text not null check (
    category in ('PROJECT', 'AGREEMENT', 'MILESTONE', 'SCOPE_CHANGE', 'PAYMENT', 'RECONCILIATION')
  ),
  event_type text not null check (char_length(trim(event_type)) between 3 and 100),
  severity text not null default 'INFO' check (
    severity in ('INFO', 'ACTION_REQUIRED', 'SUCCESS', 'WARNING')
  ),
  title text not null check (char_length(trim(title)) between 2 and 160),
  body text not null check (char_length(trim(body)) between 2 and 500),
  action_required boolean not null default false,
  action_label text check (action_label is null or char_length(trim(action_label)) between 1 and 80),
  action_href text check (
    action_href is null
    or (char_length(trim(action_href)) between 1 and 300 and left(action_href, 1) = '/')
  ),
  actor_label text not null default 'System' check (char_length(trim(actor_label)) between 1 and 140),
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_recipient_consistency_check check (
    (recipient_type = 'USER' and recipient_user_id is not null and recipient_client_email is null)
    or
    (recipient_type = 'CLIENT_PORTAL' and recipient_user_id is null and recipient_client_email is not null)
  )
);

-- Idempotency indexes prevent duplicate notifications across retries/replays
create unique index if not exists notifications_user_idempotency_idx
  on public.notifications(recipient_user_id, idempotency_key)
  where (recipient_type = 'USER');

create unique index if not exists notifications_client_idempotency_idx
  on public.notifications(project_id, recipient_client_email, idempotency_key)
  where (recipient_type = 'CLIENT_PORTAL');

-- Efficient paginated listing & unread count indexes
create index if not exists notifications_user_created_idx
  on public.notifications(recipient_user_id, created_at desc)
  where (recipient_type = 'USER');

create index if not exists notifications_user_unread_idx
  on public.notifications(recipient_user_id, created_at desc)
  where (recipient_type = 'USER' and read_at is null);

create index if not exists notifications_client_created_idx
  on public.notifications(project_id, recipient_client_email, created_at desc)
  where (recipient_type = 'CLIENT_PORTAL');

create index if not exists notifications_client_unread_idx
  on public.notifications(project_id, recipient_client_email, created_at desc)
  where (recipient_type = 'CLIENT_PORTAL' and read_at is null);

create index if not exists notifications_project_created_idx
  on public.notifications(project_id, created_at desc);

-- ============================================================================
-- 2. RLS & COLUMN/TRIGGER IMMUTABILITY PROTECTION
-- ============================================================================

alter table public.notifications enable row level security;

revoke all on public.notifications from public, anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant all on public.notifications to service_role;

drop policy if exists "notifications_user_select_own" on public.notifications;
create policy "notifications_user_select_own"
  on public.notifications for select
  to authenticated
  using (
    recipient_type = 'USER'
    and recipient_user_id = (select auth.uid())
  );

drop policy if exists "notifications_user_mark_read" on public.notifications;
create policy "notifications_user_mark_read"
  on public.notifications for update
  to authenticated
  using (
    recipient_type = 'USER'
    and recipient_user_id = (select auth.uid())
  )
  with check (
    recipient_type = 'USER'
    and recipient_user_id = (select auth.uid())
  );

create or replace function public.protect_notification_immutable_fields()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (
    old.id <> new.id or
    old.project_id <> new.project_id or
    (old.source_activity_event_id is distinct from new.source_activity_event_id and new.source_activity_event_id is not null) or
    old.recipient_type <> new.recipient_type or
    old.recipient_user_id is distinct from new.recipient_user_id or
    old.recipient_client_email is distinct from new.recipient_client_email or
    old.idempotency_key <> new.idempotency_key or
    old.category <> new.category or
    old.event_type <> new.event_type or
    old.severity <> new.severity or
    old.title <> new.title or
    old.body <> new.body or
    old.action_required <> new.action_required or
    old.action_label is distinct from new.action_label or
    old.action_href is distinct from new.action_href or
    old.actor_label <> new.actor_label or
    old.metadata <> new.metadata or
    old.created_at <> new.created_at
  ) then
    raise exception 'Notification ownership, identity, and content fields are immutable';
  end if;

  -- Preserve original read timestamp once read
  if old.read_at is not null and new.read_at is distinct from old.read_at then
    new.read_at := old.read_at;
  end if;

  return new;
end;
$$;

drop trigger if exists notifications_protect_immutable_fields on public.notifications;
create trigger notifications_protect_immutable_fields
  before update on public.notifications
  for each row execute procedure public.protect_notification_immutable_fields();

-- ============================================================================
-- 3. AUTHORITATIVE ACTIVITY -> NOTIFICATION PROJECTION TRIGGER
-- ============================================================================

create or replace function public.safe_insert_user_notification(
  p_project_id uuid,
  p_source_activity_event_id uuid,
  p_recipient_user_id uuid,
  p_idempotency_key text,
  p_category text,
  p_event_type text,
  p_severity text,
  p_title text,
  p_body text,
  p_action_required boolean,
  p_action_label text,
  p_action_href text,
  p_actor_label text,
  p_metadata jsonb,
  p_created_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_recipient_user_id is null then
    return;
  end if;

  insert into public.notifications (
    project_id,
    source_activity_event_id,
    recipient_type,
    recipient_user_id,
    recipient_client_email,
    idempotency_key,
    category,
    event_type,
    severity,
    title,
    body,
    action_required,
    action_label,
    action_href,
    actor_label,
    metadata,
    created_at
  ) values (
    p_project_id,
    p_source_activity_event_id,
    'USER',
    p_recipient_user_id,
    null,
    left(trim(p_idempotency_key), 240),
    p_category,
    left(trim(p_event_type), 100),
    p_severity,
    left(coalesce(nullif(trim(p_title), ''), 'Project notification'), 160),
    left(coalesce(nullif(trim(p_body), ''), 'Project activity recorded.'), 500),
    p_action_required,
    nullif(left(trim(coalesce(p_action_label, '')), 80), ''),
    case
      when p_action_href is not null and left(trim(p_action_href), 1) = '/'
      then left(trim(p_action_href), 300)
      else null
    end,
    left(coalesce(nullif(trim(p_actor_label), ''), 'System'), 140),
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_created_at, now())
  )
  on conflict (recipient_user_id, idempotency_key)
    where (recipient_type = 'USER')
  do nothing;
end;
$$;

create or replace function public.safe_insert_client_notification(
  p_project_id uuid,
  p_source_activity_event_id uuid,
  p_client_email text,
  p_idempotency_key text,
  p_category text,
  p_event_type text,
  p_severity text,
  p_title text,
  p_body text,
  p_action_required boolean,
  p_action_label text,
  p_action_href text,
  p_actor_label text,
  p_metadata jsonb,
  p_created_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_clean_email text;
begin
  v_clean_email := lower(trim(coalesce(p_client_email, '')));
  if char_length(v_clean_email) < 3 or char_length(v_clean_email) > 320 then
    return;
  end if;

  insert into public.notifications (
    project_id,
    source_activity_event_id,
    recipient_type,
    recipient_user_id,
    recipient_client_email,
    idempotency_key,
    category,
    event_type,
    severity,
    title,
    body,
    action_required,
    action_label,
    action_href,
    actor_label,
    metadata,
    created_at
  ) values (
    p_project_id,
    p_source_activity_event_id,
    'CLIENT_PORTAL',
    null,
    v_clean_email,
    left(trim(p_idempotency_key), 240),
    p_category,
    left(trim(p_event_type), 100),
    p_severity,
    left(coalesce(nullif(trim(p_title), ''), 'Project update'), 160),
    left(coalesce(nullif(trim(p_body), ''), 'Project activity recorded.'), 500),
    p_action_required,
    nullif(left(trim(coalesce(p_action_label, '')), 80), ''),
    case
      when p_action_href is not null and left(trim(p_action_href), 1) = '/'
      then left(trim(p_action_href), 300)
      else null
    end,
    left(coalesce(nullif(trim(p_actor_label), ''), 'System'), 140),
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_created_at, now())
  )
  on conflict (project_id, recipient_client_email, idempotency_key)
    where (recipient_type = 'CLIENT_PORTAL')
  do nothing;
end;
$$;

revoke all on function public.safe_insert_user_notification(
  uuid, uuid, uuid, text, text, text, text, text, text, boolean, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;

revoke all on function public.safe_insert_client_notification(
  uuid, uuid, text, text, text, text, text, text, text, boolean, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;

create or replace function public.project_activity_event_to_notifications()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_project public.projects%rowtype;
  v_intent_id text;
  v_milestone_id text;
  v_milestone_title text;
  v_version_id text;
  v_version_num text;
  v_change_id text;
  v_requester_role text;
  v_project_href text;
begin
  select * into v_project
  from public.projects
  where id = new.project_id;

  if not found then
    return new;
  end if;

  v_intent_id := nullif(trim(coalesce(new.metadata->>'paymentIntentId', new.metadata->>'intentId', '')), '');
  v_milestone_id := nullif(trim(coalesce(new.metadata->>'milestoneId', '')), '');
  v_milestone_title := nullif(trim(coalesce(new.metadata->>'milestoneTitle', '')), '');
  v_version_id := nullif(trim(coalesce(new.metadata->>'agreementVersionId', '')), '');
  v_version_num := nullif(trim(coalesce(new.metadata->>'versionNumber', new.metadata->>'agreementVersionNumber', '')), '');
  v_change_id := nullif(trim(coalesce(new.metadata->>'changeRequestId', '')), '');
  v_requester_role := upper(trim(coalesce(new.metadata->>'requesterRole', '')));
  v_project_href := '/app/projects/' || new.project_id::text;

  -- Skip non-user-facing internal operational retry/lease/draft-edit noise
  if new.event_type in (
    'agreement.edited',
    'milestone.plan_synced',
    'payment.capture_initiated',
    'payment.clear_expired_lease',
    'payment.expired_lease_cleared',
    'payment.webhook_reprocessed',
    'payment.retry_order_creation',
    'payment.operator_reconcile'
  ) then
    return new;
  end if;

  if new.event_type = 'project.created' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'project.created:' || new.project_id::text,
      'PROJECT', new.event_type, 'INFO',
      'Project created',
      'Created "' || v_project.title || '" and dispatched email verification to ' || v_project.client_name || '.',
      false, 'Open workspace', v_project_href,
      new.actor_label, jsonb_build_object('projectTitle', v_project.title), new.created_at
    );

  elsif new.event_type = 'client_email.verified' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'client_email.verified:' || new.id::text,
      'PROJECT', new.event_type, 'SUCCESS',
      'Client email verified',
      v_project.client_name || ' verified their email on "' || v_project.title || '". You can now send agreements for review.',
      true, 'Prepare agreement', v_project_href || '#agreement',
      'Client', jsonb_build_object('projectTitle', v_project.title), new.created_at
    );

  elsif new.event_type = 'client_email.changed' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'client_email.changed:' || new.id::text,
      'PROJECT', new.event_type, 'WARNING',
      'Client email updated — re-verification required',
      'Client email changed on "' || v_project.title || '". Active review and portal links were invalidated.',
      true, 'Review project', v_project_href,
      new.actor_label, jsonb_build_object('projectTitle', v_project.title), new.created_at
    );

  elsif new.event_type = 'client_email.verification_resent' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'client_email.verification_resent:' || new.id::text,
      'PROJECT', new.event_type, 'INFO',
      'Client verification resent',
      'Resent email verification prompt for "' || v_project.title || '".',
      false, 'Open project', v_project_href,
      new.actor_label, jsonb_build_object('projectTitle', v_project.title), new.created_at
    );

  elsif new.event_type = 'portal.invited' then
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'portal.invited:' || new.id::text,
      'PROJECT', new.event_type, 'INFO',
      'Client portal access ready',
      'You were invited to the verified workspace for "' || v_project.title || '".',
      false, 'View milestones', '/portal#milestones',
      new.actor_label, jsonb_build_object('projectTitle', v_project.title), new.created_at
    );

  elsif new.event_type = 'agreement.version_created' then
    if coalesce((new.metadata->>'isRevision')::boolean, false) then
      perform public.safe_insert_user_notification(
        new.project_id, new.id, v_project.owner_id,
        'agreement.revision:' || coalesce(v_version_id, new.id::text),
        'AGREEMENT', new.event_type, 'INFO',
        'New agreement draft revision created',
        'Agreement v' || coalesce(v_version_num, 'next') || ' draft created on "' || v_project.title || '". Ready to edit and send.',
        true, 'Review draft', v_project_href || '#agreement',
        new.actor_label, jsonb_build_object('agreementVersionId', v_version_id, 'versionNumber', v_version_num), new.created_at
      );
    end if;

  elsif new.event_type = 'agreement.sent' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'agreement.sent:' || coalesce(v_version_id, new.id::text),
      'AGREEMENT', new.event_type, 'INFO',
      'Agreement sent for client review',
      'Sent agreement proposal for "' || v_project.title || '" to ' || v_project.client_name || ' via OTP review.',
      false, 'View agreement', v_project_href || '#agreement',
      new.actor_label, jsonb_build_object('agreementVersionId', v_version_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'agreement.sent:' || coalesce(v_version_id, new.id::text),
      'AGREEMENT', new.event_type, 'ACTION_REQUIRED',
      'Agreement proposal sent for your review',
      'The freelancer sent an agreement version on "' || v_project.title || '" for your review and OTP approval.',
      true, 'Inspect agreement', '/portal#agreement',
      'Freelancer', jsonb_build_object('agreementVersionId', v_version_id), new.created_at
    );

  elsif new.event_type = 'agreement.approved' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'agreement.approved:' || coalesce(v_version_id, new.id::text),
      'AGREEMENT', new.event_type, 'SUCCESS',
      'Agreement approved by client',
      v_project.client_name || ' approved the agreement on "' || v_project.title || '". Milestones are ready for delivery.',
      true, 'View milestones', v_project_href || '#milestones',
      'Client', jsonb_build_object('agreementVersionId', v_version_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'agreement.approved:' || coalesce(v_version_id, new.id::text),
      'AGREEMENT', new.event_type, 'SUCCESS',
      'Agreement approved',
      'Your OTP-verified approval for "' || v_project.title || '" is recorded.',
      false, 'View agreed terms', '/portal#agreement',
      'Client', jsonb_build_object('agreementVersionId', v_version_id), new.created_at
    );

  elsif new.event_type = 'agreement.changes_requested' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'agreement.changes_requested:' || coalesce(v_version_id, new.id::text),
      'AGREEMENT', new.event_type, 'ACTION_REQUIRED',
      'Agreement revision requested',
      v_project.client_name || ' requested changes on "' || v_project.title || '". Review feedback and create a new draft revision.',
      true, 'Create revision', v_project_href || '#agreement',
      'Client', jsonb_build_object('agreementVersionId', v_version_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'agreement.changes_requested:' || coalesce(v_version_id, new.id::text),
      'AGREEMENT', new.event_type, 'INFO',
      'Agreement revision feedback submitted',
      'Your change request feedback on "' || v_project.title || '" has been sent to the freelancer.',
      false, 'View agreement history', '/portal#agreement',
      'Client', jsonb_build_object('agreementVersionId', v_version_id), new.created_at
    );

  elsif new.event_type = 'milestone.submitted' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'milestone.submitted:' || new.id::text,
      'MILESTONE', new.event_type, 'INFO',
      'Deliverables submitted for review',
      'Submitted "' || coalesce(v_milestone_title, 'milestone') || '" on "' || v_project.title || '" for client review.',
      false, 'View milestone', v_project_href || '#milestones',
      new.actor_label, jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'milestone.submitted:' || new.id::text,
      'MILESTONE', new.event_type, 'ACTION_REQUIRED',
      'Deliverables ready for your review',
      'Deliverables were submitted for "' || coalesce(v_milestone_title, 'a milestone') || '" on "' || v_project.title || '".',
      true, 'Review deliverable', '/portal#milestones',
      'Freelancer', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );

  elsif new.event_type = 'milestone.accepted' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'milestone.accepted:' || coalesce(v_milestone_id, new.id::text),
      'MILESTONE', new.event_type, 'SUCCESS',
      'Milestone deliverables accepted',
      v_project.client_name || ' accepted deliverables for "' || coalesce(v_milestone_title, 'milestone') || '" on "' || v_project.title || '".',
      false, 'View milestones', v_project_href || '#milestones',
      'Client', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'milestone.accepted:' || coalesce(v_milestone_id, new.id::text),
      'MILESTONE', new.event_type, 'SUCCESS',
      'Deliverables accepted',
      'Acceptance recorded for "' || coalesce(v_milestone_title, 'milestone') || '" on "' || v_project.title || '".',
      false, 'View milestones', '/portal#milestones',
      'Client', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );

  elsif new.event_type = 'milestone.revision_requested' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'milestone.revision_requested:' || new.id::text,
      'MILESTONE', new.event_type, 'ACTION_REQUIRED',
      'Milestone revision requested',
      v_project.client_name || ' requested revisions on "' || coalesce(v_milestone_title, 'milestone') || '" (' || v_project.title || ').',
      true, 'Respond to feedback', v_project_href || '#milestones',
      'Client', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'milestone.revision_requested:' || new.id::text,
      'MILESTONE', new.event_type, 'INFO',
      'Revision request recorded',
      'Your revision feedback for "' || coalesce(v_milestone_title, 'milestone') || '" was sent to the freelancer.',
      false, 'View milestones', '/portal#milestones',
      'Client', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );

  elsif new.event_type = 'change_request.submitted' then
    if v_requester_role = 'CLIENT' then
      perform public.safe_insert_user_notification(
        new.project_id, new.id, v_project.owner_id,
        'change_request.submitted:' || coalesce(v_change_id, new.id::text),
        'SCOPE_CHANGE', new.event_type, 'ACTION_REQUIRED',
        'New scope-change request from client',
        v_project.client_name || ' submitted a scope change on "' || v_project.title || '".',
        true, 'Review scope change', v_project_href || '#scope-changes',
        'Client', jsonb_build_object('changeRequestId', v_change_id), new.created_at
      );
    else
      perform public.safe_insert_client_notification(
        new.project_id, new.id, v_project.client_email,
        'change_request.submitted:' || coalesce(v_change_id, new.id::text),
        'SCOPE_CHANGE', new.event_type, 'ACTION_REQUIRED',
        'New scope-change proposal from freelancer',
        'The freelancer logged a scope change request on "' || v_project.title || '".',
        true, 'Review scope change', '/portal#scope-changes',
        'Freelancer', jsonb_build_object('changeRequestId', v_change_id), new.created_at
      );
    end if;

  elsif new.event_type in ('change_request.analysis_updated', 'change_request.analysis_stale') then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      new.event_type || ':' || coalesce(v_change_id, new.id::text) || ':' || coalesce(v_version_num, '0'),
      'SCOPE_CHANGE', new.event_type, 'WARNING',
      case
        when new.event_type = 'change_request.analysis_stale' then 'Scope-change AI analysis may be stale'
        else 'Scope-change AI analysis updated'
      end,
      left(new.summary, 480),
      true, 'Inspect scope requests', v_project_href || '#scope-changes',
      new.actor_label, jsonb_build_object('changeRequestId', v_change_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      new.event_type || ':' || coalesce(v_change_id, new.id::text) || ':' || coalesce(v_version_num, '0'),
      'SCOPE_CHANGE', new.event_type, 'WARNING',
      case
        when new.event_type = 'change_request.analysis_stale' then 'Earlier scope-change analysis predates current agreement'
        else 'Scope-change analysis updated'
      end,
      left(new.summary, 480),
      false, 'View scope requests', '/portal#scope-changes',
      'System', jsonb_build_object('changeRequestId', v_change_id), new.created_at
    );

  elsif new.event_type in ('change_request.resolved', 'change_request.withdrawn') then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      new.event_type || ':' || coalesce(v_change_id, new.id::text),
      'SCOPE_CHANGE', new.event_type,
      case when new.event_type = 'change_request.resolved' then 'SUCCESS' else 'INFO' end,
      case
        when new.event_type = 'change_request.resolved' then 'Scope-change request resolved'
        else 'Scope-change request withdrawn'
      end,
      left(new.summary, 480),
      false, 'View scope changes', v_project_href || '#scope-changes',
      new.actor_label, jsonb_build_object('changeRequestId', v_change_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      new.event_type || ':' || coalesce(v_change_id, new.id::text),
      'SCOPE_CHANGE', new.event_type,
      case when new.event_type = 'change_request.resolved' then 'SUCCESS' else 'INFO' end,
      case
        when new.event_type = 'change_request.resolved' then 'Scope-change request resolved'
        else 'Scope-change request withdrawn'
      end,
      case
        when new.event_type = 'change_request.resolved'
        then 'A scope-change request on "' || v_project.title || '" was marked resolved. Formal agreement changes require an approved agreement revision.'
        else 'A scope-change request on "' || v_project.title || '" was withdrawn.'
      end,
      false, 'View scope changes', '/portal#scope-changes',
      'Freelancer', jsonb_build_object('changeRequestId', v_change_id), new.created_at
    );

  elsif new.event_type = 'payment.webhook_order_approved' then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'payment.order_approved:' || coalesce(v_intent_id, new.id::text),
      'PAYMENT', new.event_type, 'INFO',
      'PayPal checkout order approved by buyer',
      'A PayPal checkout order on "' || v_project.title || '" received verified buyer approval. Awaiting final capture confirmation.',
      false, 'View milestone', v_project_href || '#milestones',
      'PayPal Webhook', jsonb_build_object('milestoneId', v_milestone_id, 'paymentIntentId', v_intent_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'payment.order_approved:' || coalesce(v_intent_id, new.id::text),
      'PAYMENT', new.event_type, 'INFO',
      'PayPal checkout approval confirmed',
      'Your PayPal order approval for "' || v_project.title || '" is verified by webhook. Capture confirmation determines paid status.',
      false, 'Check payment status', '/portal#milestones',
      'PayPal Webhook', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );

  elsif new.event_type in ('payment.order_captured', 'payment.reconciliation_completed') then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'payment.captured:' || coalesce(v_intent_id, new.id::text),
      'PAYMENT', new.event_type, 'SUCCESS',
      'PayPal payment captured (Provider Confirmed)',
      'A milestone payment on "' || v_project.title || '" was captured and confirmed via PayPal. Deliverable acceptance stays separate.',
      false, 'View payment & work status', v_project_href || '#milestones',
      'PayPal Confirmed', jsonb_build_object('milestoneId', v_milestone_id, 'paymentIntentId', v_intent_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'payment.captured:' || coalesce(v_intent_id, new.id::text),
      'PAYMENT', new.event_type, 'SUCCESS',
      'PayPal payment captured (Provider Confirmed)',
      'Your milestone payment on "' || v_project.title || '" is confirmed via PayPal. Review submitted deliverables independently before accepting.',
      false, 'View milestones', '/portal#milestones',
      'PayPal Confirmed', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );

  elsif new.event_type in ('payment.capture_pending', 'payment.webhook_capture_pending') then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'payment.capture_pending:' || coalesce(v_intent_id, new.id::text),
      'RECONCILIATION', new.event_type, 'WARNING',
      'PayPal payment capture pending verification',
      'A milestone payment on "' || v_project.title || '" returned PENDING from PayPal and awaits settlement verification.',
      true, 'Inspect payment operations', '/app/payments',
      'System', jsonb_build_object('milestoneId', v_milestone_id, 'paymentIntentId', v_intent_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'payment.capture_pending:' || coalesce(v_intent_id, new.id::text),
      'PAYMENT', new.event_type, 'WARNING',
      'Payment capture pending verification',
      'Your PayPal payment for "' || v_project.title || '" is pending settlement confirmation and is not marked Paid yet.',
      false, 'Check payment status', '/portal#milestones',
      'PayPal', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );

  elsif new.event_type in ('payment.capture_failed', 'payment.webhook_capture_denied', 'payment.reconciliation_failed', 'payment.reconciliation_cancelled') then
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'payment.capture_failed:' || coalesce(v_intent_id, new.id::text) || ':' || new.event_type,
      'PAYMENT', new.event_type, 'WARNING',
      'PayPal payment capture failed or declined',
      'A PayPal payment attempt on "' || v_project.title || '" did not complete and remains unpaid.',
      false, 'Inspect payment operations', '/app/payments',
      'PayPal', jsonb_build_object('milestoneId', v_milestone_id, 'paymentIntentId', v_intent_id), new.created_at
    );
    perform public.safe_insert_client_notification(
      new.project_id, new.id, v_project.client_email,
      'payment.capture_failed:' || coalesce(v_intent_id, new.id::text) || ':' || new.event_type,
      'PAYMENT', new.event_type, 'WARNING',
      'PayPal payment could not be completed',
      'Your PayPal payment attempt on "' || v_project.title || '" did not succeed. You can retry checkout if eligible.',
      false, 'View payment status', '/portal#milestones',
      'PayPal', jsonb_build_object('milestoneId', v_milestone_id), new.created_at
    );

  elsif new.event_type in ('payment.marked_reconciliation_required', 'payment.capture_reconciliation_required') then
    -- Strictly freelancer/operator-only attention notification; never expose internal ops state to client portal
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'payment.reconciliation_required:' || coalesce(v_intent_id, new.id::text),
      'RECONCILIATION', new.event_type, 'ACTION_REQUIRED',
      'Payment reconciliation requires attention',
      'A PayPal payment intent on "' || v_project.title || '" entered RECONCILIATION_REQUIRED status.',
      true, 'Open Payment Operations', '/app/payments',
      'System', jsonb_build_object('milestoneId', v_milestone_id, 'paymentIntentId', v_intent_id), new.created_at
    );

  elsif new.event_type in ('payment.order_recovered', 'payment.reconciliation_resolved_without_payment') then
    -- Strictly freelancer/operator-only notification
    perform public.safe_insert_user_notification(
      new.project_id, new.id, v_project.owner_id,
      'payment.recovery:' || coalesce(v_intent_id, new.id::text) || ':' || new.event_type,
      'RECONCILIATION', new.event_type, 'INFO',
      case
        when new.event_type = 'payment.order_recovered' then 'PayPal order recovered'
        else 'Payment reconciliation resolved without payment'
      end,
      left(new.summary, 480),
      false, 'View payment operations', '/app/payments',
      new.actor_label, jsonb_build_object('milestoneId', v_milestone_id, 'paymentIntentId', v_intent_id), new.created_at
    );
  end if;

  return new;
end;
$$;

revoke all on function public.project_activity_event_to_notifications() from public, anon, authenticated;

drop trigger if exists activity_events_project_notifications on public.activity_events;
create trigger activity_events_project_notifications
  after insert on public.activity_events
  for each row execute procedure public.project_activity_event_to_notifications();
