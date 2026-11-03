-- Payroost Phase 2: project, agreement, milestone, audit, and public review workflow.
-- All timestamps are UTC (timestamptz). Monetary values are integer minor units.

create type public.project_status as enum ('DRAFT', 'AWAITING_CLIENT', 'ACTIVE', 'COMPLETED', 'CANCELLED');
create type public.agreement_status as enum ('DRAFT', 'PENDING_CLIENT', 'APPROVED', 'CHANGES_REQUESTED', 'SUPERSEDED');
create type public.milestone_status as enum ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'CHANGES_REQUESTED', 'CANCELLED');
create type public.change_request_status as enum ('OPEN', 'RESOLVED', 'WITHDRAWN');
create type public.participant_role as enum ('OWNER', 'CLIENT');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  title text not null check (char_length(title) between 2 and 140),
  client_name text not null check (char_length(client_name) between 2 and 140),
  client_email text not null check (char_length(client_email) <= 320),
  brief text not null check (char_length(brief) between 20 and 20000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  total_amount_minor bigint not null check (total_amount_minor > 0),
  status public.project_status not null default 'DRAFT',
  start_date date,
  target_end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (target_end_date is null or start_date is null or target_end_date >= start_date)
);

create table public.project_participants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  email text not null check (char_length(email) <= 320),
  display_name text,
  role public.participant_role not null,
  created_at timestamptz not null default now(),
  unique (project_id, email),
  unique (project_id, profile_id),
  check ((role = 'OWNER' and profile_id is not null) or role = 'CLIENT')
);

create table public.agreements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  current_version_id uuid,
  status public.agreement_status not null default 'DRAFT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agreement_versions (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.agreements(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  content jsonb not null,
  content_hash text not null check (char_length(content_hash) = 64),
  status public.agreement_status not null default 'DRAFT',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  approved_at timestamptz,
  approved_by_label text,
  unique (agreement_id, version_number),
  unique (agreement_id, content_hash, version_number)
);

alter table public.agreements
  add constraint agreements_current_version_id_fkey
  foreign key (current_version_id) references public.agreement_versions(id) on delete set null;

create table public.review_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  agreement_version_id uuid not null references public.agreement_versions(id) on delete cascade,
  token_hash text not null unique check (char_length(token_hash) = 64),
  intended_email text not null check (char_length(intended_email) <= 320),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  agreement_version_id uuid not null references public.agreement_versions(id) on delete restrict,
  title text not null check (char_length(title) between 2 and 140),
  description text not null default '',
  deliverables jsonb not null default '[]'::jsonb,
  acceptance_criteria jsonb not null default '[]'::jsonb,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  due_date date,
  sort_order integer not null default 0 check (sort_order >= 0),
  status public.milestone_status not null default 'DRAFT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, sort_order)
);

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  agreement_version_id uuid not null references public.agreement_versions(id) on delete restrict,
  review_link_id uuid references public.review_links(id) on delete set null,
  request_text text not null check (char_length(request_text) between 3 and 10000),
  submitted_by_label text not null default 'Client',
  status public.change_request_status not null default 'OPEN',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  actor_label text not null,
  event_type text not null check (char_length(event_type) between 3 and 100),
  summary text not null check (char_length(summary) between 3 and 500),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index projects_owner_updated_idx on public.projects(owner_id, updated_at desc);
create index project_participants_profile_idx on public.project_participants(profile_id) where profile_id is not null;
create index agreement_versions_agreement_idx on public.agreement_versions(agreement_id, version_number desc);
create index milestones_project_order_idx on public.milestones(project_id, sort_order);
create index activity_events_project_created_idx on public.activity_events(project_id, created_at desc);

create or replace function public.is_project_member(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects p where p.id = p_project_id and p.owner_id = auth.uid()
    union all
    select 1 from public.project_participants pp where pp.project_id = p_project_id and pp.profile_id = auth.uid()
  );
$$;

create or replace function public.is_project_owner(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.projects where id = p_project_id and owner_id = auth.uid());
$$;

create or replace function public.set_phase2_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger projects_set_updated_at before update on public.projects for each row execute procedure public.set_phase2_updated_at();
create trigger agreements_set_updated_at before update on public.agreements for each row execute procedure public.set_phase2_updated_at();
create trigger agreement_versions_set_updated_at before update on public.agreement_versions for each row execute procedure public.set_phase2_updated_at();
create trigger milestones_set_updated_at before update on public.milestones for each row execute procedure public.set_phase2_updated_at();

-- A sent, approved, or superseded version is immutable at the database layer.
create or replace function public.prevent_immutable_agreement_version_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.sent_at is not null or old.approved_at is not null or old.status in ('PENDING_CLIENT', 'APPROVED', 'SUPERSEDED') then
    raise exception 'Immutable agreement versions cannot be changed';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger agreement_versions_immutable before update or delete on public.agreement_versions
  for each row execute procedure public.prevent_immutable_agreement_version_change();

alter table public.projects enable row level security;
alter table public.project_participants enable row level security;
alter table public.agreements enable row level security;
alter table public.agreement_versions enable row level security;
alter table public.review_links enable row level security;
alter table public.milestones enable row level security;
alter table public.change_requests enable row level security;
alter table public.activity_events enable row level security;

create policy "projects_member_read" on public.projects for select to authenticated using (public.is_project_member(id));
create policy "projects_owner_insert" on public.projects for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "projects_owner_update" on public.projects for update to authenticated using (public.is_project_owner(id)) with check (owner_id = (select auth.uid()));
create policy "projects_owner_delete" on public.projects for delete to authenticated using (public.is_project_owner(id));

