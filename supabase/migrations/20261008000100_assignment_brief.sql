-- When leads are assigned in Setu, the volunteer can get them on WhatsApp too, with
-- the meeting notes and the follow-up history (chosen with two tick boxes).
-- Called by the app right after a successful assignment. Only leads that are now
-- held by that volunteer are sent. Long briefs are split into several messages.
-- Nothing is sent while Digital Volunteer is off; the app says so.

create function public.dv_send_assignment_brief(p_lead_ids uuid[], p_assignee uuid, p_notes boolean, p_history boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.profiles;
  me public.profiles;
  l record;
  v_tz text;
  v_hours integer;
  v_part text;
  v_parts text[] := '{}';
  v_chunk text := '';
  v_lead_count integer := 0;
  v_jid text;
  x record;
  i integer;
begin
  if not private.role_can('assign_leads') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select * into t from public.profiles where id = p_assignee and status = 'active';
  if t.id is null then
    return jsonb_build_object('sent', false, 'reason', 'volunteer not found');
  end if;
  if t.phone is null then
    return jsonb_build_object('sent', false, 'reason', format('%s has no phone number in Setu', t.full_name));
  end if;
  if not coalesce((select enabled from public.wa_account where id), false) then
    return jsonb_build_object('sent', false, 'reason', 'Digital Volunteer (WhatsApp) is switched off');
  end if;
  select * into me from public.profiles where id = auth.uid();
  select default_timezone, contact_deadline_hours into v_tz, v_hours from public.org_settings where id;

  for l in
    select le.*, c.name as course_name
      from public.leads le
      left join public.courses c on c.id = le.course_id
     where le.id = any (p_lead_ids) and le.assigned_to = t.id and private.can_view_lead(le.id)
     order by le.lead_code
     limit 200
  loop
    v_lead_count := v_lead_count + 1;
    v_part := format(E'*%s* – %s (%s)%s\n', l.full_name, l.phone, l.lead_code,
                     case when l.course_name is not null then E'\nInterested in: ' || l.course_name else '' end);
    if p_notes then
      if l.met_on is not null or l.met_by_name is not null or l.source_detail is not null then
        v_part := v_part || format(E'Met: %s\n', concat_ws(' · ', to_char(l.met_on, 'DD Mon'), nullif(btrim(l.met_by_name), ''), nullif(btrim(l.source_detail), '')));
      end if;
      if nullif(btrim(l.meeting_notes), '') is not null then
        v_part := v_part || format(E'Notes: %s\n', left(btrim(l.meeting_notes), 400));
      end if;
      if nullif(btrim(l.notes), '') is not null then
        v_part := v_part || format(E'More: %s\n', left(btrim(l.notes), 300));
      end if;
    end if;
    if p_history then
      -- The latest calls, notes and follow-up comments, newest first, at most 6 in all.
      for x in
        select * from (
          select ca.attempted_at as at, format('Call (%s)%s', replace(ca.outcome::text, '_', ' '),
                                               case when nullif(btrim(ca.notes), '') is not null then ': ' || left(btrim(ca.notes), 160) else '' end) as what,
                 ca.caller_id as who
            from public.call_attempts ca where ca.lead_id = l.id
          union all
          select n.created_at, 'Note: ' || left(btrim(n.body), 160), n.author_id from public.lead_notes n where n.lead_id = l.id
          union all
          select fc.created_at, 'Comment: ' || left(btrim(fc.body), 160), fc.author_id from public.follow_up_comments fc where fc.lead_id = l.id
        ) h order by h.at desc limit 6
      loop
        if v_part not like '%History:%' then
          v_part := v_part || E'History:\n';
        end if;
        v_part := v_part || format(E'  - %s %s%s\n', to_char(x.at at time zone v_tz, 'DD Mon'), x.what,
                                   coalesce(' (' || split_part((select full_name from public.profiles where id = x.who), ' ', 1) || ')', ''));
      end loop;
      if l.next_follow_up_at is not null then
        v_part := v_part || format(E'Next follow-up: %s\n', to_char(l.next_follow_up_at at time zone v_tz, 'DD Mon, HH12:MI am'));
      end if;
    end if;
    -- New message when this one would get too long for WhatsApp.
    if length(v_chunk) + length(v_part) > 3500 then
      v_parts := v_parts || v_chunk;
      v_chunk := '';
    end if;
    v_chunk := v_chunk || v_part || E'\n';
  end loop;

  if v_lead_count = 0 then
    return jsonb_build_object('sent', false, 'reason', 'none of these leads is assigned to them');
  end if;
  v_parts := v_parts || v_chunk;
  v_jid := regexp_replace(t.phone, '\D', '', 'g') || '@s.whatsapp.net';
  for i in 1 .. cardinality(v_parts) loop
    insert into public.wa_outbox (chat_jid, kind, body, status, auto, created_by, approved_by, send_after)
    values (v_jid, 'direct',
      left(case when i = 1 then format(E'Jai Gurudev 🙏 %s\n\n%s assigned you %s lead(s) in Setu. Please call within %s hours and record each call in Setu.\n\n',
                                       split_part(coalesce(nullif(btrim(t.full_name), ''), 'friend'), ' ', 1),
                                       coalesce(nullif(btrim(me.full_name), ''), 'Your coordinator'), v_lead_count, v_hours)
                else format(E'(%s/%s)\n\n', i, cardinality(v_parts)) end || btrim(v_parts[i]), 4000),
      'queued', false, auth.uid(), auth.uid(), now() + make_interval(secs => (i - 1) * 5));
  end loop;
  perform private.audit('leads.brief_sent', 'profile', t.id,
    jsonb_build_object('lead_count', v_lead_count, 'notes', p_notes, 'history', p_history, 'messages', cardinality(v_parts)));
  return jsonb_build_object('sent', true, 'leads', v_lead_count, 'messages', cardinality(v_parts));
end;
$$;

revoke all on function public.dv_send_assignment_brief(uuid[], uuid, boolean, boolean) from public, anon;
grant execute on function public.dv_send_assignment_brief(uuid[], uuid, boolean, boolean) to authenticated;
