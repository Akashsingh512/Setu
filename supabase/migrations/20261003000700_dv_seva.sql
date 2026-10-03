-- Digital Volunteer, part 3: seva requests and lead allocation.
--
-- Someone asks (in an enabled group or privately) to do seva / get numbers to
-- call. The request is recorded; leads are allocated either automatically (only
-- when the group is in Automatic mode, lead assignment is ticked, and the
-- requester is a verified CRM volunteer) or after an operator approves.
--
-- Safety rules enforced here, in the database:
--   * only an active CRM volunteer with a team can receive leads; an unknown
--     number gets nothing until an operator identifies them;
--   * leads must be unassigned, in the requester's team, not archived/merged/
--     closed, and never a lead this person already held;
--   * the count is the smallest of: per-request limit (or a temporary
--     exception), the group's limit, remaining open-lead capacity, and the
--     optional daily / weekly limits;
--   * rows are locked (FOR UPDATE SKIP LOCKED) so two requests can never take
--     the same lead, and a per-requester lock stops limit races;
--   * assignment goes through private.reassign_lead, so history, deadlines and
--     the 24-hour reassignment rule work exactly as for any assignment;
--   * lead details go only to the requester's CRM-registered number, by direct
--     message; the group only gets a short acknowledgement with no personal data;
--   * nobody can approve their own request.

alter type public.assignment_kind add value if not exists 'seva_request';

alter table public.wa_account add column dm_seva_requests boolean not null default false;

-- ---------------------------------------------------------------------------
-- Limits
-- ---------------------------------------------------------------------------
create table public.dv_seva_settings (
  id                  boolean primary key default true check (id),
  default_per_request integer not null default 5 check (default_per_request between 1 and 50),
  default_max_active  integer check (default_max_active is null or default_max_active >= 1),
  daily_limit         integer check (daily_limit is null or daily_limit >= 1),
  weekly_limit        integer check (weekly_limit is null or weekly_limit >= 1),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.profiles (id)
);
insert into public.dv_seva_settings default values;

create table public.dv_seva_limits (
  profile_id            uuid primary key references public.profiles (id),
  per_request           integer check (per_request between 1 and 50),
  max_active            integer check (max_active >= 1),
  daily_limit           integer check (daily_limit >= 1),
  weekly_limit          integer check (weekly_limit >= 1),
  -- Temporary exception: a higher per-request count until a deadline.
  exception_per_request integer check (exception_per_request between 1 and 50),
  exception_until       timestamptz,
  note                  text check (length(note) <= 300),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.profiles (id),
  check ((exception_per_request is null) = (exception_until is null))
);

-- ---------------------------------------------------------------------------
-- Requests and what they produced
-- ---------------------------------------------------------------------------
create table public.dv_seva_requests (
  id                   uuid primary key default gen_random_uuid(),
  message_id           uuid not null unique references public.wa_messages (id),   -- one request per message
  group_id             uuid references public.wa_groups (id),
  chat_jid             text not null,
  sender_phone         public.e164,
  sender_name          text,
  request_text         text,
  requested_count      integer check (requested_count between 1 and 50),
  requester_profile_id uuid references public.profiles (id),     -- the verified CRM volunteer
  verified_by          uuid references public.profiles (id),     -- operator who identified an unknown sender
  status               text not null default 'pending'
                       check (status in ('pending', 'fulfilled', 'rejected', 'no_leads', 'cancelled')),
  auto                 boolean not null default false,
  assigned_count       integer not null default 0,
  decided_by           uuid references public.profiles (id),
  decided_at           timestamptz,
  reason               text,
  created_at           timestamptz not null default now()
);
create index dv_seva_requests_status_idx on public.dv_seva_requests (status, created_at desc);
-- A sender can have only one open request at a time (stops repeated asking from piling up).
create unique index dv_seva_one_open_per_sender on public.dv_seva_requests
  ((coalesce(requester_profile_id::text, sender_phone::text))) where status = 'pending';

