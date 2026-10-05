-- Digital Volunteer: lead allotters.
--
-- The super admin chooses people (with a phone number in Setu) who may allot leads
-- by WhatsApp. When one of them writes privately to the Setu number
--     "Allot 5 leads to Srikesh"      (a name, or a phone number)
-- the bot assigns that many free leads of Srikesh's team to Srikesh, sends the
-- leads to Srikesh's own WhatsApp ("Aakash has allotted you 5 leads: ..."), and
-- confirms to the allotter. Srikesh then replies with the lead code or name and a
-- comment, which is saved on the lead's follow-up (dv_volunteer_lead_note).
-- The person's workload cap still applies; leads they lost by missing the contact
-- deadline are not given back to them.

create table public.dv_lead_allotters (
  profile_id uuid primary key references public.profiles (id),
  added_by   uuid references public.profiles (id),
  added_at   timestamptz not null default now()
);
revoke all on public.dv_lead_allotters from anon, authenticated;
grant select on public.dv_lead_allotters to authenticated;
alter table public.dv_lead_allotters enable row level security;
create policy dv_lead_allotters_select on public.dv_lead_allotters for select to authenticated using (private.dv_is_operator());

create function public.dv_allotter_candidates()
returns table (id uuid, full_name text, role public.app_role, has_phone boolean, is_allotter boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_super_admin() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'User'), p.role, p.phone is not null,
           exists (select 1 from public.dv_lead_allotters a where a.profile_id = p.id)
      from public.profiles p
     where p.status = 'active'
     order by 5 desc, 2;
end;
$$;

