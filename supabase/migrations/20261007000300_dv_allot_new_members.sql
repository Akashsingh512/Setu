-- Lead allotters can add the person on the spot.
--
-- "Allot 10 leads to Akash" when Setu has no Akash: the bot asks the allotter for
-- Akash's WhatsApp number; "Allot 10 leads to 98450 12345" for an unknown number:
-- it asks for the name. With both, the gateway creates a volunteer account (in the
-- allotter's team, signing in with their mobile number, password = first name +
-- "jaigurudev", to be changed at first sign-in), then the leads are allotted and the
-- new volunteer gets the leads and their sign-in details on WhatsApp.
-- Names now match strictly (full name, or a first name only one person has), so
-- "akash" never lands on "Aakash" by accident.

alter table public.profiles add column must_change_password boolean not null default false;

-- The signed-in person has set their own password.
create function public.clear_must_change_password()
returns void
language sql security definer set search_path = '' as $$
  update public.profiles set must_change_password = false where id = auth.uid();
$$;
revoke all on function public.clear_must_change_password() from public, anon;
grant execute on function public.clear_must_change_password() to authenticated;

-- One open question per allotter ("What is Akash's number?"), for 30 minutes.
create table public.dv_allot_pending (
  allotter_id  uuid primary key references public.profiles (id),
  chat_jid     text not null,
  target_name  text,
  target_phone text check (target_phone ~ '^\+[1-9][0-9]{6,14}$'),
  count        integer,
  need         text not null check (need in ('phone', 'name', 'create')),
  team_id      uuid references public.teams (id),
  created_at   timestamptz not null default now()
);
revoke all on public.dv_allot_pending from anon, authenticated;
alter table public.dv_allot_pending enable row level security;

-- The allotting itself, shared by all paths. Returns the reply for the allotter.
create function private.dv_allot_to(p_allotter public.profiles, t public.profiles, p_count integer, p_message_id uuid, p_login text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_cap integer;
  v_open integer;
  v_lead record;
  v_ids uuid[] := '{}';
  v_lines text := '';
  v_codes text[] := '{}';
  v_hours integer;
  v_from text := coalesce(nullif(btrim(p_allotter.full_name), ''), 'A coordinator');
  v_to_first text := split_part(coalesce(nullif(btrim(t.full_name), ''), 'friend'), ' ', 1);
  v_body text;
begin
  if t.team_id is null then
    return format('%s is not in a team yet, so no leads can be allotted to them.', t.full_name);
  elsif t.phone is null then
    return format('%s has no phone number in Setu, so the leads cannot be sent to them.', t.full_name);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('dv_seva:' || t.id::text, 0));
  v_count := least(greatest(coalesce(p_count, (select default_per_request from public.dv_seva_settings where id)), 1), 50);
  v_cap := coalesce(t.max_open_leads, (select default_max_open_leads from public.org_settings where id));
  select count(*) into v_open from public.lead_assignments where assignee_id = t.id and ended_at is null;
  if v_cap is not null then
    v_count := least(v_count, greatest(v_cap - v_open, 0));
  end if;
  select contact_deadline_hours into v_hours from public.org_settings where id;

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
      perform private.reassign_lead(v_lead.id, t.id, 'manual', p_allotter.id, null, 'Allotted on WhatsApp by ' || v_from);
      v_ids := v_ids || v_lead.id;
      v_codes := v_codes || v_lead.lead_code;
      v_lines := v_lines || format(E'• %s – %s%s (%s)\n', v_lead.full_name, v_lead.phone,
        case when v_lead.course_name is not null then ' · ' || v_lead.course_name else '' end, v_lead.lead_code);
    end loop;
  end if;

  -- A new member hears about their account even when no lead was free.
  if cardinality(v_ids) = 0 and p_login is null then
    return case
      when v_cap is not null and v_open >= v_cap then format('%s already holds %s open lead(s), their limit. Nothing was allotted.', t.full_name, v_open)
      else format('There are no free leads in %s''s team right now. Nothing was allotted.', t.full_name) end;
  end if;

  v_body := format(E'Jai Gurudev 🙏 %s\n\n', v_to_first);
  if p_login is not null then
    v_body := v_body || format(E'%s has added you to Setu, our seva app.\n%s\n\n', v_from, p_login);
  end if;
  if cardinality(v_ids) > 0 then
    v_body := v_body || format(E'%s has allotted you %s lead(s):\n\n%s\nPlease call within %s hours. After each call, reply here with the lead code or name and how it went, e.g. "%s called, coming on Sunday". It is saved on the lead''s follow-up in Setu.\n\n',
      v_from, cardinality(v_ids), v_lines, v_hours, v_codes[1]);
  end if;
  v_body := v_body || 'Thank you for your seva 🙏';
  insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key, created_by, approved_by)
  values (regexp_replace(t.phone, '\D', '', 'g') || '@s.whatsapp.net', 'seva_numbers', v_body,
          'queued', true, 'allot:' || p_message_id, p_allotter.id, p_allotter.id)
  on conflict (idempotency_key) do nothing;

  if cardinality(v_ids) > 0 then
    perform private.notify(t.id, 'lead_assigned',
      case when cardinality(v_ids) = 1 then 'New lead assigned' else 'New leads assigned' end,
      format('%s lead(s) allotted to you. Please call within %s hours.', cardinality(v_ids), v_hours),
      jsonb_build_object('lead_ids', to_jsonb(v_ids), 'source', 'whatsapp_allot'));
    perform private.audit('dv.leads_allotted', 'profile', t.id,
      jsonb_build_object('allotter', p_allotter.id, 'lead_ids', to_jsonb(v_ids), 'asked', p_count), p_allotter.id);
  end if;
  return case
    when cardinality(v_ids) = 0 then format('%s was added to Setu and got their sign-in details, but there are no free leads in their team right now.', t.full_name)
    else format(E'✅ %s lead(s) allotted to %s and sent to them privately:\n%s%s', cardinality(v_ids), t.full_name, array_to_string(v_codes, ', '),
                case when cardinality(v_ids) < coalesce(p_count, cardinality(v_ids)) then E'\n(Fewer than asked: that is all that was free or allowed.)' else '' end)
  end;
