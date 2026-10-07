-- The messages sent with allotted leads can be edited (Digital Volunteer > Seva & allotting).
--
--   allot_message    to someone already in Setu
--   welcome_message  to someone an allotter just added (with their sign-in details)
-- Placeholders: {{name}} {{allotter}} {{count}} {{leads}} {{hours}} {{example_code}}
-- and, in the welcome message, {{app_url}} {{mobile}} {{password}}.
-- Empty = the built-in text. The welcome message must keep {{mobile}} and {{password}}
-- (otherwise the person cannot sign in) and both must keep {{leads}}.

alter table public.dv_seva_settings
  add column allot_message text check (length(allot_message) <= 3000),
  add column welcome_message text check (length(welcome_message) <= 3000);

create function public.dv_allot_default_message(p_kind text)
returns text
language sql immutable as $$
  select case p_kind
    when 'allot' then E'Jai Gurudev 🙏 {{name}}\n\n{{allotter}} has allotted you {{count}} lead(s):\n\n{{leads}}\nPlease call within {{hours}} hours. After each call, reply here with the lead code or name and how it went, e.g. "{{example_code}} called, coming on Sunday". It is saved on the lead''s follow-up in Setu.\n\nThank you for your seva 🙏'
    when 'welcome' then E'Jai Gurudev 🙏 {{name}}\n\n{{allotter}} has added you to Setu, our seva app.\nSign in at {{app_url}}\nMobile: {{mobile}}\nPassword: {{password}}\nYou will be asked to choose your own password the first time.\n\n{{allotter}} has allotted you {{count}} lead(s):\n\n{{leads}}\nPlease call within {{hours}} hours. After each call, reply here with the lead code or name and how it went, e.g. "{{example_code}} called, coming on Sunday".\n\nThank you for your seva 🙏'
  end
$$;
grant execute on function public.dv_allot_default_message(text) to authenticated;

create function public.dv_save_allot_messages(p_allot text, p_welcome text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_allot text := nullif(btrim(coalesce(p_allot, '')), '');
  v_welcome text := nullif(btrim(coalesce(p_welcome, '')), '');
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if v_allot is not null and position('{{leads}}' in v_allot) = 0 then
    raise exception 'The "leads allotted" message must contain {{leads}}' using errcode = '22023';
  end if;
  if v_welcome is not null and (position('{{leads}}' in v_welcome) = 0 or position('{{mobile}}' in v_welcome) = 0 or position('{{password}}' in v_welcome) = 0) then
    raise exception 'The welcome message must contain {{leads}}, {{mobile}} and {{password}}, or the person cannot sign in' using errcode = '22023';
  end if;
  update public.dv_seva_settings
     set allot_message = case when v_allot = public.dv_allot_default_message('allot') then null else v_allot end,
         welcome_message = case when v_welcome = public.dv_allot_default_message('welcome') then null else v_welcome end,
         updated_at = now(), updated_by = auth.uid()
   where id;
  perform private.audit('dv.allot_messages_saved', 'dv_seva_settings', null,
    jsonb_build_object('allot_custom', v_allot is not null, 'welcome_custom', v_welcome is not null));
end;
$$;
revoke all on function public.dv_save_allot_messages(text, text) from public, anon;
grant execute on function public.dv_save_allot_messages(text, text) to authenticated;

-- dv_allot_to: build the message from the template. p_login is now
-- {"app_url", "mobile", "password"} for someone just added (null otherwise).
drop function public.dv_allot_created(uuid, uuid, text, text, text);
drop function private.dv_allot_to(public.profiles, public.profiles, integer, uuid, text);

create function private.dv_allot_to(p_allotter public.profiles, t public.profiles, p_count integer, p_message_id uuid, p_login jsonb default null)
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

  select case when p_login is null then coalesce(s.allot_message, public.dv_allot_default_message('allot'))
              else coalesce(s.welcome_message, public.dv_allot_default_message('welcome')) end
    into v_body from public.dv_seva_settings s where s.id;
  v_body := replace(v_body, '{{name}}', v_to_first);
  v_body := replace(v_body, '{{allotter}}', v_from);
  v_body := replace(v_body, '{{count}}', cardinality(v_ids)::text);
  v_body := replace(v_body, '{{leads}}', case when cardinality(v_ids) > 0 then v_lines else E'(No free leads right now. You will get some soon.)\n' end);
  v_body := replace(v_body, '{{hours}}', coalesce(v_hours, 24)::text);
  v_body := replace(v_body, '{{example_code}}', coalesce(v_codes[1], 'L-000001'));
  v_body := replace(v_body, '{{app_url}}', coalesce(p_login ->> 'app_url', ''));
  v_body := replace(v_body, '{{mobile}}', coalesce(p_login ->> 'mobile', t.phone));
  v_body := replace(v_body, '{{password}}', coalesce(p_login ->> 'password', ''));

  insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key, created_by, approved_by)
  values (regexp_replace(t.phone, '\D', '', 'g') || '@s.whatsapp.net', 'seva_numbers', left(btrim(v_body), 4000),
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
                  jsonb_build_object('app_url', coalesce(nullif(btrim(p_app_url), ''), 'the Setu app'), 'mobile', t.phone, 'password', p_password));
  perform private.dv_allot_reply(m, v_reply, 'allot-reply');
  return jsonb_build_object('handled', true, 'reply', v_reply);
end;
$$;

revoke all on function private.dv_allot_to(public.profiles, public.profiles, integer, uuid, jsonb) from public;
revoke all on function public.dv_allot_created(uuid, uuid, text, text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_allot_created(uuid, uuid, text, text, text) to service_role;
  end if;
end;
$$;