create function public.dv_set_lead_allotter(p_profile_id uuid, p_enabled boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_super_admin() then
    raise exception 'Only super admins choose who can allot leads' using errcode = '42501';
  end if;
  if p_enabled then
    if not exists (select 1 from public.profiles where id = p_profile_id and status = 'active' and phone is not null) then
      raise exception 'Save a phone number on this person''s profile first' using errcode = '22023';
    end if;
    insert into public.dv_lead_allotters (profile_id, added_by) values (p_profile_id, auth.uid())
    on conflict (profile_id) do nothing;
  else
    delete from public.dv_lead_allotters where profile_id = p_profile_id;
  end if;
  perform private.audit('dv.lead_allotter_changed', 'profile', p_profile_id, jsonb_build_object('enabled', p_enabled));
end;
$$;

-- Called by the gateway for a private message that reads like "allot N leads to <who>".
create function public.dv_allot_by_whatsapp(p_message_id uuid, p_count integer, p_target text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  v_allotter public.profiles;
  t public.profiles;
  v_target text := btrim(coalesce(p_target, ''));
  v_digits text := regexp_replace(coalesce(p_target, ''), '\D', '', 'g');
  v_matches uuid[];
  v_count integer;
  v_cap integer;
  v_open integer;
  v_lead record;
  v_ids uuid[] := '{}';
  v_lines text := '';
  v_codes text[] := '{}';
  v_hours integer;
  v_reply text;
  v_from text;
  v_to_first text;
begin
  select * into m from public.wa_messages where id = p_message_id and direction = 'in';
  if m.id is null or m.chat_jid like '%@g.us' or m.intent is not null or m.sender_profile_id is null then
    return jsonb_build_object('handled', false);
  end if;
  select p.* into v_allotter from public.profiles p
    join public.dv_lead_allotters a on a.profile_id = p.id
   where p.id = m.sender_profile_id and p.status = 'active';
  if v_allotter.id is null or not coalesce((select enabled from public.wa_account where id), false) then
    return jsonb_build_object('handled', false);   -- not an allotter: an ordinary message
  end if;

  update public.wa_messages set intent = 'allot_command', intent_source = 'keywords', status = 'processed', processed_at = now()
   where id = m.id;

  -- Who: a phone number (last 10 digits), else a name among active members.
  if length(v_digits) >= 10 then
    select array_agg(id) into v_matches from public.profiles
     where status = 'active' and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10);
  else
    select array_agg(id) into v_matches from public.profiles where status = 'active' and lower(btrim(full_name)) = lower(v_target);
    if v_matches is null then
      select array_agg(id) into v_matches from public.profiles
       where status = 'active' and length(v_target) >= 3
         and (full_name ilike '%' || v_target || '%' or lower(split_part(btrim(full_name), ' ', 1)) = lower(v_target));
    end if;
  end if;

  if v_matches is null then
    v_reply := format('Nobody called "%s" was found in Setu. Use their name as it is in Setu, or their phone number.', left(v_target, 60));
  elsif cardinality(v_matches) > 1 then
    select string_agg(format('• %s', full_name), E'\n' order by full_name) into v_reply from public.profiles where id = any (v_matches);
    v_reply := format(E'More than one person matches "%s":\n%s\n\nPlease send their full name or phone number.', left(v_target, 60), v_reply);
  else
    select * into t from public.profiles where id = v_matches[1];
    if t.team_id is null then
      v_reply := format('%s is not in a team yet, so no leads can be allotted to them.', t.full_name);
    elsif t.phone is null then
      v_reply := format('%s has no phone number in Setu, so the leads cannot be sent to them.', t.full_name);
    end if;
  end if;

  if v_reply is null then
    perform pg_advisory_xact_lock(hashtextextended('dv_seva:' || t.id::text, 0));
    v_count := least(greatest(coalesce(p_count, (select default_per_request from public.dv_seva_settings where id)), 1), 50);
    v_cap := coalesce(t.max_open_leads, (select default_max_open_leads from public.org_settings where id));
    select count(*) into v_open from public.lead_assignments where assignee_id = t.id and ended_at is null;
    if v_cap is not null then
      v_count := least(v_count, greatest(v_cap - v_open, 0));
    end if;
    select contact_deadline_hours into v_hours from public.org_settings where id;
    v_from := coalesce(nullif(btrim(v_allotter.full_name), ''), 'A coordinator');
    v_to_first := split_part(coalesce(nullif(btrim(t.full_name), ''), 'friend'), ' ', 1);

    if v_count > 0 then
      for v_lead in
        select le.id, le.lead_code, le.full_name, le.phone, c.name as course_name
          from public.leads le
          join public.lead_statuses st on st.code = le.status
          left join public.courses c on c.id = le.course_id
         where le.team_id = t.team_id and le.assigned_to is null and le.current_assignment_id is null
           and le.archived_at is null and le.merged_into_id is null and not st.is_closed
           and not exists (select 1 from public.lead_assignments a
                            where a.lead_id = le.id and a.assignee_id = t.id
                              and a.end_reason in ('reassigned_auto', 'auto_no_candidate'))
         order by le.needs_attention desc, le.created_at
         limit v_count
           for update of le skip locked
      loop
        perform private.reassign_lead(v_lead.id, t.id, 'manual', v_allotter.id, null, 'Allotted on WhatsApp by ' || v_from);
        v_ids := v_ids || v_lead.id;
        v_codes := v_codes || v_lead.lead_code;
        v_lines := v_lines || format(E'• %s – %s%s (%s)\n', v_lead.full_name, v_lead.phone,
          case when v_lead.course_name is not null then ' · ' || v_lead.course_name else '' end, v_lead.lead_code);
      end loop;
    end if;

    if cardinality(v_ids) = 0 then
      v_reply := case
        when v_cap is not null and v_open >= v_cap then format('%s already holds %s open lead(s), their limit. Nothing was allotted.', t.full_name, v_open)
        else format('There are no free leads in %s''s team right now. Nothing was allotted.', t.full_name) end;
    else
      insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key, created_by, approved_by)
      values (regexp_replace(t.phone, '\D', '', 'g') || '@s.whatsapp.net', 'seva_numbers',
        format(E'Jai Gurudev 🙏 %s\n\n%s has allotted you %s lead(s):\n\n%s\nPlease call within %s hours. After each call, reply here with the lead code or name and how it went, e.g. "%s called, coming on Sunday". It is saved on the lead''s follow-up in Setu.\n\nThank you for your seva 🙏',
               v_to_first, v_from, cardinality(v_ids), v_lines, v_hours, v_codes[1]),
        'queued', true, 'allot:' || m.id, v_allotter.id, v_allotter.id)
      on conflict (idempotency_key) do nothing;
      perform private.notify(t.id, 'lead_assigned',
        case when cardinality(v_ids) = 1 then 'New lead assigned' else 'New leads assigned' end,
        format('%s lead(s) allotted to you. Please call within %s hours.', cardinality(v_ids), v_hours),
        jsonb_build_object('lead_ids', to_jsonb(v_ids), 'source', 'whatsapp_allot'));
      v_reply := format(E'✅ %s lead(s) allotted to %s and sent to them privately:\n%s%s',
        cardinality(v_ids), t.full_name, array_to_string(v_codes, ', '),
        case when cardinality(v_ids) < coalesce(p_count, cardinality(v_ids)) then E'\n(Fewer than asked: that is all that was free or allowed.)' else '' end);
      perform private.audit('dv.leads_allotted', 'profile', t.id,
        jsonb_build_object('allotter', v_allotter.id, 'lead_ids', to_jsonb(v_ids), 'asked', p_count), v_allotter.id);
    end if;
  end if;

  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', v_reply, m.id, 'queued', true, 'allot-reply:' || m.id)
  on conflict (idempotency_key) do nothing;
  return jsonb_strip_nulls(jsonb_build_object('handled', true, 'assigned', cardinality(v_ids), 'reply', v_reply));
end;
$$;

revoke all on function public.dv_allotter_candidates(), public.dv_set_lead_allotter(uuid, boolean) from public, anon;
grant execute on function public.dv_allotter_candidates(), public.dv_set_lead_allotter(uuid, boolean) to authenticated;
revoke all on function public.dv_allot_by_whatsapp(uuid, integer, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_allot_by_whatsapp(uuid, integer, text) to service_role;
    grant select on public.dv_lead_allotters to service_role;
  end if;
end;
$$;
