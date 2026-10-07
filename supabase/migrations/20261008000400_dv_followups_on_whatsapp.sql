-- Follow-ups on WhatsApp.
--
--   * A volunteer writing about their lead with a time ("Vimala follow up tomorrow
--     5pm") gets a follow-up scheduled at that time (the gateway reads the time and
--     passes it in), plus the message as a comment on it.
--   * Before every follow-up (scheduled in Setu or on WhatsApp) the person who
--     scheduled it gets a WhatsApp reminder, N minutes ahead (default 2; 0 = off).
--     Set in Digital Volunteer > Seva & allotting.

alter table public.dv_seva_settings add column followup_wa_minutes integer not null default 2 check (followup_wa_minutes between 0 and 1440);
alter table public.follow_ups add column wa_reminder_sent_at timestamptz;

drop function public.dv_volunteer_lead_note(uuid);

create function public.dv_volunteer_lead_note(p_message_id uuid, p_follow_up_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  p public.profiles;
  v_text text;
  v_code text;
  v_ids uuid[];
  v_lead public.leads;
  v_reply text;
  v_names text;
  v_comment uuid;
  v_due timestamptz;
  v_tz text;
  v_new_fu uuid;
begin
  select * into m from public.wa_messages where id = p_message_id and direction = 'in';
  if m.id is null or m.chat_jid like '%@g.us' or m.intent is not null or m.sender_profile_id is null
     or not coalesce((select enabled from public.wa_account where id), false) then
    return jsonb_build_object('handled', false);
  end if;
  select * into p from public.profiles where id = m.sender_profile_id and status = 'active';
  v_text := btrim(coalesce(m.body, ''));
  if p.id is null or v_text = '' then
    return jsonb_build_object('handled', false);
  end if;
  select default_timezone into v_tz from public.org_settings where id;

  -- 1. A lead code.
  v_code := upper((regexp_match(v_text, '\m(L-?\d{3,})\M', 'i'))[1]);
  if v_code is not null then
    v_code := regexp_replace(v_code, '^L-?', 'L-');
    select array_agg(id) into v_ids from public.leads
     where lead_code = v_code and assigned_to = p.id and archived_at is null and merged_into_id is null;
    if v_ids is null then
      v_reply := format('%s is not one of your leads in Setu, so nothing was saved. Check the code in My Leads.', v_code);
    end if;
  end if;

  -- 2. A full name of two or more words (the longest one mentioned wins).
  if v_ids is null and v_reply is null then
    with named as (
      select id, length(btrim(full_name)) as len from public.leads
       where assigned_to = p.id and archived_at is null and merged_into_id is null
         and btrim(full_name) like '% %'
         and v_text ~* ('\m' || private.dv_regex_escape(btrim(full_name)) || '\M'))
    select array_agg(id) into v_ids from named where len = (select max(len) from named);
  end if;

  -- 3. A first name.
  if v_ids is null and v_reply is null then
    select array_agg(id) into v_ids from public.leads
     where assigned_to = p.id and archived_at is null and merged_into_id is null
       and length(split_part(btrim(full_name), ' ', 1)) >= 3
       and v_text ~* ('\m' || private.dv_regex_escape(split_part(btrim(full_name), ' ', 1)) || '\M');
  end if;

  if v_reply is null and v_ids is null then
    return jsonb_build_object('handled', false);   -- not about one of their leads
  end if;

  if v_reply is null and cardinality(v_ids) > 1 then
    select string_agg(format('• %s (%s)', full_name, lead_code), E'\n' order by lead_code) into v_names
      from public.leads where id = any (v_ids);
    v_reply := format(E'More than one of your leads matches:\n%s\n\nPlease start your message with the lead code, e.g. "%s called, will come on Sunday".',
                      v_names, (select min(lead_code) from public.leads where id = any (v_ids)));
  elsif v_reply is null then
    select * into v_lead from public.leads where id = v_ids[1];

    -- A time was asked for: schedule the follow-up first, so the comment goes on it.
    if p_follow_up_at is not null then
      if exists (select 1 from public.lead_statuses where code = v_lead.status and blocks_contact) then
        v_reply := format('%s (%s) is marked Do not contact, so no follow-up was scheduled.', v_lead.full_name, v_lead.lead_code);
      elsif p_follow_up_at < now() - interval '5 minutes' then
        v_reply := 'That time has already passed. Please send a time in the future, e.g. "follow up tomorrow 5pm".';
      else
        insert into public.follow_ups (lead_id, owner_id, due_at, note, created_by)
        values (v_lead.id, p.id, p_follow_up_at, left(v_text, 2000), p.id)
        returning id into v_new_fu;
        perform private.log_activity(v_lead.id, 'follow_up_scheduled',
          jsonb_build_object('follow_up_id', v_new_fu, 'due_at', p_follow_up_at, 'via', 'whatsapp'), p.id);
        insert into public.follow_up_comments (lead_id, follow_up_id, author_id, body, source)
        values (v_lead.id, v_new_fu, p.id, left(v_text, 2000), 'whatsapp')
        returning id into v_comment;
        perform private.log_activity(v_lead.id, 'follow_up_comment',
          jsonb_build_object('comment_id', v_comment, 'follow_up_id', v_new_fu, 'source', 'whatsapp', 'preview', left(v_text, 280)), p.id);
        v_reply := format(E'📅 Follow-up scheduled for %s (%s): %s.%s',
          v_lead.full_name, v_lead.lead_code, to_char(p_follow_up_at at time zone v_tz, 'Dy DD Mon, HH12:MI am'),
          case when coalesce((select followup_wa_minutes from public.dv_seva_settings where id), 0) > 0
               then format(' I will remind you %s minutes before.', (select followup_wa_minutes from public.dv_seva_settings where id)) else '' end);
      end if;
    end if;

    if v_reply is null then
      v_comment := private.add_follow_up_comment(v_lead, null, p.id, v_text, 'whatsapp');
      select f.due_at into v_due from public.follow_up_comments c join public.follow_ups f on f.id = c.follow_up_id where c.id = v_comment;
      v_reply := case when v_due is not null
        then format('✅ Comment added to the follow-up of %s (%s), due %s.', v_lead.full_name, v_lead.lead_code,
                    to_char(v_due at time zone v_tz, 'Dy DD Mon, HH12:MI am'))
        else format('✅ Comment added to %s (%s). There is no follow-up scheduled for this lead. To schedule one, write e.g. "%s follow up tomorrow 5pm".',
                    v_lead.full_name, v_lead.lead_code, split_part(v_lead.full_name, ' ', 1)) end;
    end if;
  end if;

  update public.wa_messages
     set intent = 'lead_note', intent_source = 'keywords', status = 'processed', processed_at = now()
   where id = m.id;
  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', v_reply, m.id, 'queued', true, 'lead-note:' || m.id)
  on conflict (idempotency_key) do nothing;
  return jsonb_strip_nulls(jsonb_build_object('handled', true, 'lead_id', v_lead.id, 'comment_id', v_comment, 'follow_up_id', v_new_fu, 'reply', v_reply));
end;
$$;

revoke all on function public.dv_volunteer_lead_note(uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- WhatsApp reminders just before a follow-up (every minute)
-- ---------------------------------------------------------------------------
create function public.dv_followup_whatsapp_reminders()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_minutes integer;
  v_tz text;
  r record;
  v_count integer := 0;
  v_last text;
begin
  select followup_wa_minutes into v_minutes from public.dv_seva_settings where id;
  if coalesce(v_minutes, 0) = 0 or not coalesce((select enabled from public.wa_account where id), false) then
    return 0;
  end if;
  select default_timezone into v_tz from public.org_settings where id;

  for r in
    select f.id, f.due_at, f.note, l.id as lead_id, l.full_name, l.lead_code, coalesce(l.whatsapp_phone, l.phone) as lead_phone,
           who.phone as to_phone, split_part(coalesce(nullif(btrim(who.full_name), ''), 'friend'), ' ', 1) as first_name
      from public.follow_ups f
      join public.leads l on l.id = f.lead_id and l.archived_at is null
      -- The person who scheduled it; else the one it belongs to.
      join public.profiles who on who.id = coalesce(
             (select c.id from public.profiles c where c.id = f.created_by and c.status = 'active' and c.phone is not null),
             f.owner_id)
     where f.status = 'open' and f.wa_reminder_sent_at is null
       and f.due_at <= now() + make_interval(mins => v_minutes)
       and f.due_at > now() - interval '10 minutes'   -- never remind about the far past
       and who.status = 'active' and who.phone is not null
     order by f.due_at
     limit 200
     for update of f skip locked
  loop
    select format('%s %s', to_char(x.at at time zone v_tz, 'DD Mon'), x.what) into v_last from (
      select ca.attempted_at as at, format('call (%s)', replace(ca.outcome::text, '_', ' ')) as what from public.call_attempts ca where ca.lead_id = r.lead_id
      union all
      select fc.created_at, 'comment: ' || left(btrim(fc.body), 80) from public.follow_up_comments fc where fc.lead_id = r.lead_id
    ) x order by x.at desc limit 1;

    insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key)
    values (regexp_replace(r.to_phone, '\D', '', 'g') || '@s.whatsapp.net', 'direct',
      format(E'⏰ %s, follow-up at %s\n\n%s – %s (%s)%s%s\n\nAfter the call, reply here with the code or name and how it went.',
             r.first_name, to_char(r.due_at at time zone v_tz, 'HH12:MI am'), r.full_name, r.lead_phone, r.lead_code,
             case when nullif(btrim(r.note), '') is not null then E'\nNote: ' || left(btrim(r.note), 200) else '' end,
             case when v_last is not null then E'\nLast: ' || v_last else '' end),
      'queued', true, 'fu-reminder:' || r.id)
    on conflict (idempotency_key) do nothing;
    update public.follow_ups set wa_reminder_sent_at = now() where id = r.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function public.dv_save_followup_reminder(p_minutes integer)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_minutes is null or p_minutes < 0 or p_minutes > 1440 then
    raise exception 'Choose between 0 and 1440 minutes' using errcode = '22023';
  end if;
  update public.dv_seva_settings set followup_wa_minutes = p_minutes, updated_at = now(), updated_by = auth.uid() where id;
  perform private.audit('dv.followup_reminder_setting', 'dv_seva_settings', null, jsonb_build_object('minutes', p_minutes));
end;
$$;

-- A follow-up moved to a new time gets a fresh reminder.
create function private.follow_ups_reset_wa_reminder() returns trigger
language plpgsql as $$
begin
  if new.due_at is distinct from old.due_at then
    new.wa_reminder_sent_at := null;
  end if;
  return new;
end;
$$;
create trigger follow_ups_reset_wa_reminder before update of due_at on public.follow_ups
  for each row execute function private.follow_ups_reset_wa_reminder();

revoke all on function public.dv_followup_whatsapp_reminders() from public, anon, authenticated;
revoke all on function public.dv_save_followup_reminder(integer) from public, anon;
grant execute on function public.dv_save_followup_reminder(integer) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_volunteer_lead_note(uuid, timestamptz), public.dv_followup_whatsapp_reminders() to service_role;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dv-followup-reminders', '* * * * *', 'select public.dv_followup_whatsapp_reminders()');
  end if;
end;
$$;
