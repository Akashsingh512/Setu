-- Digital Volunteer, part 6: scheduled announcements with posters.
--
-- Someone with the "Announcements" permission writes a message (and optionally a
-- poster image), picks groups and a time. A second person with the same permission
-- approves it (a super admin may approve their own). Only then is it queued: one
-- outbox row per group, released by the gateway at the chosen time.
--   * Only groups that are enabled, still joined, and allow announcements can be
--     chosen; a poster also needs "media" allowed. This is checked again at approval
--     and again just before sending, so switching a group off stops it.
--   * An announcement more than 6 hours late (e.g. the gateway was off) is not sent:
--     an old notice about an event is worse than none. It is marked failed instead.
--   * Cancelling stops every group that hasn't been sent yet.
-- Posters live in the private "dv-posters" storage bucket; the gateway reads them
-- with the service role.

create table public.dv_announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(btrim(title)) between 1 and 120),  -- internal name, not sent
  body        text check (length(body) <= 4000),
  poster_path text check (poster_path ~ '^announcements/[A-Za-z0-9._/-]+$'),
  send_at     timestamptz not null,
  status      text not null default 'pending_approval'
              check (status in ('pending_approval', 'scheduled', 'sending', 'sent', 'partly_sent', 'failed', 'rejected', 'cancelled')),
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  decided_by  uuid references public.profiles (id),
  decided_at  timestamptz,
  reason      text,
  check (coalesce(btrim(body), '') <> '' or poster_path is not null)
);
create index dv_announcements_send_idx on public.dv_announcements (send_at desc);

create table public.dv_announcement_groups (
  announcement_id uuid not null references public.dv_announcements (id) on delete cascade,
  group_id        uuid not null references public.wa_groups (id),
  outbox_id       uuid references public.wa_outbox (id),
  primary key (announcement_id, group_id)
);

alter table public.wa_outbox add column announcement_id uuid references public.dv_announcements (id);
create index wa_outbox_announcement_idx on public.wa_outbox (announcement_id) where announcement_id is not null;

create function private.dv_group_takes_announcement(p_group public.wa_groups, p_has_poster boolean)
returns boolean
language sql immutable as $$
  select coalesce(p_group.enabled and p_group.is_member and p_group.allow_announcements
                  and (not p_has_poster or p_group.allow_media), false)
$$;

-- ---------------------------------------------------------------------------
-- Create / approve / reject / cancel
-- ---------------------------------------------------------------------------
create function public.dv_create_announcement(
  p_title text, p_body text, p_poster_path text, p_send_at timestamptz, p_group_ids uuid[]
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_bad text;
  v_op uuid;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised to create announcements' using errcode = '42501';
  end if;
  if coalesce(btrim(p_body), '') = '' and p_poster_path is null then
    raise exception 'Write a message or add a poster' using errcode = '22023';
  end if;
  if p_send_at is null or p_send_at < now() - interval '5 minutes' then
    raise exception 'Choose a time in the future' using errcode = '22023';
  end if;
  if p_send_at > now() + interval '90 days' then
    raise exception 'Announcements can be scheduled up to 90 days ahead' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_group_ids), 0) = 0 then
    raise exception 'Choose at least one group' using errcode = '22023';
  end if;
  select string_agg(coalesce(g.name, 'unknown group'), ', ') into v_bad
    from unnest(p_group_ids) as x(id)
    left join public.wa_groups g on g.id = x.id
   where g.id is null or not private.dv_group_takes_announcement(g, p_poster_path is not null);
  if v_bad is not null then
    raise exception 'These groups do not allow announcements%: %',
      case when p_poster_path is not null then ' with a poster' else '' end, v_bad using errcode = '22023';
  end if;

  insert into public.dv_announcements (title, body, poster_path, send_at, created_by)
  values (btrim(p_title), nullif(btrim(p_body), ''), p_poster_path, greatest(p_send_at, now()), auth.uid())
  returning id into v_id;
  insert into public.dv_announcement_groups (announcement_id, group_id)
  select v_id, x from unnest(p_group_ids) as x on conflict do nothing;

  perform private.audit('dv.announcement_created', 'dv_announcement', v_id,
    jsonb_build_object('title', btrim(p_title), 'send_at', p_send_at, 'groups', cardinality(p_group_ids),
                       'poster', p_poster_path is not null));

  for v_op in
    select pr.id from public.profiles pr
     where pr.status = 'active' and pr.id <> auth.uid()
       and private.dv_can_for(pr.id, 'schedule_announcements')
  loop
    perform private.notify(v_op, 'announcement_pending', 'Announcement waiting for approval',
      'A WhatsApp announcement needs a second person to approve it.', jsonb_build_object('announcement_id', v_id));
  end loop;
  return v_id;
