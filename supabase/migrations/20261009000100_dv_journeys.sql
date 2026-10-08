-- Digital Volunteer: follow-up journeys.
--
-- A journey is a path of steps that keeps a person connected after they meet the
-- Art of Living: "Day 1 10:00 a welcome message, Day 3 a call by their volunteer,
-- Day 7 an invite to the next program…". People are started on a journey by hand
-- (Leads > tick > Start journey, or from the lead page).
--
-- Steps (each N days after the previous one, at a time of day):
--   * message         - a WhatsApp message from the Setu number ({{name}}, {{full_name}},
--                       {{volunteer}}), with an optional poster, typed like a person.
--   * call_task       - a follow-up for the lead's volunteer, who gets the usual
--                       WhatsApp reminder (Seva & allotting > follow-up reminder).
--   * program_invite  - the next upcoming program (of a course, or any), with its
--                       date, venue, link and poster ({{program}} {{date}} {{venue}} {{link}}).
--
-- When the person writes back:
--   * AI (or a reply rule / course answer) answers by itself, if the journey allows it;
--   * the message (and what Setu answered) is forwarded to their volunteer, who can
--     answer by swiping right on it (or "Reply L-000037 …"); that goes to the person
--     from the Setu number, signed with the volunteer's name;
--   * it is in the Inbox as always;
--   * the journey can pause until the volunteer answers (or N hours pass).
-- Stopping (chosen per journey): when the lead reaches chosen statuses. "Do not
-- contact" and STOP always stop it.
-- Permission: the Digital Volunteer "Announcements" permission, plus access to the lead.

alter table public.wa_outbox drop constraint wa_outbox_kind_check;
alter table public.wa_outbox add constraint wa_outbox_kind_check
  check (kind in ('reply', 'direct', 'announcement', 'seva_numbers', 'bulk', 'journey'));

create table public.dv_journeys (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(btrim(name)) between 1 and 120),
  description        text check (length(description) <= 1000),
  active             boolean not null default true,
  ai_auto_reply      boolean not null default true,   -- Setu answers replies by itself
  forward_replies    boolean not null default true,   -- replies go to the lead's volunteer
  pause_on_reply     boolean not null default false,  -- wait for the volunteer before the next step
  resume_after_hours integer not null default 48 check (resume_after_hours between 1 and 720),
  stop_statuses      text[] not null default '{not_interested,invalid_number}',
  created_by         uuid references public.profiles (id) default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.dv_journey_steps (
  id          uuid primary key default gen_random_uuid(),
  journey_id  uuid not null references public.dv_journeys (id) on delete cascade,
  position    integer not null check (position between 1 and 100),
  kind        text not null check (kind in ('message', 'call_task', 'program_invite')),
  delay_days  integer not null default 0 check (delay_days between 0 and 365),
  send_time   time not null default '10:00',
  body        text check (length(body) <= 3900),
  poster_path text check (poster_path ~ '^announcements/[A-Za-z0-9._/-]+$'),
  course_id   uuid references public.courses (id),
  unique (journey_id, position),
  check (kind <> 'message' or coalesce(btrim(body), '') <> '' or poster_path is not null)
);