create table public.dv_seva_request_leads (
  request_id    uuid not null references public.dv_seva_requests (id),
  lead_id       uuid not null references public.leads (id),
  assignment_id uuid references public.lead_assignments (id),
  assigned_at   timestamptz not null default now(),
  revoked_at    timestamptz,
  primary key (request_id, lead_id)
);
create index dv_seva_request_leads_lead_idx on public.dv_seva_request_leads (lead_id);

-- ---------------------------------------------------------------------------
-- Planning: how many leads may this person get right now?
-- ---------------------------------------------------------------------------
create function private.dv_seva_plan(p_profile uuid, p_group uuid, p_requested integer)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.dv_seva_settings;
  l public.dv_seva_limits;
  p public.profiles;
  o public.org_settings;
  v_tz text;
  v_per integer;
  v_cap integer;
  v_group_max integer;
  v_daily integer;
  v_weekly integer;
  v_open integer;
  v_today integer;
  v_week integer;
  v_allowed integer;
  v_available integer;
  v_reason text;
begin
  select * into s from public.dv_seva_settings where id;
  select * into o from public.org_settings where id;
  select * into l from public.dv_seva_limits where profile_id = p_profile;
  select * into p from public.profiles where id = p_profile;
  v_tz := o.default_timezone;

  if p.id is null or p.status <> 'active' then
    return jsonb_build_object('allowed', 0, 'available', 0, 'reason', 'The requester is not an active volunteer');
  end if;
  if p.team_id is null then
    return jsonb_build_object('allowed', 0, 'available', 0, 'reason', 'The requester is not in a team');
  end if;

  v_per := case when l.exception_until > now() then l.exception_per_request
                else coalesce(l.per_request, s.default_per_request) end;
  v_per := coalesce(v_per, s.default_per_request);
  -- The seva cap and the volunteer's normal workload cap both apply.
  v_cap := least(coalesce(l.max_active, s.default_max_active), coalesce(p.max_open_leads, o.default_max_open_leads));
  v_daily := coalesce(l.daily_limit, s.daily_limit);
  v_weekly := coalesce(l.weekly_limit, s.weekly_limit);
  select max_leads_per_request into v_group_max from public.wa_groups where id = p_group;

  select count(*) into v_open from public.lead_assignments where assignee_id = p.id and ended_at is null;
  select count(*) into v_today from public.lead_assignments
   where assignee_id = p.id and kind = 'seva_request'
     and assigned_at >= date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  select count(*) into v_week from public.lead_assignments
   where assignee_id = p.id and kind = 'seva_request'
     and assigned_at >= date_trunc('week', now() at time zone v_tz) at time zone v_tz;

  -- least() ignores NULLs: an unset limit simply doesn't apply.
  v_allowed := greatest(0, least(v_per, v_group_max, p_requested, v_cap - v_open, v_daily - v_today, v_weekly - v_week));

  -- Same conditions as the allocation query in dv_seva_allocate.
  select count(*) into v_available
    from public.leads le
    join public.lead_statuses st on st.code = le.status
   where le.team_id = p.team_id and le.assigned_to is null and le.current_assignment_id is null
     and le.archived_at is null and le.merged_into_id is null and not st.is_closed
     and not exists (select 1 from public.lead_assignments a where a.lead_id = le.id and a.assignee_id = p.id);

  if v_allowed = 0 then
    v_reason := case
      when v_cap - v_open <= 0 then 'Already holds the maximum number of open leads'
      when v_daily - v_today <= 0 then 'Daily limit reached'
      when v_weekly - v_week <= 0 then 'Weekly limit reached'
      else 'No leads can be given right now' end;
  elsif v_available = 0 then
    v_reason := 'No unassigned leads are available for this team right now';
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'allowed', v_allowed, 'available', v_available, 'reason', v_reason,
    'per_request', v_per, 'group_max', v_group_max, 'open', v_open, 'max_active', v_cap,
    'today', v_today, 'daily_limit', v_daily, 'week', v_week, 'weekly_limit', v_weekly,
    'exception_active', coalesce(l.exception_until > now(), false)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Allocation (the only place leads are handed out)