end;
$$;

create function private.dv_allot_reply(m public.wa_messages, p_body text, p_key text)
returns void
language sql security definer set search_path = '' as $$
  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', p_body, m.id, 'queued', true, p_key || ':' || m.id)
  on conflict (idempotency_key) do nothing;
$$;

-- The message is from an active allotter, in a private chat, not handled yet.
create function private.dv_allotter_of(m public.wa_messages)
returns public.profiles
language sql stable security definer set search_path = '' as $$
  select p.* from public.profiles p
    join public.dv_lead_allotters a on a.profile_id = p.id
   where p.id = m.sender_profile_id and p.status = 'active'
     and m.chat_jid not like '%@g.us' and m.intent is null and m.direction = 'in'
     and coalesce((select enabled from public.wa_account where id), false);
$$;

-- "98450 12345" / "+91 98450 12345" / "919845012345" -> +919845012345 (Indian numbers by default).
create function private.dv_phone_from_text(p_text text)
returns text
language sql immutable as $$
  select case
    when d is null then null
    when length(d) = 10 then '+91' || d
    when length(d) = 11 and d like '0%' then '+91' || substr(d, 2)
    when length(d) between 11 and 15 then '+' || d
  end
  from (select nullif(regexp_replace(coalesce(p_text, ''), '\D', '', 'g'), '') as d) x;
$$;