create table public.dv_journey_enrollments (
  id            uuid primary key default gen_random_uuid(),
  journey_id    uuid not null references public.dv_journeys (id) on delete cascade,
  lead_id       uuid not null references public.leads (id),
  status        text not null default 'active' check (status in ('active', 'paused', 'completed', 'stopped')),
  next_position integer not null default 1,
  next_at       timestamptz,
  paused_until  timestamptz,
  status_reason text,
  last_step_at  timestamptz,
  last_reply_at timestamptz,
  started_by    uuid references public.profiles (id),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create unique index dv_journey_enrollments_live_idx on public.dv_journey_enrollments (journey_id, lead_id) where status in ('active', 'paused');
create index dv_journey_enrollments_due_idx on public.dv_journey_enrollments (next_at) where status = 'active';
create index dv_journey_enrollments_lead_idx on public.dv_journey_enrollments (lead_id, started_at desc);

-- A participant's message forwarded to their volunteer: a swipe-reply to it answers them.
create table public.dv_journey_forwards (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.dv_journey_enrollments (id) on delete cascade,
  lead_id       uuid not null references public.leads (id),
  volunteer_id  uuid not null references public.profiles (id),
  message_id    uuid not null references public.wa_messages (id),
  outbox_id     uuid not null references public.wa_outbox (id),
  created_at    timestamptz not null default now()
);
create index dv_journey_forwards_outbox_idx on public.dv_journey_forwards (outbox_id);

alter table public.dv_journeys enable row level security;
alter table public.dv_journey_steps enable row level security;
alter table public.dv_journey_enrollments enable row level security;
alter table public.dv_journey_forwards enable row level security;
create policy dv_journeys_select on public.dv_journeys for select to authenticated
  using (private.dv_can('schedule_announcements') or private.my_role() is not null);
create policy dv_journey_steps_select on public.dv_journey_steps for select to authenticated
  using (private.dv_can('schedule_announcements'));
create policy dv_journey_enrollments_select on public.dv_journey_enrollments for select to authenticated
  using (private.dv_can('schedule_announcements') or private.can_view_lead(lead_id));
grant select on public.dv_journeys, public.dv_journey_steps, public.dv_journey_enrollments to authenticated;

-- ---------------------------------------------------------------------------
-- When a step is due: N days after `from`, at the step's time (organisation time
-- zone). A same-day time that has passed means "now", but never at night.
-- ---------------------------------------------------------------------------
create function private.dv_journey_due(p_from timestamptz, p_delay integer, p_time time, p_tz text)
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_local timestamp := p_from at time zone p_tz;
  v_at timestamptz := ((v_local::date + p_delay) + p_time) at time zone p_tz;
begin
  if v_at >= p_from then
    return v_at;
  end if;
  if v_local::time between '08:00' and '21:00' then
    return p_from;
  end if;
  return ((v_local::date + 1) + p_time) at time zone p_tz;
end;
$$;

-- ---------------------------------------------------------------------------
-- Creating and changing journeys
-- ---------------------------------------------------------------------------
create function public.dv_journey_save(p_id uuid, p_journey jsonb, p_steps jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  s jsonb;
  v_pos integer := 0;
  v_kind text;
begin
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if coalesce(btrim(p_journey ->> 'name'), '') = '' then
    raise exception 'Give the journey a name' using errcode = '22023';
  end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'Add at least one step' using errcode = '22023';
  end if;
  if jsonb_array_length(p_steps) > 100 then
    raise exception 'At most 100 steps' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.dv_journeys (name) values (btrim(p_journey ->> 'name')) returning id into v_id;
  elsif not exists (select 1 from public.dv_journeys where id = v_id) then
    raise exception 'Journey not found' using errcode = 'P0002';
  end if;

  update public.dv_journeys set
    name = left(btrim(p_journey ->> 'name'), 120),
    description = nullif(left(btrim(coalesce(p_journey ->> 'description', '')), 1000), ''),
    active = coalesce((p_journey ->> 'active')::boolean, active),
    ai_auto_reply = coalesce((p_journey ->> 'ai_auto_reply')::boolean, ai_auto_reply),
    forward_replies = coalesce((p_journey ->> 'forward_replies')::boolean, forward_replies),
    pause_on_reply = coalesce((p_journey ->> 'pause_on_reply')::boolean, pause_on_reply),
    resume_after_hours = coalesce((p_journey ->> 'resume_after_hours')::integer, resume_after_hours),
    stop_statuses = coalesce(
      (select array_agg(x) from jsonb_array_elements_text(p_journey -> 'stop_statuses') x
        where x in (select code from public.lead_statuses)),
      case when p_journey ? 'stop_statuses' then '{}'::text[] else stop_statuses end),
    updated_at = now()
  where id = v_id;

  -- Steps are replaced; people on the journey continue from the same step number.
  delete from public.dv_journey_steps where journey_id = v_id;
  for s in select * from jsonb_array_elements(p_steps) loop
    v_pos := v_pos + 1;
    v_kind := s ->> 'kind';
    if v_kind not in ('message', 'call_task', 'program_invite') then
      raise exception 'Step %: choose what it does', v_pos using errcode = '22023';
    end if;
    if v_kind = 'message' and coalesce(btrim(s ->> 'body'), '') = '' and nullif(s ->> 'poster_path', '') is null then
      raise exception 'Step %: write the message', v_pos using errcode = '22023';
    end if;
    insert into public.dv_journey_steps (journey_id, position, kind, delay_days, send_time, body, poster_path, course_id)
    values (v_id, v_pos, v_kind, coalesce((s ->> 'delay_days')::integer, 0), coalesce(nullif(s ->> 'send_time', '')::time, '10:00'),
            nullif(btrim(coalesce(s ->> 'body', '')), ''), nullif(s ->> 'poster_path', ''), nullif(s ->> 'course_id', '')::uuid);
  end loop;

  perform private.audit('dv.journey_saved', 'dv_journey', v_id, jsonb_build_object('steps', v_pos, 'new', p_id is null));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Starting people on a journey, and pausing / resuming / stopping them
-- ---------------------------------------------------------------------------
create function public.dv_journey_start(p_journey_id uuid, p_lead_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  j public.dv_journeys;
  st public.dv_journey_steps;
  l public.leads;
  v_tz text;
  v_started integer := 0;
  v_already integer := 0;
  v_skipped integer := 0;
begin
  perform private.require_active_user();
  if not private.dv_can('schedule_announcements') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select * into j from public.dv_journeys where id = p_journey_id;
  if j.id is null then
    raise exception 'Journey not found' using errcode = 'P0002';
  end if;
  select * into st from public.dv_journey_steps where journey_id = j.id order by position limit 1;
  if st.id is null then
    raise exception 'This journey has no steps yet' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_lead_ids, '{}')) > 2000 then
    raise exception 'At most 2000 people at a time' using errcode = '22023';
  end if;
  select default_timezone into v_tz from public.org_settings where id;

  for l in select * from public.leads where id = any (p_lead_ids) loop
    if l.archived_at is not null or l.merged_into_id is not null
       or not (private.can_manage_team(l.team_id) or l.assigned_to = auth.uid())
       or exists (select 1 from public.lead_statuses where code = l.status and blocks_contact) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if exists (select 1 from public.dv_journey_enrollments where journey_id = j.id and lead_id = l.id and status in ('active', 'paused')) then
      v_already := v_already + 1;
      continue;
    end if;
    insert into public.dv_journey_enrollments (journey_id, lead_id, next_position, next_at, started_by)
    values (j.id, l.id, st.position, private.dv_journey_due(now(), st.delay_days, st.send_time, v_tz), auth.uid());
    perform private.log_activity(l.id, 'journey_started', jsonb_build_object('journey_id', j.id, 'journey', j.name));
    v_started := v_started + 1;
  end loop;

  perform private.audit('dv.journey_started', 'dv_journey', j.id, jsonb_build_object('started', v_started));
  return jsonb_build_object('started', v_started, 'already', v_already, 'skipped', v_skipped);
