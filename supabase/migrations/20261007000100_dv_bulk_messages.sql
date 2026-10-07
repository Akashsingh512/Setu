-- Digital Volunteer: bulk messages (campaigns), sent slowly and like a person would.
--
-- A campaign = one message (with {{name}} / {{full_name}}, optional poster) to a list
-- of numbers: filtered leads, Setu members, or pasted / uploaded numbers. The sender
-- sets the pace: a random gap between messages, how long "typing…" shows, a daily
-- cap, sending hours, and a pause after every batch. Nothing is pre-queued: every
-- minute dv_bulk_tick queues only what is due in the next two minutes, and only while
-- WhatsApp is connected, so a gateway that was down never sends a burst afterwards.
-- Safety: numbers that replied STOP and "Do not contact" leads are never messaged;
-- duplicates are dropped; 5 failures in a row pause the campaign.
-- Permission: the Digital Volunteer "Announcements" permission.

alter table public.wa_outbox drop constraint wa_outbox_kind_check;
alter table public.wa_outbox add constraint wa_outbox_kind_check check (kind in ('reply', 'direct', 'announcement', 'seva_numbers', 'bulk'));
alter table public.wa_outbox add column typing_ms integer check (typing_ms between 0 and 30000);

create table public.dv_opt_outs (
  phone      text primary key check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  source     text not null default 'reply' check (source in ('reply', 'manual')),
  created_at timestamptz not null default now()
);

create table public.dv_bulk_campaigns (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (length(btrim(title)) between 1 and 120),
  body            text not null check (length(btrim(body)) between 1 and 4000),
  poster_path     text check (poster_path ~ '^(announcements|templates|programs)/[A-Za-z0-9._/-]+$'),
  add_stop_line   boolean not null default true,
  audience        text check (length(audience) <= 300),
  status          text not null default 'scheduled' check (status in ('scheduled', 'sending', 'paused', 'completed', 'cancelled')),
  status_reason   text,
  start_at        timestamptz not null default now(),
  min_gap_s       integer not null check (min_gap_s between 5 and 3600),
  max_gap_s       integer not null check (max_gap_s between 5 and 7200),
  typing_min_s    integer not null default 3 check (typing_min_s between 0 and 30),
  typing_max_s    integer not null default 8 check (typing_max_s between 0 and 30),
  daily_cap       integer not null check (daily_cap between 1 and 2000),
  window_start    time,
  window_end      time,
  batch_size      integer not null default 0 check (batch_size between 0 and 1000),
  batch_pause_min integer not null default 0 check (batch_pause_min between 0 and 600),
  next_send_at    timestamptz,
  queued_count    integer not null default 0,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now(),
  check (max_gap_s >= min_gap_s and typing_max_s >= typing_min_s),
  check ((window_start is null) = (window_end is null) and (window_start is null or window_end > window_start))
);

create table public.dv_bulk_recipients (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.dv_bulk_campaigns (id),
  seq         integer not null,
  phone       text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  name        text check (length(name) <= 200),
  lead_id     uuid references public.leads (id) on delete set null,
  profile_id  uuid references public.profiles (id),
  status      text not null default 'pending' check (status in ('pending', 'queued', 'sent', 'failed', 'skipped', 'opted_out')),
  outbox_id   uuid references public.wa_outbox (id),
  scheduled_at timestamptz,
  done_at     timestamptz,
  error       text,
  unique (campaign_id, phone)
);
create index dv_bulk_recipients_next_idx on public.dv_bulk_recipients (campaign_id, seq) where status = 'pending';
create index dv_bulk_recipients_queued_idx on public.dv_bulk_recipients (outbox_id) where status = 'queued';