-- ---------------------------------------------------------------------------
create function private.dv_seva_allocate(p_request_id uuid, p_actor uuid, p_count integer default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.dv_seva_requests;
  p public.profiles;
  g public.wa_groups;
  v_plan jsonb;
  v_n integer;
  v_lead record;
  v_assignment uuid;
  v_ids uuid[] := '{}';
  v_lines text := '';
  v_hours integer;
  v_first text;
  v_dm boolean := false;
  v_note text;
begin
  select * into r from public.dv_seva_requests where id = p_request_id for update;
  if r.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request was already handled' using errcode = '55000';
  end if;
  if r.requester_profile_id is null then
    raise exception 'Identify who this is before assigning leads' using errcode = '55000';
  end if;
  -- One allocation per person at a time, so limits can't be raced past.
  perform pg_advisory_xact_lock(hashtextextended('dv_seva:' || r.requester_profile_id::text, 0));

  select * into p from public.profiles where id = r.requester_profile_id;
  select * into g from public.wa_groups where id = r.group_id;
  select contact_deadline_hours into v_hours from public.org_settings where id;
  v_first := split_part(coalesce(nullif(btrim(p.full_name), ''), 'friend'), ' ', 1);

  v_plan := private.dv_seva_plan(p.id, r.group_id, coalesce(p_count, r.requested_count));
  v_n := least((v_plan ->> 'allowed')::integer, coalesce(p_count, (v_plan ->> 'allowed')::integer));

  if v_n <= 0 then
    update public.dv_seva_requests
       set status = 'rejected', decided_by = p_actor, decided_at = now(), auto = p_actor is null,
           reason = coalesce(v_plan ->> 'reason', 'No leads can be given right now')
     where id = r.id;
    update public.wa_messages set status = 'processed' where id = r.message_id;
    perform private.notify(p.id, 'seva_request_declined', 'Seva request not fulfilled',
      coalesce(v_plan ->> 'reason', 'No leads can be given right now'), jsonb_build_object('request_id', r.id));
    perform private.audit('dv.seva_declined', 'dv_seva_request', r.id, jsonb_build_object('plan', v_plan), p_actor);
    return jsonb_build_object('status', 'rejected', 'reason', v_plan ->> 'reason', 'assigned', 0);
  end if;

  for v_lead in
    select le.id, le.lead_code, le.full_name, le.phone, c.name as course_name
      from public.leads le
      join public.lead_statuses st on st.code = le.status
      left join public.courses c on c.id = le.course_id
     where le.team_id = p.team_id and le.assigned_to is null and le.current_assignment_id is null
       and le.archived_at is null and le.merged_into_id is null and not st.is_closed
       and not exists (select 1 from public.lead_assignments a where a.lead_id = le.id and a.assignee_id = p.id)
     order by le.needs_attention desc, le.created_at
     limit v_n
       for update of le skip locked
  loop
    v_assignment := private.reassign_lead(v_lead.id, p.id, 'seva_request', p_actor, null, 'Seva request via WhatsApp');
    insert into public.dv_seva_request_leads (request_id, lead_id, assignment_id)
    values (r.id, v_lead.id, v_assignment);
    v_ids := v_ids || v_lead.id;
    v_lines := v_lines || format(E'• %s – %s%s (%s)\n', v_lead.full_name, v_lead.phone,
      case when v_lead.course_name is not null then ' · ' || v_lead.course_name else '' end, v_lead.lead_code);
  end loop;

  if cardinality(v_ids) = 0 then
    update public.dv_seva_requests
       set status = 'no_leads', decided_by = p_actor, decided_at = now(), auto = p_actor is null,
           reason = 'No unassigned leads are available for this team right now'
     where id = r.id;
    update public.wa_messages set status = 'processed' where id = r.message_id;
    perform private.notify(p.id, 'seva_request_declined', 'No leads available right now',
      'There are no unassigned leads for your team at the moment. Please try again later.', jsonb_build_object('request_id', r.id));
    perform private.audit('dv.seva_no_leads', 'dv_seva_request', r.id, '{}'::jsonb, p_actor);
    return jsonb_build_object('status', 'no_leads', 'assigned', 0);
  end if;

  update public.dv_seva_requests
     set status = 'fulfilled', assigned_count = cardinality(v_ids), decided_by = p_actor, decided_at = now(),
         auto = p_actor is null
   where id = r.id;
  update public.wa_messages set status = 'processed' where id = r.message_id;

  -- In-app (and phone) notification to the volunteer; responsible admin hears about automatic hand-outs.
  perform private.notify(p.id, 'lead_assigned',
    case when cardinality(v_ids) = 1 then 'New lead assigned' else 'New leads assigned' end,
    format('%s lead(s) assigned to you through your seva request. Please call within %s hours.', cardinality(v_ids), v_hours),
    jsonb_build_object('lead_ids', to_jsonb(v_ids), 'request_id', r.id, 'source', 'whatsapp'));
  if p_actor is null then
    v_note := format('%s received %s lead(s) from a WhatsApp seva request.', coalesce(nullif(btrim(p.full_name), ''), 'A volunteer'), cardinality(v_ids));
    if g.responsible_admin_id is not null then
      perform private.notify(g.responsible_admin_id, 'seva_assigned', 'Seva leads assigned', v_note, jsonb_build_object('request_id', r.id));
    else
      perform private.notify_team_staff(p.team_id, 'seva_assigned', 'Seva leads assigned', v_note, jsonb_build_object('request_id', r.id));
    end if;
  end if;

  -- Lead details: private message to the CRM-registered number only.
  if p.phone is not null then
    v_dm := true;
    insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key, created_by, approved_by)
    values (replace(p.phone, '+', '') || '@s.whatsapp.net', 'seva_numbers',
      format(E'Jai Gurudev 🙏 %s\n\n%s lead(s) assigned to you:\n\n%s\nPlease call within %s hours and record the outcome in Setu.\n\nThank you for your seva 🙏',
             v_first, cardinality(v_ids), v_lines, v_hours),
      'queued', p_actor is null, 'seva:' || r.id, p_actor, p_actor)
    on conflict (idempotency_key) do nothing;
  end if;
  -- Group acknowledgement: no personal data.
  if r.chat_jid like '%@g.us' and (select enabled from public.wa_account where id) then
    insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key, created_by, approved_by)
    values (r.chat_jid, 'reply',
      case when v_dm then format('Jai Gurudev 🙏 %s, %s lead(s) have been sent to you privately. Please check your messages and call within %s hours.', v_first, cardinality(v_ids), v_hours)
           else format('Jai Gurudev 🙏 %s, %s lead(s) have been assigned to you in Setu (My Leads). Please call within %s hours.', v_first, cardinality(v_ids), v_hours) end,
      r.message_id, 'queued', p_actor is null, 'seva-ack:' || r.id, p_actor, p_actor)
    on conflict (idempotency_key) do nothing;
  end if;

  perform private.audit('dv.seva_assigned', 'dv_seva_request', r.id,
    jsonb_build_object('requester', p.id, 'lead_ids', to_jsonb(v_ids), 'group', r.group_id, 'plan', v_plan, 'auto', p_actor is null), p_actor);
  return jsonb_build_object('status', 'fulfilled', 'assigned', cardinality(v_ids), 'lead_ids', to_jsonb(v_ids));
