-- Digital Volunteer: repeating announcements.
--
-- An announcement can be sent several times: every N days (1 = daily, 7 = weekly),
-- up to 30 times, the last one within 90 days. One approval covers every send.
-- Each send is its own outbox row, so the usual rules apply to each: the group is
-- re-checked just before sending, a send more than 6 hours late is skipped, and
-- Cancel stops every send not yet made.

alter table public.dv_announcements
  add column repeat_count      integer not null default 1 check (repeat_count between 1 and 30),
  add column repeat_every_days integer not null default 1 check (repeat_every_days between 1 and 30);

drop function public.dv_create_announcement(text, text, text, timestamptz, uuid[]);

create function public.dv_create_announcement(
  p_title text, p_body text, p_poster_path text, p_send_at timestamptz, p_group_ids uuid[],
  p_repeat_count integer default 1, p_repeat_every_days integer default 1
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_bad text;
  v_op uuid;
  v_count integer := coalesce(p_repeat_count, 1);
  v_every integer := coalesce(p_repeat_every_days, 1);
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
  if v_count not between 1 and 30 or v_every not between 1 and 30 then
    raise exception 'An announcement can be sent up to 30 times, at most 30 days apart' using errcode = '22023';
  end if;
  if p_send_at + make_interval(days => (v_count - 1) * v_every) > now() + interval '90 days' then
    raise exception 'The last send must be within 90 days. Send it fewer times or closer together' using errcode = '22023';
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

  insert into public.dv_announcements (title, body, poster_path, send_at, created_by, repeat_count, repeat_every_days)
  values (btrim(p_title), nullif(btrim(p_body), ''), p_poster_path, greatest(p_send_at, now()), auth.uid(), v_count, v_every)
  returning id into v_id;
  insert into public.dv_announcement_groups (announcement_id, group_id)
  select v_id, x from unnest(p_group_ids) as x on conflict do nothing;

  perform private.audit('dv.announcement_created', 'dv_announcement', v_id,
    jsonb_build_object('title', btrim(p_title), 'send_at', p_send_at, 'groups', cardinality(p_group_ids),
                       'poster', p_poster_path is not null, 'times', v_count, 'every_days', v_every));

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

-- Approval queues every send for every group. A first send whose time has passed
-- goes now; later sends keep their dates.
create or replace function public.dv_approve_announcement(p_id uuid)
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
  if a.send_at + make_interval(days => (a.repeat_count - 1) * a.repeat_every_days) < now() - interval '6 hours' then
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
    select g.jid, 'announcement', a.body, a.poster_path, 'queued', 'announcement:' || a.id || ':' || g.id || ':' || k,
           a.created_by, auth.uid(),
           greatest(a.send_at + make_interval(days => k * a.repeat_every_days), now()), a.id
      from public.dv_announcement_groups ag
      join public.wa_groups g on g.id = ag.group_id
      cross join generate_series(0, a.repeat_count - 1) as k
     where ag.announcement_id = a.id
    returning id, chat_jid, idempotency_key
  )
  -- outbox_id points at each group's first send.
  update public.dv_announcement_groups ag set outbox_id = q.id
    from q join public.wa_groups g on g.jid = q.chat_jid
   where ag.announcement_id = a.id and ag.group_id = g.id and q.idempotency_key like '%:0';

  update public.dv_announcements set status = 'scheduled', decided_by = auth.uid(), decided_at = now() where id = p_id;
  perform private.audit('dv.announcement_approved', 'dv_announcement', p_id, '{}'::jsonb);
  if a.created_by <> auth.uid() then
    perform private.notify(a.created_by, 'announcement_approved', 'Announcement approved',
      'Your WhatsApp announcement was approved and will be sent at the scheduled time.', jsonb_build_object('announcement_id', p_id));
  end if;
end;
$$;

-- Between repeats an announcement is "scheduled" (waiting for its next send), and
-- "sending" only while a message is actually going out.
create or replace function private.dv_announcement_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_open integer;
  v_sending integer;
  v_sent integer;
  v_total integer;
begin
  select count(*) filter (where status in ('queued', 'sending')),
         count(*) filter (where status = 'sending'),
         count(*) filter (where status = 'sent'),
         count(*)
    into v_open, v_sending, v_sent, v_total
    from public.wa_outbox where announcement_id = new.announcement_id;
  update public.dv_announcements
     set status = case
                    when v_sending > 0 then 'sending'
                    when v_open > 0 then 'scheduled'
                    when v_sent = v_total then 'sent'
                    when v_sent > 0 then 'partly_sent'
                    else 'failed' end
   where id = new.announcement_id and status in ('scheduled', 'sending');
  return null;
end;
$$;

revoke all on function public.dv_create_announcement(text, text, text, timestamptz, uuid[], integer, integer) from public, anon;
grant execute on function public.dv_create_announcement(text, text, text, timestamptz, uuid[], integer, integer) to authenticated;