create policy "participants_member_read" on public.project_participants for select to authenticated using (public.is_project_member(project_id));
create policy "participants_owner_write" on public.project_participants for all to authenticated using (public.is_project_owner(project_id)) with check (public.is_project_owner(project_id));

create policy "agreements_member_read" on public.agreements for select to authenticated using (public.is_project_member(project_id));
create policy "agreements_owner_write" on public.agreements for all to authenticated using (public.is_project_owner(project_id)) with check (public.is_project_owner(project_id));

create policy "agreement_versions_member_read" on public.agreement_versions for select to authenticated using (exists (select 1 from public.agreements a where a.id = agreement_id and public.is_project_member(a.project_id)));
create policy "agreement_versions_owner_write" on public.agreement_versions for all to authenticated using (exists (select 1 from public.agreements a where a.id = agreement_id and public.is_project_owner(a.project_id))) with check (exists (select 1 from public.agreements a where a.id = agreement_id and public.is_project_owner(a.project_id)) and created_by = (select auth.uid()));

create policy "review_links_owner_only" on public.review_links for all to authenticated using (public.is_project_owner(project_id)) with check (public.is_project_owner(project_id));
create policy "milestones_member_read" on public.milestones for select to authenticated using (public.is_project_member(project_id));
create policy "milestones_owner_write" on public.milestones for all to authenticated using (public.is_project_owner(project_id)) with check (public.is_project_owner(project_id));
create policy "change_requests_member_read" on public.change_requests for select to authenticated using (public.is_project_member(project_id));
create policy "change_requests_owner_write" on public.change_requests for all to authenticated using (public.is_project_owner(project_id)) with check (public.is_project_owner(project_id));
create policy "activity_member_read" on public.activity_events for select to authenticated using (public.is_project_member(project_id));
create policy "activity_owner_insert" on public.activity_events for insert to authenticated with check (public.is_project_owner(project_id));

-- Public review functions return only the linked immutable version and allow one atomic decision.
create or replace function public.get_public_review(p_token_hash text)
returns table (
  review_link_id uuid, project_title text, client_name text, freelancer_name text,
  content jsonb, version_number integer, sent_at timestamptz, expires_at timestamptz
) language sql security definer set search_path = '' as $$
  select rl.id, p.title, p.client_name, coalesce(pr.display_name, 'Freelancer'), av.content, av.version_number, av.sent_at, rl.expires_at
  from public.review_links rl
  join public.projects p on p.id = rl.project_id
  join public.profiles pr on pr.id = p.owner_id
  join public.agreement_versions av on av.id = rl.agreement_version_id
  where rl.token_hash = p_token_hash and rl.revoked_at is null and rl.expires_at > now() and av.status = 'PENDING_CLIENT';
$$;

create or replace function public.submit_public_review(
  p_token_hash text, p_action text, p_note text, p_actor_label text
) returns text language plpgsql security definer set search_path = '' as $$
declare link_row public.review_links%rowtype; version_row public.agreement_versions%rowtype;
begin
  select * into link_row from public.review_links where token_hash = p_token_hash for update;
  if not found or link_row.revoked_at is not null or link_row.expires_at <= now() then raise exception 'Review link unavailable'; end if;
  select * into version_row from public.agreement_versions where id = link_row.agreement_version_id for update;
  if version_row.status <> 'PENDING_CLIENT' then raise exception 'Agreement already decided'; end if;
  if p_action = 'APPROVE' then
    update public.agreement_versions set status = 'APPROVED', approved_at = now(), approved_by_label = left(nullif(trim(p_actor_label), ''), 140) where id = version_row.id;
    update public.agreements set status = 'APPROVED' where id = version_row.agreement_id;
    update public.projects set status = 'ACTIVE' where id = link_row.project_id and status in ('DRAFT', 'AWAITING_CLIENT');
    insert into public.activity_events(project_id, actor_label, event_type, summary) values (link_row.project_id, coalesce(nullif(trim(p_actor_label), ''), 'Client'), 'agreement.approved', 'Approved agreement version ' || version_row.version_number);
    update public.review_links set revoked_at = now() where id = link_row.id;
    return 'APPROVED';
  elsif p_action = 'REQUEST_CHANGES' then
    if char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Change request note required'; end if;
    insert into public.change_requests(project_id, agreement_version_id, review_link_id, request_text, submitted_by_label) values (link_row.project_id, version_row.id, link_row.id, trim(p_note), coalesce(nullif(trim(p_actor_label), ''), 'Client'));
    update public.agreement_versions set status = 'CHANGES_REQUESTED' where id = version_row.id;
    update public.agreements set status = 'CHANGES_REQUESTED' where id = version_row.agreement_id;
    insert into public.activity_events(project_id, actor_label, event_type, summary) values (link_row.project_id, coalesce(nullif(trim(p_actor_label), ''), 'Client'), 'agreement.changes_requested', 'Requested changes to agreement version ' || version_row.version_number);
    update public.review_links set revoked_at = now() where id = link_row.id;
    return 'CHANGES_REQUESTED';
  else raise exception 'Unsupported review action';
  end if;
end;
$$;

revoke all on function public.get_public_review(text) from public;
revoke all on function public.submit_public_review(text, text, text, text) from public;
grant execute on function public.get_public_review(text) to anon, authenticated;
grant execute on function public.submit_public_review(text, text, text, text) to anon, authenticated;