end;
$$;

-- ---------------------------------------------------------------------------
-- A new request arrives (called from dv_record_intent)
-- ---------------------------------------------------------------------------
create function private.dv_seva_open_request(p_message_id uuid, p_requested integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  acc public.wa_account;
  g public.wa_groups;
  p public.profiles;
  v_id uuid;
  v_auto boolean := false;
  v_result jsonb;
  v_op uuid;
begin
  select * into m from public.wa_messages where id = p_message_id;
  select * into acc from public.wa_account where id;
  select * into g from public.wa_groups where id = m.group_id;
  if m.sender_profile_id is not null then
    select * into p from public.profiles
     where id = m.sender_profile_id and status = 'active' and team_id is not null;
  end if;

  begin
    insert into public.dv_seva_requests (message_id, group_id, chat_jid, sender_phone, sender_name, request_text,
                                         requested_count, requester_profile_id)
    values (m.id, m.group_id, m.chat_jid, m.sender_phone, m.sender_name, left(m.body, 500), p_requested, p.id)
    returning id into v_id;
  exception when unique_violation then
    -- Same message again, or this sender already has a request waiting.
    return jsonb_build_object('duplicate', true);
  end;

  v_auto := p.id is not null and acc.enabled and not acc.auto_paused
    and case when m.chat_jid like '%@g.us'
             then g.mode = 'automatic' and g.allow_lead_assignment and g.allow_seva_requests
             else acc.dm_mode = 'automatic' and acc.dm_seva_requests end;

  if v_auto then
    begin
      v_result := private.dv_seva_allocate(v_id, null, null);
      return v_result || jsonb_build_object('request_id', v_id);
    exception when others then
      -- The allocation rolled back; leave the request for a person.
      update public.dv_seva_requests set reason = 'Automatic assignment failed: ' || left(sqlerrm, 200) where id = v_id;
    end;
  end if;

  for v_op in
    select pr.id from public.profiles pr
     where pr.status = 'active'
       and (pr.role = 'super_admin'
            or exists (select 1 from public.dv_operator_permissions op where op.profile_id = pr.id and op.permission = 'assign_seva'))
  loop
    perform private.notify(v_op, 'seva_request_pending', 'Seva request waiting',
      case when p.id is null then 'Someone asked for leads on WhatsApp. They could not be matched to a volunteer: please check.'
           else 'A volunteer asked for leads on WhatsApp and is waiting for approval.' end,
      jsonb_build_object('request_id', v_id));
  end loop;
  return jsonb_build_object('status', 'pending', 'request_id', v_id, 'verified', p.id is not null);
end;
$$;

-- ---------------------------------------------------------------------------
-- dv_record_intent: now also opens seva requests (new signature: p_requested_count)
-- ---------------------------------------------------------------------------
drop function if exists public.dv_record_intent(uuid, text, text, text, text);

create function public.dv_record_intent(
  p_message_id uuid, p_intent text, p_source text, p_reply text default null, p_reply_kind text default null,
  p_requested_count integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_msg public.wa_messages;
  v_acc public.wa_account;
  v_group public.wa_groups;
  v_allowed boolean;
  v_mode public.dv_mode;
  v_outbox uuid;
  v_status text;
  v_send text;
  v_seva jsonb;
begin
  select * into v_msg from public.wa_messages where id = p_message_id and direction = 'in';
  if v_msg.id is null then
    raise exception 'Message not found' using errcode = '22023';
  end if;
  if v_msg.intent is not null then
    return jsonb_build_object('skipped', true, 'reason', 'already_processed');
  end if;
  select * into v_acc from public.wa_account where id;

  if v_msg.chat_jid like '%@g.us' then
    select * into v_group from public.wa_groups where id = v_msg.group_id;
    v_mode := coalesce(v_group.mode, 'manual');
    v_allowed := coalesce(v_group.enabled and v_group.is_member and v_group.allow_read, false)
      and case p_intent
            when 'course_info' then v_group.allow_course_info
            when 'seva_request' then v_group.allow_seva_requests
            else false end;
  else
    v_mode := v_acc.dm_mode;
    v_allowed := case p_intent when 'course_info' then v_acc.dm_course_info
                               when 'seva_request' then v_acc.dm_seva_requests
                               else false end;
  end if;

  v_status := case when p_intent = 'none' or not v_allowed then 'ignored' else 'needs_review' end;

  if p_intent = 'course_info' and v_allowed and v_acc.enabled and v_mode <> 'manual'
     and coalesce(btrim(p_reply), '') <> '' then
    v_send := case when v_mode = 'automatic' and not v_acc.auto_paused and p_reply_kind is distinct from 'fallback'
                   then 'queued' else 'pending_approval' end;
    insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
    values (v_msg.chat_jid, 'reply', left(btrim(p_reply), 4000), v_msg.id, v_send, true, 'answer:' || v_msg.id)
    on conflict (idempotency_key) do nothing
    returning id into v_outbox;
    if v_send = 'queued' then
      v_status := 'processed';
    end if;
  end if;

  update public.wa_messages
     set intent = p_intent, intent_source = p_source, status = v_status, processed_at = now(), outbox_id = v_outbox
   where id = v_msg.id;

  if p_intent = 'seva_request' and v_allowed and v_acc.enabled then
    v_seva := private.dv_seva_open_request(v_msg.id, p_requested_count);
    if (v_seva ->> 'duplicate')::boolean is true then
      update public.wa_messages set status = 'ignored' where id = v_msg.id;
      v_status := 'ignored';
    elsif v_seva ->> 'status' = 'fulfilled' then
      v_status := 'processed';   -- dv_seva_allocate already marked it
    end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object('status', v_status, 'outbox_id', v_outbox, 'send', v_send, 'seva', v_seva));
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator actions
-- ---------------------------------------------------------------------------
create function public.dv_seva_preview(p_request_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.dv_seva_requests;
begin
  if not private.dv_can('assign_seva') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select * into r from public.dv_seva_requests where id = p_request_id;
  if r.id is null or r.requester_profile_id is null then
    return jsonb_build_object('allowed', 0, 'available', 0, 'reason', 'Identify who this is first');
  end if;
  return private.dv_seva_plan(r.requester_profile_id, r.group_id, r.requested_count);
end;
$$;

create function public.dv_seva_approve(p_request_id uuid, p_count integer default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.dv_seva_requests;
begin
  if not private.dv_can('assign_seva') then
    raise exception 'Not authorised to assign seva leads' using errcode = '42501';
  end if;
  select * into r from public.dv_seva_requests where id = p_request_id;
  if r.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if r.requester_profile_id = auth.uid() then
    raise exception 'You cannot approve your own request' using errcode = '42501';
  end if;
  if p_count is not null and p_count < 1 then
    raise exception 'Choose at least one lead' using errcode = '22023';
  end if;
  return private.dv_seva_allocate(p_request_id, auth.uid(), p_count);
end;
$$;

create function public.dv_seva_reject(p_request_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.dv_seva_requests;
begin
  if not private.dv_can('assign_seva') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.dv_seva_requests
     set status = 'rejected', decided_by = auth.uid(), decided_at = now(), reason = left(nullif(btrim(p_reason), ''), 300)
   where id = p_request_id and status = 'pending'
  returning * into r;
  if r.id is null then
    raise exception 'This request was already handled' using errcode = '55000';
  end if;
  update public.wa_messages set status = 'processed' where id = r.message_id;
  if r.requester_profile_id is not null then
    perform private.notify(r.requester_profile_id, 'seva_request_declined', 'Seva request not approved',
      coalesce(left(nullif(btrim(p_reason), ''), 200), 'Your request for leads was not approved this time.'),
      jsonb_build_object('request_id', r.id));
  end if;
  perform private.audit('dv.seva_rejected', 'dv_seva_request', r.id, jsonb_build_object('reason', p_reason));
end;
$$;

-- Matches an unrecognised sender to a CRM volunteer (identity check by a person).
create function public.dv_seva_set_requester(p_request_id uuid, p_profile_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('assign_seva') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_profile_id = auth.uid() then
    raise exception 'You cannot identify yourself as the requester' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and status = 'active' and team_id is not null) then
    raise exception 'Choose an active volunteer who is in a team' using errcode = '22023';
  end if;
  begin
    update public.dv_seva_requests
       set requester_profile_id = p_profile_id, verified_by = auth.uid()
     where id = p_request_id and status = 'pending';
  exception when unique_violation then
    raise exception 'That volunteer already has a request waiting' using errcode = '55000';
  end;
  if not found then
    raise exception 'This request was already handled' using errcode = '55000';
  end if;
  perform private.audit('dv.seva_identified', 'dv_seva_request', p_request_id, jsonb_build_object('profile_id', p_profile_id));
end;
$$;

-- Takes back leads from a request that haven't been worked yet. Leads that
-- already have a call stay with the volunteer.
create function public.dv_seva_revoke(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.dv_seva_requests;
  v_row record;
  v_revoked integer := 0;
  v_kept integer := 0;
begin
  if not private.dv_can('assign_seva') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select * into r from public.dv_seva_requests where id = p_request_id for update;
  if r.id is null or r.status <> 'fulfilled' then
    raise exception 'Only a fulfilled request can be reversed' using errcode = '55000';
  end if;
  for v_row in
    select rl.lead_id, rl.assignment_id, a.first_contact_at, le.current_assignment_id
      from public.dv_seva_request_leads rl
      join public.leads le on le.id = rl.lead_id
      join public.lead_assignments a on a.id = rl.assignment_id
     where rl.request_id = r.id and rl.revoked_at is null
     order by rl.lead_id
       for update of le
  loop
    if v_row.current_assignment_id = v_row.assignment_id and v_row.first_contact_at is null then
      perform private.reassign_lead(v_row.lead_id, null, 'manual', auth.uid(), 'unassigned_manual', 'Seva assignment reversed');
      update public.dv_seva_request_leads set revoked_at = now() where request_id = r.id and lead_id = v_row.lead_id;
      v_revoked := v_revoked + 1;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;
  if v_revoked > 0 and r.requester_profile_id is not null then
    perform private.notify(r.requester_profile_id, 'seva_assignment_reversed', 'Some leads were taken back',
      format('%s lead(s) from your seva request were returned to the pool.', v_revoked), jsonb_build_object('request_id', r.id));
  end if;
  perform private.audit('dv.seva_revoked', 'dv_seva_request', r.id, jsonb_build_object('revoked', v_revoked, 'kept', v_kept));
  return jsonb_build_object('revoked', v_revoked, 'kept', v_kept);
end;
$$;

-- Active volunteers an operator may pick when identifying a requester or setting limits.
create function public.dv_seva_candidates()
returns table (id uuid, full_name text, team_name text, has_phone boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.dv_can('assign_seva') or private.dv_can('manage_integration')) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'Volunteer'), t.name, p.phone is not null
      from public.profiles p
      left join public.teams t on t.id = p.team_id
     where p.status = 'active' and p.role = 'volunteer' and p.team_id is not null
     order by 2;
end;
$$;

create function public.dv_save_seva_settings(
  p_default_per_request integer, p_default_max_active integer, p_daily_limit integer, p_weekly_limit integer
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised to change seva limits' using errcode = '42501';
  end if;
  update public.dv_seva_settings
     set default_per_request = p_default_per_request, default_max_active = p_default_max_active,
         daily_limit = p_daily_limit, weekly_limit = p_weekly_limit, updated_at = now(), updated_by = auth.uid()
   where id;
  perform private.audit('dv.seva_settings_changed', 'dv_seva_settings', null,
    jsonb_build_object('per_request', p_default_per_request, 'max_active', p_default_max_active,
                       'daily', p_daily_limit, 'weekly', p_weekly_limit));
end;
$$;

create function public.dv_save_seva_limit(
  p_profile_id uuid, p_per_request integer, p_max_active integer, p_daily_limit integer, p_weekly_limit integer,
  p_exception_per_request integer default null, p_exception_until timestamptz default null, p_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised to change seva limits' using errcode = '42501';
  end if;
  if (p_exception_per_request is null) <> (p_exception_until is null) then
    raise exception 'A temporary exception needs both a number and an end date' using errcode = '22023';
  end if;
  if p_exception_until is not null and (p_exception_until <= now() or p_exception_until > now() + interval '31 days') then
    raise exception 'A temporary exception must end within the next 31 days' using errcode = '22023';
  end if;
  if num_nulls(p_per_request, p_max_active, p_daily_limit, p_weekly_limit, p_exception_per_request) = 5 then
    delete from public.dv_seva_limits where profile_id = p_profile_id;
  else
    insert into public.dv_seva_limits (profile_id, per_request, max_active, daily_limit, weekly_limit,
                                       exception_per_request, exception_until, note, updated_by)
    values (p_profile_id, p_per_request, p_max_active, p_daily_limit, p_weekly_limit,
            p_exception_per_request, p_exception_until, left(nullif(btrim(p_note), ''), 300), auth.uid())
    on conflict (profile_id) do update
       set per_request = excluded.per_request, max_active = excluded.max_active, daily_limit = excluded.daily_limit,
           weekly_limit = excluded.weekly_limit, exception_per_request = excluded.exception_per_request,
           exception_until = excluded.exception_until, note = excluded.note, updated_at = now(), updated_by = auth.uid();
  end if;
  perform private.audit('dv.seva_limit_changed', 'profile', p_profile_id,
    jsonb_build_object('per_request', p_per_request, 'max_active', p_max_active, 'daily', p_daily_limit,
                       'weekly', p_weekly_limit, 'exception', p_exception_per_request, 'until', p_exception_until));
end;
$$;

-- Direct-chat settings gain "seva requests" (replaces the 3-argument version).
drop function if exists public.dv_set_dm_settings(public.dv_mode, boolean, boolean);
create function public.dv_set_dm_settings(
  p_mode public.dv_mode, p_course_info boolean, p_followup_sync boolean, p_seva_requests boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_groups') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.wa_account
     set dm_mode = p_mode, dm_course_info = p_course_info, dm_followup_sync = p_followup_sync,
         dm_seva_requests = p_seva_requests, updated_at = now(), updated_by = auth.uid()
   where id;
  perform private.audit('dv.dm_settings_changed', 'wa_account', null,
    jsonb_build_object('mode', p_mode, 'course_info', p_course_info, 'followup_sync', p_followup_sync, 'seva_requests', p_seva_requests));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on public.dv_seva_settings, public.dv_seva_limits, public.dv_seva_requests, public.dv_seva_request_leads
  from anon, authenticated;
grant select on public.dv_seva_settings, public.dv_seva_limits, public.dv_seva_requests, public.dv_seva_request_leads
  to authenticated;
alter table public.dv_seva_settings      enable row level security;
alter table public.dv_seva_limits        enable row level security;
alter table public.dv_seva_requests      enable row level security;
alter table public.dv_seva_request_leads enable row level security;

create policy dv_seva_settings_select on public.dv_seva_settings for select to authenticated
  using (private.dv_can('assign_seva') or private.dv_can('manage_integration'));
create policy dv_seva_limits_select on public.dv_seva_limits for select to authenticated
  using (private.dv_can('assign_seva') or private.dv_can('manage_integration'));
create policy dv_seva_requests_select on public.dv_seva_requests for select to authenticated
  using (private.dv_can('assign_seva') or private.dv_can('view_audit'));
create policy dv_seva_request_leads_select on public.dv_seva_request_leads for select to authenticated
  using (private.dv_can('assign_seva') or private.dv_can('view_audit'));

revoke all on function public.dv_record_intent(uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.dv_seva_preview(uuid) from public, anon;
revoke all on function public.dv_seva_approve(uuid, integer) from public, anon;
revoke all on function public.dv_seva_reject(uuid, text) from public, anon;
revoke all on function public.dv_seva_set_requester(uuid, uuid) from public, anon;
revoke all on function public.dv_seva_revoke(uuid) from public, anon;
revoke all on function public.dv_seva_candidates() from public, anon;
revoke all on function public.dv_save_seva_settings(integer, integer, integer, integer) from public, anon;
revoke all on function public.dv_save_seva_limit(uuid, integer, integer, integer, integer, integer, timestamptz, text) from public, anon;
revoke all on function public.dv_set_dm_settings(public.dv_mode, boolean, boolean, boolean) from public, anon;
grant execute on function public.dv_seva_preview(uuid), public.dv_seva_approve(uuid, integer),
                          public.dv_seva_reject(uuid, text), public.dv_seva_set_requester(uuid, uuid),
                          public.dv_seva_revoke(uuid), public.dv_seva_candidates(),
                          public.dv_save_seva_settings(integer, integer, integer, integer),
                          public.dv_save_seva_limit(uuid, integer, integer, integer, integer, integer, timestamptz, text),
                          public.dv_set_dm_settings(public.dv_mode, boolean, boolean, boolean)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.dv_seva_requests, public.dv_seva_request_leads to service_role;
    grant execute on function public.dv_record_intent(uuid, text, text, text, text, integer) to service_role;
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.dv_seva_requests;
  end if;
end;
$$;