-- Strict matching: a phone number, the full name, or a first name only one person has.
create or replace function public.dv_allot_by_whatsapp(p_message_id uuid, p_count integer, p_target text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  v_allotter public.profiles;
  t public.profiles;
  v_target text := left(btrim(coalesce(p_target, '')), 80);
  v_phone text;
  v_matches uuid[];
  v_reply text;
  v_assigned integer;
begin
  select * into m from public.wa_messages where id = p_message_id;
  if m.id is null then
    return jsonb_build_object('handled', false);
  end if;
  v_allotter := private.dv_allotter_of(m);
  if v_allotter.id is null then
    return jsonb_build_object('handled', false);   -- not an allotter: an ordinary message
  end if;
  update public.wa_messages set intent = 'allot_command', intent_source = 'keywords', status = 'processed', processed_at = now() where id = m.id;
  delete from public.dv_allot_pending where allotter_id = v_allotter.id;   -- a new command replaces an old question

  if length(regexp_replace(v_target, '\D', '', 'g')) >= 10 then
    v_phone := private.dv_phone_from_text(v_target);
    select array_agg(id) into v_matches from public.profiles
     where status = 'active' and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(v_target, '\D', '', 'g'), 10);
  else
    select array_agg(id) into v_matches from public.profiles where status = 'active' and lower(btrim(full_name)) = lower(v_target);
    if v_matches is null and v_target !~ '\s' then
      select array_agg(id) into v_matches from public.profiles
       where status = 'active' and lower(split_part(btrim(full_name), ' ', 1)) = lower(v_target);
    end if;
  end if;

  if v_matches is null then
    -- Not in Setu: ask for what is missing, then add them.
    if v_phone is not null then
      insert into public.dv_allot_pending (allotter_id, chat_jid, target_phone, count, need) values (v_allotter.id, m.chat_jid, v_phone, p_count, 'name');
      v_reply := format(E'%s is not in Setu yet. What is their name? I will add them as a volunteer and send them the leads.\n(Reply CANCEL to stop.)', v_phone);
    elsif v_target ~ '[[:alpha:]]' and v_phone is null then
      insert into public.dv_allot_pending (allotter_id, chat_jid, target_name, count, need) values (v_allotter.id, m.chat_jid, initcap(v_target), p_count, 'phone');
      v_reply := format(E'%s is not in Setu yet. What is %s''s WhatsApp number? I will add them as a volunteer and send them the leads.\n(Reply CANCEL to stop.)',
                        initcap(v_target), split_part(initcap(v_target), ' ', 1));
    else
      v_reply := 'Please send a name or a WhatsApp number, e.g. "Allot 5 leads to Srikesh".';
    end if;
  elsif cardinality(v_matches) > 1 then
    select string_agg(format('• %s', full_name), E'\n' order by full_name) into v_reply from public.profiles where id = any (v_matches);
    v_reply := format(E'More than one person is called "%s":\n%s\n\nPlease send their full name or phone number.', v_target, v_reply);
  else
    select * into t from public.profiles where id = v_matches[1];
    v_reply := private.dv_allot_to(v_allotter, t, p_count, m.id);
    v_assigned := (select count(*) from public.lead_assignments where assigned_by = v_allotter.id and assignee_id = t.id and assigned_at >= now());
  end if;

  perform private.dv_allot_reply(m, v_reply, 'allot-reply');
  return jsonb_strip_nulls(jsonb_build_object('handled', true, 'assigned', v_assigned, 'reply', v_reply));
end;
$$;

-- The allotter's answer to "What is their name / number?".
-- Returns {handled, create: {...}} when the gateway should create the account.
create function public.dv_allot_continue(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  v_allotter public.profiles;
  pd public.dv_allot_pending;
  v_text text;
  v_phone text;
  t public.profiles;
  v_team uuid;
  v_reply text;
begin
  select * into m from public.wa_messages where id = p_message_id;
  if m.id is null then
    return jsonb_build_object('handled', false);
  end if;
  v_allotter := private.dv_allotter_of(m);
  if v_allotter.id is null then
    return jsonb_build_object('handled', false);
  end if;
  select * into pd from public.dv_allot_pending
   where allotter_id = v_allotter.id and need in ('phone', 'name') and created_at > now() - interval '30 minutes' for update;
  if pd.allotter_id is null then
    return jsonb_build_object('handled', false);
  end if;
  v_text := btrim(coalesce(m.body, ''));
  update public.wa_messages set intent = 'allot_command', intent_source = 'keywords', status = 'processed', processed_at = now() where id = m.id;

  if v_text ~* '^(cancel|stop|no|leave it)[.!]*$' then
    delete from public.dv_allot_pending where allotter_id = v_allotter.id;
    perform private.dv_allot_reply(m, 'Okay, cancelled. Nothing was allotted.', 'allot-reply');
    return jsonb_build_object('handled', true);
  end if;

  if pd.need = 'phone' then
    v_phone := private.dv_phone_from_text(v_text);
    if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
      perform private.dv_allot_reply(m, format('Please send %s''s WhatsApp number, e.g. 98450 12345. (Or CANCEL.)', pd.target_name), 'allot-reply');
      return jsonb_build_object('handled', true);
    end if;
    pd.target_phone := v_phone;
  else
    if v_text !~ '[[:alpha:]]' or length(v_text) < 2 or length(v_text) > 80 or length(regexp_replace(v_text, '\D', '', 'g')) >= 6 then
      perform private.dv_allot_reply(m, format('Please send the name of %s, e.g. Akash Sharma. (Or CANCEL.)', pd.target_phone), 'allot-reply');
      return jsonb_build_object('handled', true);
    end if;
    pd.target_name := initcap(regexp_replace(v_text, '\s+', ' ', 'g'));
  end if;

  -- The number may belong to someone after all: allot to them.
  select * into t from public.profiles
   where status = 'active' and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(pd.target_phone, '\D', '', 'g'), 10)
   limit 1;
  if t.id is not null then
    delete from public.dv_allot_pending where allotter_id = v_allotter.id;
    v_reply := format(E'%s is already in Setu as %s.\n', pd.target_phone, t.full_name) || private.dv_allot_to(v_allotter, t, pd.count, m.id);
    perform private.dv_allot_reply(m, v_reply, 'allot-reply');
    return jsonb_build_object('handled', true);
  end if;

  -- Their team: the allotter's, else the team with the most free leads.
  v_team := coalesce(v_allotter.team_id, (
    select le.team_id from public.leads le
     where le.assigned_to is null and le.archived_at is null and le.merged_into_id is null and le.team_id is not null
     group by le.team_id order by count(*) desc limit 1),
    (select id from public.teams where is_active order by created_at limit 1));
  if v_team is null then
    delete from public.dv_allot_pending where allotter_id = v_allotter.id;
    perform private.dv_allot_reply(m, 'There is no team in Setu to add them to. Create a team first.', 'allot-reply');
    return jsonb_build_object('handled', true);
  end if;
  update public.dv_allot_pending
     set target_name = pd.target_name, target_phone = pd.target_phone, need = 'create', team_id = v_team, created_at = now()
   where allotter_id = v_allotter.id;
  return jsonb_build_object('handled', true, 'create', jsonb_build_object(
    'name', pd.target_name, 'phone', pd.target_phone, 'team_id', v_team));
