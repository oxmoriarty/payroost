-- Payroost Phase 2A Remediation: Correct agreement version immutability trigger and review workflow.
-- Fixes defect where prevent_immutable_agreement_version_change() blocked legitimate transitions
-- in submit_public_review() from 'PENDING_CLIENT' to 'APPROVED' or 'CHANGES_REQUESTED'.

create or replace function public.prevent_immutable_agreement_version_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Deletion check: Submitted or decided versions can never be deleted
  if tg_op = 'DELETE' then
    if old.sent_at is not null or old.approved_at is not null or old.status <> 'DRAFT' then
      raise exception 'Immutable agreement versions cannot be deleted';
    end if;
    return old;
  end if;

  -- Update check
  if tg_op = 'UPDATE' then
    -- Core identity fields cannot be modified under any circumstances
    if new.id <> old.id
       or new.agreement_id <> old.agreement_id
       or new.version_number <> old.version_number
       or new.created_by <> old.created_by
       or new.created_at <> old.created_at then
      raise exception 'Core agreement version fields cannot be changed';
    end if;

    -- Decided or superseded versions are completely immutable
    if old.status in ('APPROVED', 'CHANGES_REQUESTED', 'SUPERSEDED') then
      raise exception 'Immutable agreement versions cannot be changed';
    end if;

    -- When version is pending client review:
    if old.status = 'PENDING_CLIENT' or old.sent_at is not null then
      -- Submitted content, hash, and sent timestamp cannot be altered
      if new.content is distinct from old.content
         or new.content_hash is distinct from old.content_hash
         or new.sent_at is distinct from old.sent_at then
        raise exception 'Submitted agreement content is immutable';
      end if;

      -- Direct updates by users are blocked; status transitions must originate from authorized review workflow
      if current_setting('payroost.public_review_active', true) is distinct from 'true' then
        raise exception 'Direct updates to pending agreement versions are not permitted';
      end if;

      -- Legitimate review state transitions
      if new.status = 'APPROVED' then
        if new.approved_at is null then
          raise exception 'Approved agreement version must record approval timestamp';
        end if;
      elsif new.status = 'CHANGES_REQUESTED' then
        null;
      else
        raise exception 'Invalid status transition for pending agreement version';
      end if;

      return new;
    end if;

    -- When version is in DRAFT:
    if old.status = 'DRAFT' then
      -- Transitioning from DRAFT to PENDING_CLIENT is allowed (send action)
      if new.status = 'PENDING_CLIENT' then
        if new.sent_at is null then
          raise exception 'Pending agreement version must record sent_at timestamp';
        end if;
      elsif new.status <> 'DRAFT' then
        raise exception 'Draft agreement version cannot jump to decided status without review submission';
      end if;
      return new;
    end if;
  end if;

  return new;
end;
$$;

-- Update submit_public_review to set transaction-local configuration flag
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
