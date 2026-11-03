-- Payroost Phase 2A.2: Review Token Hash Access Hardening
-- Prevents authenticated project owners and public callers from reading review_links.token_hash
-- while preserving legitimate review link issuance, metadata inspection, and public review verification.

-- 1. Reconcile existing table-level privileges on public.review_links
revoke all on public.review_links from public, anon;
revoke all on public.review_links from authenticated;

-- 2. Grant column-level SELECT on non-sensitive metadata columns ONLY to authenticated users
-- token_hash is explicitly excluded so no authenticated caller can read stored token hashes.
grant select (
  id,
  project_id,
  agreement_version_id,
  intended_email,
  expires_at,
  revoked_at,
  created_at
) on public.review_links to authenticated;

-- 3. Grant column-level INSERT on required fields for review link creation
grant insert (
  project_id,
  agreement_version_id,
  token_hash,
  intended_email,
  expires_at
) on public.review_links to authenticated;

-- 4. Grant column-level UPDATE on revocation timestamp for link invalidation
grant update (
  revoked_at
) on public.review_links to authenticated;

-- 5. Create a secured view for clean metadata querying without exposing token_hash in schema
create or replace view public.project_review_links
with (security_invoker = true) as
select
  id,
  project_id,
  agreement_version_id,
  intended_email,
  expires_at,
  revoked_at,
  created_at
from public.review_links;

revoke all on public.project_review_links from public, anon;
grant select on public.project_review_links to authenticated;

-- 6. Harden submit_public_review to prevent project owner from approving their own agreement
create or replace function public.submit_public_review(
  p_token_hash text, p_action text, p_note text, p_actor_label text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  link_row public.review_links%rowtype;
  version_row public.agreement_versions%rowtype;
begin
  -- Set transaction-local flag so immutability trigger permits the authorized review transition
  perform set_config('payroost.public_review_active', 'true', true);

  select * into link_row from public.review_links where token_hash = p_token_hash for update;
  if not found or link_row.revoked_at is not null or link_row.expires_at <= now() then
    raise exception 'Review link unavailable';
  end if;

  -- Defense-in-depth: Reject approval attempts originating from the project owner's authenticated session
  if auth.uid() is not null and exists (
    select 1 from public.projects p
    where p.id = link_row.project_id and p.owner_id = auth.uid()
  ) then
    raise exception 'Project owner cannot decide their own agreement';
  end if;

  select * into version_row from public.agreement_versions where id = link_row.agreement_version_id for update;
  if version_row.status <> 'PENDING_CLIENT' then
    raise exception 'Agreement already decided';
  end if;

  if p_action = 'APPROVE' then
    update public.agreement_versions
    set status = 'APPROVED',
        approved_at = now(),
        approved_by_label = left(nullif(trim(p_actor_label), ''), 140)
    where id = version_row.id;

    update public.agreements
    set status = 'APPROVED'
    where id = version_row.agreement_id;

    update public.projects
    set status = 'ACTIVE'
    where id = link_row.project_id and status in ('DRAFT', 'AWAITING_CLIENT');

    insert into public.activity_events(project_id, actor_label, event_type, summary)
    values (
      link_row.project_id,
      coalesce(nullif(trim(p_actor_label), ''), 'Client'),
      'agreement.approved',
      'Approved agreement version ' || version_row.version_number
    );

    update public.review_links set revoked_at = now() where id = link_row.id;
    return 'APPROVED';

  elsif p_action = 'REQUEST_CHANGES' then
    if char_length(trim(coalesce(p_note, ''))) < 3 then
      raise exception 'Change request note required';
    end if;

    insert into public.change_requests(project_id, agreement_version_id, review_link_id, request_text, submitted_by_label)
    values (
      link_row.project_id,
      version_row.id,
      link_row.id,
      trim(p_note),
      coalesce(nullif(trim(p_actor_label), ''), 'Client')
    );

    update public.agreement_versions
    set status = 'CHANGES_REQUESTED'
    where id = version_row.id;

    update public.agreements
    set status = 'CHANGES_REQUESTED'
    where id = version_row.agreement_id;

    insert into public.activity_events(project_id, actor_label, event_type, summary)
    values (
      link_row.project_id,
      coalesce(nullif(trim(p_actor_label), ''), 'Client'),
      'agreement.changes_requested',
      'Requested changes to agreement version ' || version_row.version_number
    );

    update public.review_links set revoked_at = now() where id = link_row.id;
    return 'CHANGES_REQUESTED';

  else
    raise exception 'Unsupported review action';
  end if;
end;
$$;

revoke all on function public.submit_public_review(text, text, text, text) from public;
grant execute on function public.submit_public_review(text, text, text, text) to anon, authenticated;
