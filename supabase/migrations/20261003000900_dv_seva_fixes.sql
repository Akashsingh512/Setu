-- Seva requests: three fixes found in real use.
--
-- 1. A lead is no longer withheld from someone just because they held it before.
--    It is withheld only when they LOST it by missing the contact deadline
--    (end reasons reassigned_auto / auto_no_candidate). Leads that were handed back
--    by a person (unassigned or moved manually, or an undone seva request) can be
--    given to them again.
-- 2. A request from someone who already has one waiting (same volunteer, phone or
--    WhatsApp id) is treated as a repeat and not opened again.
-- 3. For a private chat, the lead details are sent in the chat the request came
--    from, so it works even when the volunteer has no phone saved in Setu and when
--    WhatsApp identifies the chat by a hidden id. For a group request the details
--    still go only to the volunteer's Setu phone, never to the group.
-- The plan also reports how many unassigned leads exist, so the screen can say
-- why none are available to this person.

create or replace function private.dv_seva_plan(p_profile uuid, p_group uuid, p_requested integer)
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
  v_unassigned integer;
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

  v_allowed := greatest(0, least(v_per, v_group_max, p_requested, v_cap - v_open, v_daily - v_today, v_weekly - v_week));

  select count(*) into v_unassigned from public.leads le
   where le.team_id = p.team_id and le.assigned_to is null and le.current_assignment_id is null
     and le.archived_at is null and le.merged_into_id is null;

  -- Same conditions as the allocation query in dv_seva_allocate.
  select count(*) into v_available
    from public.leads le
    join public.lead_statuses st on st.code = le.status
   where le.team_id = p.team_id and le.assigned_to is null and le.current_assignment_id is null
     and le.archived_at is null and le.merged_into_id is null and not st.is_closed
     and not exists (select 1 from public.lead_assignments a
                      where a.lead_id = le.id and a.assignee_id = p.id
                        and a.end_reason in ('reassigned_auto', 'auto_no_candidate'));

  if v_allowed = 0 then
    v_reason := case
      when v_cap - v_open <= 0 then 'Already holds the maximum number of open leads'
      when v_daily - v_today <= 0 then 'Daily limit reached'
      when v_weekly - v_week <= 0 then 'Weekly limit reached'
      else 'No leads can be given right now' end;
  elsif v_available = 0 then
    v_reason := case when v_unassigned = 0
      then 'There are no unassigned leads in this team right now'
      else format('%s unassigned lead(s) exist, but they are closed or this volunteer lost them earlier by missing the contact deadline', v_unassigned) end;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'allowed', v_allowed, 'available', v_available, 'unassigned_total', v_unassigned, 'reason', v_reason,
    'per_request', v_per, 'group_max', v_group_max, 'open', v_open, 'max_active', v_cap,
    'today', v_today, 'daily_limit', v_daily, 'week', v_week, 'weekly_limit', v_weekly,
    'exception_active', coalesce(l.exception_until > now(), false)));
end;
$$;

create or replace function private.dv_seva_allocate(p_request_id uuid, p_actor uuid, p_count integer default null)
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
  v_dm_chat text;
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
       and not exists (select 1 from public.lead_assignments a
                        where a.lead_id = le.id and a.assignee_id = p.id
                          and a.end_reason in ('reassigned_auto', 'auto_no_candidate'))
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
           reason = coalesce(v_plan ->> 'reason', 'No unassigned leads are available for this team right now')
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

  -- Where the details go: in a private chat, back into that same chat (it is the person who
  -- asked, confirmed by phone, remembered link or an operator). For a group request: only to
  -- the volunteer's own Setu number, never into the group.
  v_dm_chat := case when r.chat_jid not like '%@g.us' then r.chat_jid
                    when p.phone is not null then replace(p.phone, '+', '') || '@s.whatsapp.net' end;
  if v_dm_chat is not null then
    insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key, created_by, approved_by)
    values (v_dm_chat, 'seva_numbers',
      format(E'Jai Gurudev 🙏 %s\n\n%s lead(s) assigned to you:\n\n%s\nPlease call within %s hours and record the outcome in Setu.\n\nThank you for your seva 🙏',
             v_first, cardinality(v_ids), v_lines, v_hours),
      'queued', p_actor is null, 'seva:' || r.id, p_actor, p_actor)
    on conflict (idempotency_key) do nothing;
  end if;
  -- Group acknowledgement: no personal data.
  if r.chat_jid like '%@g.us' and (select enabled from public.wa_account where id) then
    insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key, created_by, approved_by)
    values (r.chat_jid, 'reply',
      case when v_dm_chat is not null then format('Jai Gurudev 🙏 %s, %s lead(s) have been sent to you privately. Please check your messages and call within %s hours.', v_first, cardinality(v_ids), v_hours)
           else format('Jai Gurudev 🙏 %s, %s lead(s) have been assigned to you in Setu (My Leads). Please call within %s hours.', v_first, cardinality(v_ids), v_hours) end,
      r.message_id, 'queued', p_actor is null, 'seva-ack:' || r.id, p_actor, p_actor)
    on conflict (idempotency_key) do nothing;
  end if;

  perform private.audit('dv.seva_assigned', 'dv_seva_request', r.id,
    jsonb_build_object('requester', p.id, 'lead_ids', to_jsonb(v_ids), 'group', r.group_id, 'plan', v_plan, 'auto', p_actor is null), p_actor);
  return jsonb_build_object('status', 'fulfilled', 'assigned', cardinality(v_ids), 'lead_ids', to_jsonb(v_ids));
end;
$$;

-- A repeat from someone who already has a request waiting is not opened again.
create or replace function private.dv_seva_open_request(p_message_id uuid, p_requested integer)
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

  if exists (
    select 1 from public.dv_seva_requests q
     where q.status = 'pending'
       and ((p.id is not null and q.requester_profile_id = p.id)
            or (m.sender_phone is not null and q.sender_phone = m.sender_phone)
            or (m.sender_jid is not null and q.sender_jid = m.sender_jid))) then
    return jsonb_build_object('duplicate', true);
  end if;

  begin
    insert into public.dv_seva_requests (message_id, group_id, chat_jid, sender_jid, sender_phone, sender_name,
                                         request_text, requested_count, requester_profile_id)
    values (m.id, m.group_id, m.chat_jid, m.sender_jid, m.sender_phone, m.sender_name, left(m.body, 500),
            p_requested, p.id)
    returning id into v_id;
  exception when unique_violation then
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

-- Clearer message when the chosen volunteer already has another request waiting.
create or replace function public.dv_seva_set_requester(p_request_id uuid, p_profile_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_jid text;
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
     where id = p_request_id and status = 'pending'
    returning sender_jid into v_jid;
  exception when unique_violation then
    raise exception 'That volunteer already has another request waiting. Approve or decline that one first; this looks like a repeat.' using errcode = '55000';
  end;
  if not found then
    raise exception 'This request was already handled' using errcode = '55000';
  end if;
  if v_jid is not null then
    insert into public.dv_sender_links (sender_jid, profile_id, linked_by)
    values (v_jid, p_profile_id, auth.uid())
    on conflict (sender_jid) do update set profile_id = excluded.profile_id, linked_by = excluded.linked_by, linked_at = now();
  end if;
  perform private.audit('dv.seva_identified', 'dv_seva_request', p_request_id,
    jsonb_build_object('profile_id', p_profile_id, 'remembered', v_jid is not null));
end;
$$;