-- Progress per campaign, for the list page (rows follow the recipients' security).
create view public.dv_bulk_progress with (security_invoker = true) as
select campaign_id,
       count(*)::integer as total,
       count(*) filter (where status = 'sent')::integer as sent,
       count(*) filter (where status = 'failed')::integer as failed,
       count(*) filter (where status in ('pending', 'queued'))::integer as waiting,
       count(*) filter (where status in ('skipped', 'opted_out'))::integer as skipped
  from public.dv_bulk_recipients
 group by campaign_id;

revoke all on public.dv_opt_outs, public.dv_bulk_campaigns, public.dv_bulk_recipients from anon, authenticated;
grant select on public.dv_bulk_progress to authenticated;
grant select on public.dv_opt_outs, public.dv_bulk_campaigns, public.dv_bulk_recipients to authenticated;
alter table public.dv_opt_outs enable row level security;
alter table public.dv_bulk_campaigns enable row level security;
alter table public.dv_bulk_recipients enable row level security;
create policy dv_opt_outs_select on public.dv_opt_outs for select to authenticated using (private.dv_can('schedule_announcements'));
create policy dv_bulk_campaigns_select on public.dv_bulk_campaigns for select to authenticated using (private.dv_can('schedule_announcements'));
create policy dv_bulk_recipients_select on public.dv_bulk_recipients for select to authenticated using (private.dv_can('schedule_announcements'));

-- ---------------------------------------------------------------------------
-- Creating a campaign (p_dry_run: only count what would be sent)
-- ---------------------------------------------------------------------------
create function public.dv_bulk_create(p_campaign jsonb, p_recipients jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_total integer := jsonb_array_length(coalesce(p_recipients, '[]'::jsonb));
  v_invalid integer;
  v_dupes integer;
  v_opted integer;
  v_dnc integer;
  v_kept integer;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised to send bulk messages' using errcode = '42501';
  end if;
  if v_total = 0 then
    raise exception 'Choose who gets the message' using errcode = '22023';
  end if;
  if v_total > 5000 then
    raise exception 'At most 5000 people per bulk message' using errcode = '22023';
  end if;

  create temp table if not exists pg_temp.bulk_in (ord integer, phone text, name text, lead_id uuid, profile_id uuid) on commit drop;
  truncate pg_temp.bulk_in;
  insert into pg_temp.bulk_in
  select x.ord::integer, btrim(x.r ->> 'phone'), nullif(left(btrim(x.r ->> 'name'), 200), ''),
         nullif(x.r ->> 'lead_id', '')::uuid, nullif(x.r ->> 'profile_id', '')::uuid
    from jsonb_array_elements(p_recipients) with ordinality as x (r, ord);

  select count(*) into v_invalid from pg_temp.bulk_in where phone is null or phone !~ '^\+[1-9][0-9]{6,14}$';
  delete from pg_temp.bulk_in where phone is null or phone !~ '^\+[1-9][0-9]{6,14}$';
  -- Keep the first of each number.
  select count(*) into v_dupes from pg_temp.bulk_in b
   where exists (select 1 from pg_temp.bulk_in o where o.phone = b.phone and o.ord < b.ord);
  delete from pg_temp.bulk_in b where exists (select 1 from pg_temp.bulk_in o where o.phone = b.phone and o.ord < b.ord);
  select count(*) into v_opted from pg_temp.bulk_in b where exists (select 1 from public.dv_opt_outs o where o.phone = b.phone);
  delete from pg_temp.bulk_in b where exists (select 1 from public.dv_opt_outs o where o.phone = b.phone);
  -- Anyone whose number belongs to a "Do not contact" lead.
  select count(*) into v_dnc from pg_temp.bulk_in b
   where exists (select 1 from public.leads l join public.lead_statuses s on s.code = l.status
                  where s.blocks_contact and (l.phone = b.phone or l.whatsapp_phone = b.phone));
  delete from pg_temp.bulk_in b
   where exists (select 1 from public.leads l join public.lead_statuses s on s.code = l.status
                  where s.blocks_contact and (l.phone = b.phone or l.whatsapp_phone = b.phone));
  select count(*) into v_kept from pg_temp.bulk_in;

  if p_dry_run then
    return jsonb_build_object('recipients', v_kept, 'invalid', v_invalid, 'duplicates', v_dupes, 'opted_out', v_opted, 'do_not_contact', v_dnc);
  end if;
  if v_kept = 0 then
    raise exception 'Nobody is left to message after removing invalid, duplicate, opted-out and Do-not-contact numbers' using errcode = '22023';
  end if;

  insert into public.dv_bulk_campaigns (title, body, poster_path, add_stop_line, audience, start_at, min_gap_s, max_gap_s,
                                        typing_min_s, typing_max_s, daily_cap, window_start, window_end, batch_size,
                                        batch_pause_min, created_by)
  values (btrim(p_campaign ->> 'title'), btrim(p_campaign ->> 'body'), nullif(p_campaign ->> 'poster_path', ''),
          coalesce((p_campaign ->> 'add_stop_line')::boolean, true), left(p_campaign ->> 'audience', 300),
          greatest(coalesce((p_campaign ->> 'start_at')::timestamptz, now()), now()),
          (p_campaign ->> 'min_gap_s')::integer, (p_campaign ->> 'max_gap_s')::integer,
          coalesce((p_campaign ->> 'typing_min_s')::integer, 3), coalesce((p_campaign ->> 'typing_max_s')::integer, 8),
          (p_campaign ->> 'daily_cap')::integer, nullif(p_campaign ->> 'window_start', '')::time, nullif(p_campaign ->> 'window_end', '')::time,
          coalesce((p_campaign ->> 'batch_size')::integer, 0), coalesce((p_campaign ->> 'batch_pause_min')::integer, 0), auth.uid())
  returning id into v_id;

  insert into public.dv_bulk_recipients (campaign_id, seq, phone, name, lead_id, profile_id)
  select v_id, row_number() over (order by ord), phone, name, lead_id, profile_id from pg_temp.bulk_in;

  perform private.audit('dv.bulk_created', 'dv_bulk_campaign', v_id,
    jsonb_build_object('recipients', v_kept, 'invalid', v_invalid, 'duplicates', v_dupes, 'opted_out', v_opted, 'do_not_contact', v_dnc));
  return jsonb_build_object('id', v_id, 'recipients', v_kept, 'invalid', v_invalid, 'duplicates', v_dupes, 'opted_out', v_opted, 'do_not_contact', v_dnc);
end;
$$;

-- Pause / resume / cancel. Pausing or cancelling takes back anything queued but not sent.
create function public.dv_bulk_control(p_id uuid, p_action text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.dv_bulk_campaigns;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select * into c from public.dv_bulk_campaigns where id = p_id for update;
  if c.id is null then
    raise exception 'Bulk message not found' using errcode = 'P0002';
  end if;
  if p_action in ('pause', 'cancel') then
    if c.status in ('completed', 'cancelled') then
      raise exception 'This bulk message has already finished' using errcode = '55000';
    end if;
    update public.wa_outbox o set status = 'cancelled', last_error = 'Bulk message ' || p_action || 'd'
      from public.dv_bulk_recipients r
     where r.campaign_id = p_id and r.status = 'queued' and o.id = r.outbox_id and o.status = 'queued';
    update public.dv_bulk_recipients r set status = case when p_action = 'cancel' then 'skipped' else 'pending' end, outbox_id = null, scheduled_at = null
      from public.wa_outbox o
     where r.campaign_id = p_id and r.status = 'queued' and o.id = r.outbox_id and o.status = 'cancelled';
    if p_action = 'cancel' then
      update public.dv_bulk_recipients set status = 'skipped' where campaign_id = p_id and status = 'pending';
    end if;
    update public.dv_bulk_campaigns
       set status = case when p_action = 'cancel' then 'cancelled' else 'paused' end,
           status_reason = case when p_action = 'cancel' then 'Cancelled' else 'Paused by a person' end, next_send_at = null
     where id = p_id;
  elsif p_action = 'resume' then
    if c.status <> 'paused' then
      raise exception 'Only a paused bulk message can be resumed' using errcode = '55000';
    end if;
    update public.dv_bulk_campaigns set status = 'sending', status_reason = null, next_send_at = now() where id = p_id;
  else
    raise exception 'Unknown action' using errcode = '22023';
  end if;
  perform private.audit('dv.bulk_' || p_action, 'dv_bulk_campaign', p_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- The pacer (every minute)
-- ---------------------------------------------------------------------------
-- The first moment at or after p_ts allowed by the sending hours and the daily cap.
create function private.dv_bulk_fit(c public.dv_bulk_campaigns, p_ts timestamptz, p_tz text)
returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ts timestamptz := p_ts;
  v_local timestamp;
  v_day_start timestamptz;
  i integer;
begin
  for i in 1..14 loop
    v_local := v_ts at time zone p_tz;
    if c.window_start is not null then
      if v_local::time < c.window_start then
        v_ts := (v_local::date + c.window_start) at time zone p_tz;
      elsif v_local::time >= c.window_end then
        v_ts := ((v_local::date + 1) + c.window_start) at time zone p_tz;
        continue;
      end if;
    end if;
    v_day_start := ((v_ts at time zone p_tz)::date)::timestamp at time zone p_tz;
    if (select count(*) from public.dv_bulk_recipients r
         where r.campaign_id = c.id and r.scheduled_at >= v_day_start and r.scheduled_at < v_day_start + interval '1 day') < c.daily_cap then
      return v_ts;
    end if;
    -- Today's cap is used up: the start of tomorrow's sending hours.
    v_ts := ((v_ts at time zone p_tz)::date + 1 + coalesce(c.window_start, time '00:00')) at time zone p_tz;
  end loop;
  return v_ts;
end;
$$;

create function public.dv_bulk_tick()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.wa_account;
  v_tz text;
  c public.dv_bulk_campaigns;
  r public.dv_bulk_recipients;
  v_next timestamptz;
  v_n integer;
  v_total integer := 0;
  v_first text;
  v_body text;
  v_out uuid;
  v_seq integer;
begin
  select * into v_acc from public.wa_account where id;
  select default_timezone into v_tz from public.org_settings where id;

  -- Results from the gateway.
  update public.dv_bulk_recipients br
     set status = case o.status when 'sent' then 'sent' when 'failed' then 'failed' else 'skipped' end,
         done_at = coalesce(o.sent_at, now()), error = o.last_error
    from public.wa_outbox o
   where br.status = 'queued' and o.id = br.outbox_id and o.status in ('sent', 'failed', 'cancelled');

  for c in select * from public.dv_bulk_campaigns where status in ('scheduled', 'sending') and start_at <= now() order by created_at for update skip locked loop
    -- Five failures in a row: stop and let a person look.
    if (select count(*) filter (where x.status = 'failed') from (
          select status from public.dv_bulk_recipients where campaign_id = c.id and status in ('sent', 'failed')
           order by done_at desc limit 5) x) = 5 then
      perform public.dv_bulk_control_system(c.id, 'Paused: the last 5 messages failed. Check the WhatsApp connection, then resume.');
      continue;
    end if;
    if not exists (select 1 from public.dv_bulk_recipients where campaign_id = c.id and status in ('pending', 'queued')) then
      update public.dv_bulk_campaigns set status = 'completed', status_reason = null, next_send_at = null where id = c.id;
      continue;
    end if;
    -- Only while the number is switched on and connected: no backlog, no burst later.
    continue when not coalesce(v_acc.enabled, false) or v_acc.status <> 'connected';

    v_next := greatest(coalesce(c.next_send_at, now()), now());
    v_n := 0;
    loop
      exit when v_n >= 20;
      v_next := private.dv_bulk_fit(c, v_next, v_tz);
      exit when v_next > now() + interval '2 minutes';
      select * into r from public.dv_bulk_recipients where campaign_id = c.id and status = 'pending' order by seq limit 1 for update skip locked;
      exit when r.id is null;
      if exists (select 1 from public.dv_opt_outs o where o.phone = r.phone) then
        update public.dv_bulk_recipients set status = 'opted_out', done_at = now() where id = r.id;
        continue;
      end if;
      v_first := split_part(coalesce(nullif(btrim(r.name), ''), ''), ' ', 1);
      v_body := replace(replace(c.body, '{{full_name}}', coalesce(nullif(btrim(r.name), ''), '')), '{{name}}', v_first);
      v_body := regexp_replace(v_body, '[ \t]+([,!.?])', '\1', 'g');   -- "Namaste , " when there is no name
      if c.add_stop_line then
        v_body := v_body || E'\n\nReply STOP to stop these messages.';
      end if;
      insert into public.wa_outbox (chat_jid, kind, body, media_path, status, auto, idempotency_key, created_by, approved_by, send_after, typing_ms)
      values (regexp_replace(r.phone, '\D', '', 'g') || '@s.whatsapp.net', 'bulk', left(btrim(v_body), 4000), c.poster_path, 'queued', false,
              -- No idempotency key: the recipient row is locked and moved to "queued" in the same
              -- transaction, and after a pause the same person must be queueable again.
              null, c.created_by, c.created_by, v_next,
              ((c.typing_min_s + random() * (c.typing_max_s - c.typing_min_s)) * 1000)::integer)
      returning id into v_out;
      update public.dv_bulk_recipients set status = 'queued', outbox_id = v_out, scheduled_at = v_next where id = r.id;
      update public.dv_bulk_campaigns set queued_count = queued_count + 1 where id = c.id returning queued_count into v_seq;
      v_next := v_next + make_interval(secs => c.min_gap_s + random() * (c.max_gap_s - c.min_gap_s));
      if c.batch_size > 0 and v_seq % c.batch_size = 0 then
        v_next := v_next + make_interval(mins => c.batch_pause_min);
      end if;
      v_n := v_n + 1;
    end loop;
    update public.dv_bulk_campaigns
       set next_send_at = v_next, status = case when v_n > 0 then 'sending' else status end
     where id = c.id;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end;
$$;

-- Pausing on behalf of the system (no permission check; called by the pacer only).
create function public.dv_bulk_control_system(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.wa_outbox o set status = 'cancelled', last_error = 'Bulk message paused'
    from public.dv_bulk_recipients r
   where r.campaign_id = p_id and r.status = 'queued' and o.id = r.outbox_id and o.status = 'queued';
  update public.dv_bulk_recipients r set status = 'pending', outbox_id = null, scheduled_at = null
    from public.wa_outbox o
   where r.campaign_id = p_id and r.status = 'queued' and o.id = r.outbox_id and o.status = 'cancelled';
  update public.dv_bulk_campaigns set status = 'paused', status_reason = p_reason, next_send_at = null where id = p_id;
  perform private.audit('dv.bulk_auto_paused', 'dv_bulk_campaign', p_id, jsonb_build_object('reason', p_reason), null);
end;
$$;

-- ---------------------------------------------------------------------------
-- "STOP": the person never gets bulk messages again
-- ---------------------------------------------------------------------------
create function public.dv_opt_out_by_message(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  v_phone text;
begin
  select * into m from public.wa_messages where id = p_message_id and direction = 'in';
  if m.id is null or m.chat_jid like '%@g.us' or m.intent is not null then
    return jsonb_build_object('handled', false);
  end if;
  v_phone := coalesce(m.sender_phone,
                      case when m.chat_jid like '%@s.whatsapp.net' then '+' || split_part(m.chat_jid, '@', 1) end);
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    return jsonb_build_object('handled', false);
  end if;
  insert into public.dv_opt_outs (phone, source) values (v_phone, 'reply') on conflict (phone) do nothing;
  update public.dv_bulk_recipients set status = 'opted_out', done_at = now() where phone = v_phone and status = 'pending';
  update public.wa_messages set intent = 'opt_out', intent_source = 'keywords', status = 'processed', processed_at = now() where id = m.id;
  if coalesce((select enabled from public.wa_account where id), false) then
    insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
    values (m.chat_jid, 'direct', 'Done. You will not get these messages from us again. Jai Gurudev 🙏', m.id, 'queued', true, 'optout:' || m.id)
    on conflict (idempotency_key) do nothing;
  end if;
  perform private.audit('dv.opt_out', 'wa_message', m.id, '{}'::jsonb, null);
  return jsonb_build_object('handled', true);
end;
$$;

-- Someone asked by other means: add or remove a number by hand.
create function public.dv_set_opt_out(p_phone text, p_opted_out boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Enter the number in international format, e.g. +919845012345' using errcode = '22023';
  end if;
  if p_opted_out then
    insert into public.dv_opt_outs (phone, source) values (p_phone, 'manual') on conflict (phone) do nothing;
    update public.dv_bulk_recipients set status = 'opted_out', done_at = now() where phone = p_phone and status = 'pending';
  else
    delete from public.dv_opt_outs where phone = p_phone;
  end if;
  perform private.audit('dv.opt_out_manual', 'dv_opt_out', null, jsonb_build_object('opted_out', p_opted_out));
end;
$$;

revoke all on function public.dv_bulk_create(jsonb, jsonb, boolean), public.dv_bulk_control(uuid, text), public.dv_set_opt_out(text, boolean) from public, anon;
grant execute on function public.dv_bulk_create(jsonb, jsonb, boolean), public.dv_bulk_control(uuid, text), public.dv_set_opt_out(text, boolean) to authenticated;
revoke all on function public.dv_bulk_tick(), public.dv_bulk_control_system(uuid, text), public.dv_opt_out_by_message(uuid) from public, anon, authenticated;
revoke all on function private.dv_bulk_fit(public.dv_bulk_campaigns, timestamptz, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_bulk_tick(), public.dv_opt_out_by_message(uuid) to service_role;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dv-bulk-tick', '* * * * *', 'select public.dv_bulk_tick()');
  end if;
end;
$$;