end;
$$;

-- The gateway created the account: finish (or report why it could not).
create function public.dv_allot_created(p_message_id uuid, p_profile_id uuid, p_password text, p_error text default null, p_app_url text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  pd public.dv_allot_pending;
  v_allotter public.profiles;
  t public.profiles;
  v_reply text;
begin
  select * into m from public.wa_messages where id = p_message_id;
  select * into pd from public.dv_allot_pending a
   where a.need = 'create' and a.allotter_id = m.sender_profile_id for update;
  if m.id is null or pd.allotter_id is null then
    return jsonb_build_object('handled', false);
  end if;
  select * into v_allotter from public.profiles where id = pd.allotter_id;
  delete from public.dv_allot_pending where allotter_id = pd.allotter_id;

  if p_profile_id is null then
    perform private.dv_allot_reply(m, format('Could not add %s to Setu: %s. Add them on the Volunteers page, then allot again.', pd.target_name, coalesce(p_error, 'unknown error')), 'allot-reply');
    return jsonb_build_object('handled', true);
  end if;
  update public.profiles set must_change_password = true, full_name = pd.target_name, phone = pd.target_phone, team_id = pd.team_id
   where id = p_profile_id
  returning * into t;
  perform private.audit('dv.member_added_by_allotter', 'profile', t.id,
    jsonb_build_object('allotter', v_allotter.id, 'team_id', pd.team_id), v_allotter.id);
  v_reply := format(E'Added %s (%s) to Setu as a volunteer in %s. Their sign-in details were sent to them.\n',
                    t.full_name, t.phone, (select name from public.teams where id = t.team_id))
             || private.dv_allot_to(v_allotter, t, pd.count, m.id,
                  format(E'Sign in at %s\nMobile: %s\nPassword: %s\nYou will be asked to choose your own password the first time.',
                         coalesce(nullif(btrim(p_app_url), ''), 'the Setu app'), t.phone, p_password));
  perform private.dv_allot_reply(m, v_reply, 'allot-reply');
  return jsonb_build_object('handled', true, 'reply', v_reply);
end;
$$;

revoke all on function private.dv_allot_to(public.profiles, public.profiles, integer, uuid, text), private.dv_allot_reply(public.wa_messages, text, text),
                       private.dv_allotter_of(public.wa_messages), private.dv_phone_from_text(text) from public;
revoke all on function public.dv_allot_continue(uuid), public.dv_allot_created(uuid, uuid, text, text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_allot_continue(uuid), public.dv_allot_created(uuid, uuid, text, text, text) to service_role;
  end if;
end;
$$;
