-- Announcements: choose each send time, cancel one send, honest status after a cancel.
--
-- * send_times: instead of "every N days", the author can list the exact times
--   (1 to 30, each in the future and within 90 days). One approval covers all.
-- * dv_cancel_announcement_send: cancel just one of the times (all its groups);
--   dv_cancel_announcement still stops everything left.
-- * Status once nothing is waiting any more: cancelled sends no longer make an
--   announcement look "partly sent" - that now means some sends really failed.

alter table public.dv_announcements add column send_times timestamptz[];

drop function public.dv_create_announcement(text, text, text, timestamptz, uuid[], integer, integer);

create function public.dv_create_announcement(
  p_title text, p_body text, p_poster_path text, p_send_at timestamptz, p_group_ids uuid[],
  p_repeat_count integer default 1, p_repeat_every_days integer default 1, p_send_times timestamptz[] default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_bad text;
  v_op uuid;
  v_count integer := coalesce(p_repeat_count, 1);
  v_every integer := coalesce(p_repeat_every_days, 1);
  v_times timestamptz[];
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised to create announcements' using errcode = '42501';
  end if;
  if coalesce(btrim(p_body), '') = '' and p_poster_path is null then
    raise exception 'Write a message or add a poster' using errcode = '22023';
  end if;

  if p_send_times is not null then
    -- Exact times chosen by the author: sorted, duplicates removed.
    v_times := array(select distinct t from unnest(p_send_times) t where t is not null order by t);
    if cardinality(v_times) not between 1 and 30 then
      raise exception 'Choose between 1 and 30 send times' using errcode = '22023';
    end if;
    if v_times[1] < now() - interval '5 minutes' then
      raise exception 'Every send time must be in the future' using errcode = '22023';
    end if;
    if v_times[cardinality(v_times)] > now() + interval '90 days' then
      raise exception 'Every send time must be within 90 days' using errcode = '22023';
    end if;
    p_send_at := v_times[1];
    v_count := cardinality(v_times);
    v_every := 1;
  else
    if p_send_at is null or p_send_at < now() - interval '5 minutes' then
      raise exception 'Choose a time in the future' using errcode = '22023';
    end if;
    if v_count not between 1 and 30 or v_every not between 1 and 30 then
      raise exception 'An announcement can be sent up to 30 times, at most 30 days apart' using errcode = '22023';
    end if;
    if p_send_at + make_interval(days => (v_count - 1) * v_every) > now() + interval '90 days' then
      raise exception 'The last send must be within 90 days. Send it fewer times or closer together' using errcode = '22023';
    end if;
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

  insert into public.dv_announcements (title, body, poster_path, send_at, created_by, repeat_count, repeat_every_days, send_times)
  values (btrim(p_title), nullif(btrim(p_body), ''), p_poster_path, greatest(p_send_at, now()), auth.uid(), v_count, v_every, v_times)
  returning id into v_id;
  insert into public.dv_announcement_groups (announcement_id, group_id)
  select v_id, x from unnest(p_group_ids) as x on conflict do nothing;

  perform private.audit('dv.announcement_created', 'dv_announcement', v_id,
    jsonb_build_object('title', btrim(p_title), 'send_at', p_send_at, 'groups', cardinality(p_group_ids),
                       'poster', p_poster_path is not null, 'times', v_count,
                       'every_days', case when v_times is null then v_every end, 'custom_times', v_times is not null));

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

-- Every send time of an announcement: the chosen list, or the every-N-days series.
create function private.dv_announcement_times(a public.dv_announcements)
returns setof timestamptz
language sql stable as $$
  select t from unnest(a.send_times) t where a.send_times is not null
  union all
  select a.send_at + make_interval(days => k * a.repeat_every_days)
    from generate_series(0, a.repeat_count - 1) k
   where a.send_times is null
$$;

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
  if (select max(t) from private.dv_announcement_times(a) t) < now() - interval '6 hours' then
    raise exception 'The send time has passed. Create the announcement again with a new time' using errcode = '55000';
  end if;
  select string_agg(g.name, ', ') into v_bad
    from public.dv_announcement_groups ag join public.wa_groups g on g.id = ag.group_id
   where ag.announcement_id = p_id and not private.dv_group_takes_announcement(g, a.poster_path is not null);
  if v_bad is not null then
    raise exception 'These groups no longer allow announcements: %', v_bad using errcode = '55000';
  end if;

  with times as (
    select t, row_number() over (order by t) - 1 as k from private.dv_announcement_times(a) t
  ), q as (
    insert into public.wa_outbox (chat_jid, kind, body, media_path, status, idempotency_key, created_by, approved_by,
                                  send_after, announcement_id)
    select g.jid, 'announcement', a.body, a.poster_path, 'queued', 'announcement:' || a.id || ':' || g.id || ':' || times.k,
           a.created_by, auth.uid(), greatest(times.t, now()), a.id
      from public.dv_announcement_groups ag
      join public.wa_groups g on g.id = ag.group_id
      cross join times
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

-- Cancel one send time (in every group). Returns how many group messages were stopped.
create function public.dv_cancel_announcement_send(p_id uuid, p_send_after timestamptz)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.wa_outbox set status = 'cancelled'
   where announcement_id = p_id and status = 'queued'
     and send_after between p_send_after - interval '1 second' and p_send_after + interval '1 second';
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'That send already went out or was cancelled' using errcode = '55000';
  end if;
  perform private.audit('dv.announcement_send_cancelled', 'dv_announcement', p_id,
    jsonb_build_object('send_at', p_send_after, 'stopped', v_count));
  return v_count;
end;
$$;

-- Status follows the outbox. Once nothing waits: all sent = sent; some failed or
-- skipped by the system (group switched off: cancelled with a reason) = partly sent /
-- not sent; the rest cancelled by a person = sent (if any went) or cancelled.
create or replace function private.dv_announcement_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_open integer;
  v_sending integer;
  v_sent integer;
  v_failed integer;
begin
  select count(*) filter (where status in ('queued', 'sending')),
         count(*) filter (where status = 'sending'),
         count(*) filter (where status = 'sent'),
         count(*) filter (where status = 'failed' or (status = 'cancelled' and last_error is not null))
    into v_open, v_sending, v_sent, v_failed
    from public.wa_outbox where announcement_id = new.announcement_id;
  update public.dv_announcements
     set status = case
                    when v_sending > 0 then 'sending'
                    when v_open > 0 then 'scheduled'
                    when v_failed > 0 and v_sent > 0 then 'partly_sent'
                    when v_failed > 0 then 'failed'
                    when v_sent > 0 then 'sent'
                    else 'cancelled' end
   where id = new.announcement_id and status in ('scheduled', 'sending');
  return null;
end;
$$;

-- Announcements already marked "partly sent" only because a send was cancelled.
update public.dv_announcements a set status = 'sent'
 where a.status = 'partly_sent'
   and not exists (select 1 from public.wa_outbox o where o.announcement_id = a.id
                     and (o.status = 'failed' or (o.status = 'cancelled' and o.last_error is not null)))
   and exists (select 1 from public.wa_outbox o where o.announcement_id = a.id and o.status = 'sent');

-- The inbox's own Cancel must not quietly stop announcement sends: those are
-- cancelled from the Announcements page (which needs the Announcements permission).
create or replace function public.dv_cancel_outbox(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('reply_messages') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if exists (select 1 from public.wa_outbox where id = p_id and announcement_id is not null) then
    raise exception 'This is a scheduled announcement: cancel it on the Announcements page' using errcode = '55000';
  end if;
  update public.wa_outbox set status = 'cancelled'
   where id = p_id and status in ('pending_approval', 'queued', 'failed');
  if not found then
    raise exception 'This message is already being sent or was sent' using errcode = '55000';
  end if;
  perform private.audit('dv.message_cancelled', 'wa_outbox', p_id, '{}'::jsonb);
end;
$$;

revoke all on function public.dv_create_announcement(text, text, text, timestamptz, uuid[], integer, integer, timestamptz[]) from public, anon;
revoke all on function public.dv_cancel_announcement_send(uuid, timestamptz) from public, anon;
grant execute on function public.dv_create_announcement(text, text, text, timestamptz, uuid[], integer, integer, timestamptz[]),
                          public.dv_cancel_announcement_send(uuid, timestamptz)
  to authenticated;