end;
$$;

create function public.dv_approve_announcement(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.dv_announcements;
  v_bad text;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised to approve announcements' using errcode = '42501';
  end if;
  select * into a from public.dv_announcements where id = p_id for update;
  if a.id is null or a.status <> 'pending_approval' then
    raise exception 'This announcement was already handled' using errcode = '55000';
  end if;
  if a.created_by = auth.uid() and not private.is_super_admin() then
    raise exception 'Someone else must approve your announcement' using errcode = '42501';
  end if;
  if a.send_at < now() - interval '6 hours' then
    raise exception 'The send time has passed. Create the announcement again with a new time' using errcode = '55000';
  end if;
  select string_agg(g.name, ', ') into v_bad
    from public.dv_announcement_groups ag join public.wa_groups g on g.id = ag.group_id
   where ag.announcement_id = p_id and not private.dv_group_takes_announcement(g, a.poster_path is not null);
  if v_bad is not null then
    raise exception 'These groups no longer allow announcements: %', v_bad using errcode = '55000';
  end if;

  with q as (
    insert into public.wa_outbox (chat_jid, kind, body, media_path, status, idempotency_key, created_by, approved_by,
                                  send_after, announcement_id)
    select g.jid, 'announcement', a.body, a.poster_path, 'queued', 'announcement:' || a.id || ':' || g.id, a.created_by,
           auth.uid(), greatest(a.send_at, now()), a.id
      from public.dv_announcement_groups ag join public.wa_groups g on g.id = ag.group_id
     where ag.announcement_id = a.id
    returning id, chat_jid
  )
  update public.dv_announcement_groups ag set outbox_id = q.id
    from q join public.wa_groups g on g.jid = q.chat_jid
   where ag.announcement_id = a.id and ag.group_id = g.id;

  update public.dv_announcements set status = 'scheduled', decided_by = auth.uid(), decided_at = now() where id = p_id;
  perform private.audit('dv.announcement_approved', 'dv_announcement', p_id, '{}'::jsonb);
  if a.created_by <> auth.uid() then
    perform private.notify(a.created_by, 'announcement_approved', 'Announcement approved',
      'Your WhatsApp announcement was approved and will be sent at the scheduled time.', jsonb_build_object('announcement_id', p_id));
  end if;
end;
$$;

create function public.dv_reject_announcement(p_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_creator uuid;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.dv_announcements
     set status = 'rejected', decided_by = auth.uid(), decided_at = now(), reason = left(nullif(btrim(p_reason), ''), 300)
   where id = p_id and status = 'pending_approval'
  returning created_by into v_creator;
  if v_creator is null then
    raise exception 'This announcement was already handled' using errcode = '55000';
  end if;
  perform private.audit('dv.announcement_rejected', 'dv_announcement', p_id, jsonb_build_object('reason', p_reason));
  if v_creator <> auth.uid() then
    perform private.notify(v_creator, 'announcement_rejected', 'Announcement not approved',
      coalesce('Reason: ' || left(nullif(btrim(p_reason), ''), 200), 'Your WhatsApp announcement was not approved.'),
      jsonb_build_object('announcement_id', p_id));
  end if;
end;
$$;

-- Stops every group not sent yet. Messages already delivered can't be recalled.
create function public.dv_cancel_announcement(p_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.dv_announcements set status = 'cancelled', decided_by = coalesce(decided_by, auth.uid()),
         decided_at = coalesce(decided_at, now())
   where id = p_id and status in ('pending_approval', 'scheduled', 'sending');
  if not found then
    raise exception 'This announcement can no longer be cancelled' using errcode = '55000';
  end if;
  update public.wa_outbox set status = 'cancelled'
   where announcement_id = p_id and status in ('queued', 'failed');
  get diagnostics v_count = row_count;
  perform private.audit('dv.announcement_cancelled', 'dv_announcement', p_id, jsonb_build_object('stopped', v_count));
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Status follows the outbox rows
-- ---------------------------------------------------------------------------
create function private.dv_announcement_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_open integer;
  v_sent integer;
  v_total integer;
begin
  select count(*) filter (where status in ('queued', 'sending')),
         count(*) filter (where status = 'sent'),
         count(*)
    into v_open, v_sent, v_total
    from public.wa_outbox where announcement_id = new.announcement_id;
  update public.dv_announcements
     set status = case
                    when v_open > 0 then case when v_sent > 0 or exists (
                                                select 1 from public.wa_outbox
                                                 where announcement_id = new.announcement_id and status = 'sending')
                                              then 'sending' else 'scheduled' end
                    when v_sent = v_total then 'sent'
                    when v_sent > 0 then 'partly_sent'
                    else 'failed' end
   where id = new.announcement_id and status in ('scheduled', 'sending');
  return null;
end;
$$;

create trigger wa_outbox_announcement_progress after update of status on public.wa_outbox
  for each row when (new.announcement_id is not null and new.status is distinct from old.status)
  execute function private.dv_announcement_progress();

-- ---------------------------------------------------------------------------
-- The gateway's claim: re-check announcements just before they go out
-- ---------------------------------------------------------------------------
create or replace function public.dv_claim_outbox(p_limit integer default 10)
returns setof public.wa_outbox
language plpgsql security definer set search_path = '' as $$
begin
  if not (select enabled from public.wa_account where id) then
    return;
  end if;
  -- A claim that never completed (gateway crashed mid-send) is not retried
  -- blindly: the message may have gone out. It is marked failed for a human.
  update public.wa_outbox set status = 'failed', last_error = 'Sending was interrupted; check the chat before retrying'
   where status = 'sending' and claimed_at < now() - interval '5 minutes';

  -- Announcements: too late, or the group no longer allows them.
  update public.wa_outbox set status = 'failed', last_error = 'Not sent: more than 6 hours late (was the gateway or Digital Volunteer off?)'
   where kind = 'announcement' and status = 'queued' and send_after < now() - interval '6 hours';
  update public.wa_outbox o set status = 'cancelled', last_error = 'The group no longer allows this announcement'
    from public.wa_groups g
   where o.kind = 'announcement' and o.status = 'queued' and o.send_after <= now() and g.jid = o.chat_jid
     and not private.dv_group_takes_announcement(g, o.media_path is not null);

  return query
  update public.wa_outbox o
     set status = 'sending', claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from public.wa_outbox
      where status = 'queued' and send_after <= now()
      order by send_after
      limit p_limit
        for update skip locked)
  returning o.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges, RLS, storage
-- ---------------------------------------------------------------------------
revoke all on public.dv_announcements, public.dv_announcement_groups from anon, authenticated;
grant select on public.dv_announcements, public.dv_announcement_groups to authenticated;
alter table public.dv_announcements enable row level security;
alter table public.dv_announcement_groups enable row level security;
create policy dv_announcements_select on public.dv_announcements for select to authenticated
  using (private.dv_can('schedule_announcements') or private.dv_can('view_audit'));
create policy dv_announcement_groups_select on public.dv_announcement_groups for select to authenticated
  using (private.dv_can('schedule_announcements') or private.dv_can('view_audit'));

revoke all on function public.dv_create_announcement(text, text, text, timestamptz, uuid[]) from public, anon;
revoke all on function public.dv_approve_announcement(uuid) from public, anon;
revoke all on function public.dv_reject_announcement(uuid, text) from public, anon;
revoke all on function public.dv_cancel_announcement(uuid) from public, anon;
grant execute on function public.dv_create_announcement(text, text, text, timestamptz, uuid[]),
                          public.dv_approve_announcement(uuid),
                          public.dv_reject_announcement(uuid, text),
                          public.dv_cancel_announcement(uuid)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.dv_announcements, public.dv_announcement_groups to service_role;
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.dv_announcements;
  end if;
  -- Posters: private bucket, images up to 5 MB. Uploaded by people who may create
  -- announcements, readable by operators; the gateway reads with the service role.
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('dv-posters', 'dv-posters', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
    execute $p$
      create policy dv_posters_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'dv-posters' and name like 'announcements/%' and private.dv_can('schedule_announcements'))
    $p$;
    execute $p$
      create policy dv_posters_select on storage.objects for select to authenticated
        using (bucket_id = 'dv-posters' and private.dv_is_operator())
    $p$;
  end if;
end;
$$;