end;
$$;

create function public.dv_journey_control(p_enrollment_id uuid, p_action text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.dv_journey_enrollments;
  l public.leads;
begin
  perform private.require_active_user();
  select * into e from public.dv_journey_enrollments where id = p_enrollment_id for update;
  if e.id is null then
    raise exception 'Not found' using errcode = 'P0002';
  end if;
  select * into l from public.leads where id = e.lead_id;
  if not (private.dv_can('schedule_announcements') and (private.can_manage_team(l.team_id) or l.assigned_to = auth.uid())) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_action = 'pause' and e.status = 'active' then
    update public.dv_journey_enrollments set status = 'paused', paused_until = null, status_reason = 'Paused by hand' where id = e.id;
  elsif p_action = 'resume' and e.status = 'paused' then
    update public.dv_journey_enrollments
       set status = 'active', paused_until = null, status_reason = null, next_at = greatest(coalesce(next_at, now()), now())
     where id = e.id;
  elsif p_action = 'stop' and e.status in ('active', 'paused') then
    update public.dv_journey_enrollments set status = 'stopped', status_reason = 'Stopped by hand', finished_at = now() where id = e.id;
    perform private.log_activity(l.id, 'journey_stopped',
      jsonb_build_object('journey_id', e.journey_id, 'journey', (select name from public.dv_journeys where id = e.journey_id), 'reason', 'Stopped by hand'));
  elsif p_action not in ('pause', 'resume', 'stop') then
    raise exception 'Unknown action' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Every minute: run the steps that are due (only while WhatsApp is on and connected)
-- ---------------------------------------------------------------------------
create function private.dv_journey_finish(e public.dv_journey_enrollments, p_status text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.dv_journey_enrollments set status = p_status, status_reason = p_reason, finished_at = now(), next_at = null where id = e.id;
  perform private.log_activity(e.lead_id, case when p_status = 'completed' then 'journey_completed' else 'journey_stopped' end,
    jsonb_strip_nulls(jsonb_build_object('journey_id', e.journey_id, 'journey', (select name from public.dv_journeys where id = e.journey_id), 'reason', p_reason)),
    null);
end;
$$;

create function public.dv_journey_tick()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_acc public.wa_account;
  v_tz text;
  e public.dv_journey_enrollments;
  j public.dv_journeys;
  st public.dv_journey_steps;
  nx public.dv_journey_steps;
  l public.leads;
  vol public.profiles;
  v_phone text;
  v_body text;
  v_media text;
  v_slot timestamptz;
  v_done integer := 0;
  v_out uuid;
  v_sess record;
  v_note text;
begin
  select * into v_acc from public.wa_account where id;
  if not coalesce(v_acc.enabled, false) or v_acc.status <> 'connected' then
    return 0;
  end if;
  select default_timezone into v_tz from public.org_settings where id;

  -- Paused after a reply, and nobody answered in time: carry on.
  update public.dv_journey_enrollments
     set status = 'active', paused_until = null, status_reason = null, next_at = greatest(coalesce(next_at, now()), now())
   where status = 'paused' and paused_until is not null and paused_until <= now();

  -- Messages go out one by one, 20-60 s apart, like a person sending them.
  select greatest(now(), coalesce(max(send_after), now())) into v_slot
    from public.wa_outbox where kind = 'journey' and status = 'queued';

  for e in
    select x.* from public.dv_journey_enrollments x join public.dv_journeys jj on jj.id = x.journey_id and jj.active
     where x.status = 'active' and x.next_at <= now()
     order by x.next_at limit 50
     for update of x skip locked
  loop
    exit when v_slot > now() + interval '10 minutes';   -- the rest next minute
    select * into j from public.dv_journeys where id = e.journey_id;
    select * into l from public.leads where id = e.lead_id;
    v_phone := coalesce(l.whatsapp_phone, l.phone);

    -- Should this person still be on the journey?
    if l.archived_at is not null or l.merged_into_id is not null then
      perform private.dv_journey_finish(e, 'stopped', 'The lead was deleted or merged');
      continue;
    elsif exists (select 1 from public.lead_statuses where code = l.status and blocks_contact) then
      perform private.dv_journey_finish(e, 'stopped', 'Do not contact');
      continue;
    elsif l.status = any (j.stop_statuses) then
      perform private.dv_journey_finish(e, 'stopped', format('Status: %s', (select label from public.lead_statuses where code = l.status)));
      continue;
    elsif exists (select 1 from public.dv_opt_outs o where o.phone = v_phone) then
      perform private.dv_journey_finish(e, 'stopped', 'They asked not to get messages (STOP)');
      continue;
    end if;

    select * into st from public.dv_journey_steps where journey_id = j.id and position >= e.next_position order by position limit 1;
    if st.id is null then
      perform private.dv_journey_finish(e, 'completed', null);
      continue;
    end if;
    select * into vol from public.profiles where id = l.assigned_to and status = 'active';
    v_body := null;
    v_media := st.poster_path;
    v_note := null;

    if st.kind = 'call_task' then
      if vol.id is null then
        v_note := 'skipped: no volunteer';
      else
        insert into public.follow_ups (lead_id, owner_id, due_at, note, created_by)
        values (l.id, vol.id, now() + interval '15 minutes',
                left(format('Journey "%s": %s', j.name, coalesce(st.body, 'Call to see how they are doing')), 2000), null);
      end if;
    else
      if st.kind = 'program_invite' then
        select s.id, coalesce(nullif(btrim(s.title), ''), c.name) as program, s.starts_at, coalesce(s.timezone, v_tz) as tz, s.mode,
               concat_ws(', ', nullif(btrim(s.venue), ''), nullif(btrim(s.city), '')) as venue,
               coalesce(s.registration_url, c.registration_url) as link,
               coalesce(s.poster_path, (select t.poster_path from public.dv_response_templates t where t.kind = 'course_details')) as poster
          into v_sess
          from public.course_sessions s join public.courses c on c.id = s.course_id and c.is_active
         where s.status = 'scheduled' and s.starts_at > now()
           and (st.course_id is null or s.course_id = st.course_id)
           and (s.team_id is null or s.team_id = l.team_id)
         order by s.starts_at limit 1;
        if v_sess.id is null then
          v_note := 'skipped: no upcoming program';
        else
          v_body := coalesce(st.body,
            E'Namaste {{name}} 🙏\n\nThe next *{{program}}* is on {{date}}{{venue}}.\nRegister: {{link}}\n\nWould love to see you there!');
          v_body := replace(replace(replace(replace(v_body,
            '{{program}}', v_sess.program),
            '{{date}}', to_char(v_sess.starts_at at time zone v_sess.tz, 'Dy DD Mon, HH12:MI am')),
            '{{venue}}', case when v_sess.mode = 'online' then ' (online)' when v_sess.venue <> '' then ' at ' || v_sess.venue else '' end),
            '{{link}}', coalesce(v_sess.link, ''));
          v_media := coalesce(st.poster_path, v_sess.poster);
        end if;
      else
        v_body := coalesce(st.body, '');
      end if;

      if v_note is null and v_phone is null then
        v_note := 'skipped: no phone number';
      elsif v_note is null then
        v_body := replace(replace(replace(v_body,
          '{{full_name}}', coalesce(nullif(btrim(l.full_name), ''), '')),
          '{{name}}', split_part(coalesce(nullif(btrim(l.full_name), ''), ''), ' ', 1)),
          '{{volunteer}}', split_part(coalesce(nullif(btrim(vol.full_name), ''), ''), ' ', 1));
        v_body := regexp_replace(v_body, '[ \t]+([,!.?])', '\1', 'g');
        v_slot := v_slot + make_interval(secs => 20 + random() * 40);
        insert into public.wa_outbox (chat_jid, kind, body, media_path, status, auto, send_after, typing_ms, idempotency_key)
        values (regexp_replace(v_phone, '\D', '', 'g') || '@s.whatsapp.net', 'journey', nullif(left(btrim(v_body), 4000), ''), v_media,
                'queued', true, v_slot, (2000 + random() * 5000)::integer, format('journey:%s:%s', e.id, st.position))
        on conflict (idempotency_key) do nothing
        returning id into v_out;
      end if;
    end if;

    perform private.log_activity(l.id, 'journey_step', jsonb_strip_nulls(jsonb_build_object(
      'journey_id', j.id, 'journey', j.name, 'step', st.position, 'kind', st.kind, 'outbox_id', v_out,
      'preview', left(v_body, 280), 'note', v_note)), null);

    select * into nx from public.dv_journey_steps where journey_id = j.id and position > st.position order by position limit 1;
    if nx.id is null then
      update public.dv_journey_enrollments set last_step_at = now(), next_position = st.position + 1 where id = e.id;
      e.next_position := st.position + 1;
      perform private.dv_journey_finish(e, 'completed', null);
    else
      update public.dv_journey_enrollments
         set last_step_at = now(), next_position = nx.position, next_at = private.dv_journey_due(now(), nx.delay_days, nx.send_time, v_tz)
       where id = e.id;
    end if;
    v_out := null;
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;

-- ---------------------------------------------------------------------------
-- The person writes back
-- ---------------------------------------------------------------------------
-- Their live journey (or one that ended in the last 30 days), for the gateway.
create function private.dv_journey_of_message(p_message_id uuid)
returns public.dv_journey_enrollments
language sql stable security definer set search_path = '' as $$
  select e.* from public.wa_messages m
    join public.dv_journey_enrollments e on e.lead_id = m.lead_id
   where m.id = p_message_id and m.direction = 'in' and m.chat_jid not like '%@g.us' and m.sender_profile_id is null
     and (e.status in ('active', 'paused') or e.finished_at > now() - interval '30 days')
   order by e.status in ('active', 'paused') desc, e.started_at desc
   limit 1
$$;

create function public.dv_journey_participant(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e public.dv_journey_enrollments := private.dv_journey_of_message(p_message_id);
  j public.dv_journeys;
begin
  if e.id is null then
    return jsonb_build_object('journey', false);
  end if;
  select * into j from public.dv_journeys where id = e.journey_id;
  return jsonb_build_object('journey', true, 'enrollment_id', e.id, 'name', j.name, 'ai_auto', j.ai_auto_reply,
    'volunteer', (select split_part(btrim(p.full_name), ' ', 1) from public.leads l join public.profiles p on p.id = l.assigned_to
                   join public.wa_messages m on m.lead_id = l.id where m.id = p_message_id));
end;
$$;

-- p_reply: what Setu answers by itself (only used when the journey allows it).
create function public.dv_journey_on_reply(
  p_message_id uuid, p_reply text default null, p_media_path text default null,
  p_intent text default null, p_source text default null, p_reply_kind text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  e public.dv_journey_enrollments := private.dv_journey_of_message(p_message_id);
  j public.dv_journeys;
  l public.leads;
  vol public.profiles;
  v_sent boolean := false;
  v_out uuid;
  v_fwd uuid;
begin
  if e.id is null or not coalesce((select enabled from public.wa_account where id), false) then
    return jsonb_build_object('handled', false);
  end if;
  select * into m from public.wa_messages where id = p_message_id;
  select * into j from public.dv_journeys where id = e.journey_id;
  select * into l from public.leads where id = e.lead_id;

  -- 1. Setu answers by itself.
  if j.ai_auto_reply and m.intent is null and coalesce(btrim(p_reply), '') <> '' then
    insert into public.wa_outbox (chat_jid, kind, body, media_path, quoted_message_id, status, auto, idempotency_key, ai_draft)
    values (m.chat_jid, 'reply', left(btrim(p_reply), 4000),
            case when p_media_path ~ '^(programs|templates)/[A-Za-z0-9._/-]+$' then p_media_path end,
            m.id, 'queued', true, 'answer:' || m.id, p_reply_kind = 'ai_draft')
    on conflict (idempotency_key) do nothing
    returning id into v_out;
    v_sent := v_out is not null;
    update public.wa_messages
       set intent = coalesce(p_intent, 'course_info'), intent_source = coalesce(p_source, 'ai'),
           status = 'processed', processed_at = now(), outbox_id = v_out
     where id = m.id;
  end if;

  -- 2. Their volunteer hears about it and can answer by swiping right.
  select * into vol from public.profiles where id = l.assigned_to and status = 'active' and phone is not null;
  if j.forward_replies and vol.id is not null then
    insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key)
    values (regexp_replace(vol.phone, '\D', '', 'g') || '@s.whatsapp.net', 'direct',
      format(E'💬 *%s* (%s) wrote:\n\n%s%s\n\n↩️ To answer, swipe right on this message and type your reply. It goes to %s from the Setu number.',
             l.full_name, l.lead_code,
             coalesce(nullif(btrim(m.body), ''), '(sent ' || coalesce(m.media_type, 'a file') || ')'),
             case when v_sent then E'\n\n🤖 Setu replied:\n' || left(btrim(p_reply), 1500) else '' end,
             split_part(btrim(l.full_name), ' ', 1)),
      'queued', true, 'journey-fwd:' || m.id)
    on conflict (idempotency_key) do nothing
    returning id into v_fwd;
    if v_fwd is not null then
      insert into public.dv_journey_forwards (enrollment_id, lead_id, volunteer_id, message_id, outbox_id)
      values (e.id, l.id, vol.id, m.id, v_fwd);
    end if;
  end if;

  -- 3. Wait for the volunteer before the next step, if the journey says so.
  update public.dv_journey_enrollments
     set last_reply_at = now(),
         status = case when j.pause_on_reply and status = 'active' then 'paused' else status end,
         paused_until = case when j.pause_on_reply and status = 'active' then now() + make_interval(hours => j.resume_after_hours) else paused_until end,
         status_reason = case when j.pause_on_reply and status = 'active' then 'They replied: waiting for the volunteer' else status_reason end
   where id = e.id;

  return jsonb_strip_nulls(jsonb_build_object('handled', true, 'replied', v_sent, 'forwarded', v_fwd is not null));
end;
$$;

-- ---------------------------------------------------------------------------
-- The volunteer answers: a swipe-reply to the forwarded message, or "Reply L-000037 …"
-- ---------------------------------------------------------------------------
create function public.dv_journey_volunteer_reply(p_message_id uuid, p_quoted_id text default null, p_lead_code text default null, p_text text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  p public.profiles;
  l public.leads;
  v_text text;
  v_reply text;
  v_out uuid;
  v_phone text;
begin
  select * into m from public.wa_messages where id = p_message_id and direction = 'in';
  if m.id is null or m.chat_jid like '%@g.us' or m.intent is not null or m.sender_profile_id is null
     or not coalesce((select enabled from public.wa_account where id), false) then
    return jsonb_build_object('handled', false);
  end if;
  select * into p from public.profiles where id = m.sender_profile_id and status = 'active';
  if p.id is null then
    return jsonb_build_object('handled', false);
  end if;

  if p_quoted_id is not null then
    select ld.* into l
      from public.wa_messages o
      join public.dv_journey_forwards f on f.outbox_id = o.outbox_id and f.volunteer_id = p.id
      join public.leads ld on ld.id = f.lead_id
     where o.chat_jid = m.chat_jid and o.provider_message_id = p_quoted_id and o.direction = 'out'
     limit 1;
    if l.id is null then
      return jsonb_build_object('handled', false);   -- a reply to some other message
    end if;
  elsif p_lead_code is not null then
    select * into l from public.leads
     where lead_code = regexp_replace(upper(p_lead_code), '^L-?', 'L-') and archived_at is null and merged_into_id is null;
    if l.id is null or not (l.assigned_to = p.id or p.role = 'super_admin') then
      v_reply := format('%s is not one of your leads in Setu, so nothing was sent.', upper(p_lead_code));
    end if;
  else
    return jsonb_build_object('handled', false);
  end if;

  v_text := btrim(coalesce(p_text, m.body, ''));
  v_phone := coalesce(l.whatsapp_phone, l.phone);
  if v_reply is null then
    if l.archived_at is not null or l.merged_into_id is not null then
      v_reply := format('%s is no longer in Setu, so nothing was sent.', l.full_name);
    elsif exists (select 1 from public.lead_statuses where code = l.status and blocks_contact) then
      v_reply := format('%s (%s) is marked Do not contact, so nothing was sent.', l.full_name, l.lead_code);
    elsif v_text = '' then
      v_reply := 'Only text can be passed on. Please type your reply.';
    elsif v_phone is null then
      v_reply := format('%s has no phone number in Setu, so nothing was sent.', l.full_name);
    else
      insert into public.wa_outbox (chat_jid, kind, body, status, auto, created_by, approved_by, idempotency_key)
      values (regexp_replace(v_phone, '\D', '', 'g') || '@s.whatsapp.net', 'direct',
              left(v_text || E'\n\n– ' || split_part(coalesce(nullif(btrim(p.full_name), ''), 'Setu'), ' ', 1), 4000),
              'queued', false, p.id, p.id, 'journey-relay:' || m.id)
      on conflict (idempotency_key) do nothing
      returning id into v_out;
      perform private.log_activity(l.id, 'whatsapp_sent',
        jsonb_build_object('outbox_id', v_out, 'preview', left(v_text, 280), 'via', 'volunteer_whatsapp'), p.id);
      -- They have been answered: the journey carries on.
      update public.dv_journey_enrollments
         set status = 'active', paused_until = null, status_reason = null, next_at = greatest(coalesce(next_at, now()), now())
       where lead_id = l.id and status = 'paused' and paused_until is not null;
      v_reply := format('✅ Sent to %s (%s) from the Setu number.', l.full_name, l.lead_code);
    end if;
  end if;

  update public.wa_messages
     set intent = 'journey_reply', intent_source = 'keywords', status = 'processed', processed_at = now()
   where id = m.id;
  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', v_reply, m.id, 'queued', true, 'journey-relay-ok:' || m.id)
  on conflict (idempotency_key) do nothing;
  return jsonb_strip_nulls(jsonb_build_object('handled', true, 'lead_id', l.id, 'sent', v_out is not null, 'reply', v_reply));
end;
$$;

revoke all on function public.dv_journey_save(uuid, jsonb, jsonb), public.dv_journey_start(uuid, uuid[]),
  public.dv_journey_control(uuid, text) from public, anon;
grant execute on function public.dv_journey_save(uuid, jsonb, jsonb), public.dv_journey_start(uuid, uuid[]),
  public.dv_journey_control(uuid, text) to authenticated;
revoke all on function public.dv_journey_tick(), public.dv_journey_participant(uuid),
  public.dv_journey_on_reply(uuid, text, text, text, text, text),
  public.dv_journey_volunteer_reply(uuid, text, text, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_journey_tick(), public.dv_journey_participant(uuid),
      public.dv_journey_on_reply(uuid, text, text, text, text, text),
      public.dv_journey_volunteer_reply(uuid, text, text, text) to service_role;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dv-journey-tick', '* * * * *', 'select public.dv_journey_tick()');
  end if;
end;
$$;
