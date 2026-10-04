-- Digital Volunteer: volunteers add comments to their leads from WhatsApp.
--
-- A volunteer writes privately to the Setu number about one of the leads they
-- hold, naming it by code or by name:
--     "L-000002 called, coming on Sunday"
--     "Vinod Kumar called, coming on Sunday"   (full name)
--     "Vinod not answering, will try tomorrow" (first name, when only one lead has it)
-- The message is added as a note on that lead (by that volunteer) and they get a
-- confirmation. Only the leads the sender currently holds are considered, so a
-- name can never reach someone else's lead. Two leads with the same name: the
-- volunteer is asked to use the code. No lead named: an ordinary message.

create function private.dv_regex_escape(p text) returns text
language sql immutable as $$
  select regexp_replace(p, '([.*+?^${}()|\[\]\\])', '\\\1', 'g')
$$;

create function public.dv_volunteer_lead_note(p_message_id uuid)
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
         and btrim(full_name) like '% %'   -- one-word names are first names (step 3)
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
    insert into public.lead_notes (lead_id, author_id, body)
    values (v_lead.id, p.id, left('WhatsApp: ' || v_text, 4000));
    v_reply := format('✅ Note added to %s (%s).', v_lead.full_name, v_lead.lead_code);
  end if;

  update public.wa_messages
     set intent = 'lead_note', intent_source = 'keywords', status = 'processed', processed_at = now()
   where id = m.id;
  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', v_reply, m.id, 'queued', true, 'lead-note:' || m.id)
  on conflict (idempotency_key) do nothing;
  return jsonb_strip_nulls(jsonb_build_object('handled', true, 'lead_id', v_lead.id, 'reply', v_reply));
end;
$$;

revoke all on function private.dv_regex_escape(text) from public;
revoke all on function public.dv_volunteer_lead_note(uuid) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_volunteer_lead_note(uuid) to service_role;
  end if;
end;
$$;
