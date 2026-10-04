-- Follow-up comments.
--
-- A follow-up now has a list of comments (who, when, from where). Volunteers add
-- them in Setu, or from WhatsApp by naming the lead (see dv_volunteer_notes):
-- a WhatsApp comment goes under the lead's next open follow-up, or, when the lead
-- has none, stays with the lead and shows in its Follow-ups card.
-- Replaces the earlier "WhatsApp comment = lead note" behaviour.

create table public.follow_up_comments (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads (id),
  follow_up_id uuid references public.follow_ups (id),
  author_id    uuid references public.profiles (id),
  body         text not null check (length(btrim(body)) between 1 and 2000),
  source       text not null default 'app' check (source in ('app', 'whatsapp')),
  created_at   timestamptz not null default now()
);
create index follow_up_comments_lead_idx on public.follow_up_comments (lead_id, created_at desc);

revoke all on public.follow_up_comments from anon, authenticated;
grant select on public.follow_up_comments to authenticated;
alter table public.follow_up_comments enable row level security;
create policy follow_up_comments_select on public.follow_up_comments for select to authenticated
  using (private.can_view_lead(lead_id));

-- Shared by the app and WhatsApp. p_follow_up_id null = the lead's next open follow-up, if any.
create function private.add_follow_up_comment(p_lead public.leads, p_follow_up_id uuid, p_author uuid, p_body text, p_source text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_fu uuid := p_follow_up_id;
  v_id uuid;
begin
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Write a comment' using errcode = '22023';
  end if;
  if v_fu is not null then
    if not exists (select 1 from public.follow_ups where id = v_fu and lead_id = p_lead.id) then
      raise exception 'Follow-up not found' using errcode = 'P0002';
    end if;
  else
    select id into v_fu from public.follow_ups where lead_id = p_lead.id and status = 'open' order by due_at limit 1;
  end if;
  insert into public.follow_up_comments (lead_id, follow_up_id, author_id, body, source)
  values (p_lead.id, v_fu, p_author, left(btrim(p_body), 2000), p_source)
  returning id into v_id;
  perform private.log_activity(p_lead.id, 'follow_up_comment',
    jsonb_build_object('comment_id', v_id, 'follow_up_id', v_fu, 'source', p_source, 'preview', left(btrim(p_body), 280)), p_author);
  return v_id;
end;
$$;

create function public.add_follow_up_comment(p_lead_id uuid, p_follow_up_id uuid, p_body text)
returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  return private.add_follow_up_comment(private.lock_lead_for_action(p_lead_id), p_follow_up_id, auth.uid(), p_body, 'app');
end;
$$;

-- WhatsApp: same matching as before (code, full name, first name among the sender's
-- own leads); the comment now goes to the follow-up instead of the notes.
create or replace function public.dv_volunteer_lead_note(p_message_id uuid)
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
    v_comment := private.add_follow_up_comment(v_lead, null, p.id, v_text, 'whatsapp');
    select f.due_at into v_due from public.follow_up_comments c join public.follow_ups f on f.id = c.follow_up_id where c.id = v_comment;
    select default_timezone into v_tz from public.org_settings where id;
    v_reply := case when v_due is not null
      then format('✅ Comment added to the follow-up of %s (%s), due %s.', v_lead.full_name, v_lead.lead_code,
                  to_char(v_due at time zone v_tz, 'Dy DD Mon, HH12:MI am'))
      else format('✅ Comment added to %s (%s). There is no follow-up scheduled for this lead.', v_lead.full_name, v_lead.lead_code) end;
  end if;

  update public.wa_messages
     set intent = 'lead_note', intent_source = 'keywords', status = 'processed', processed_at = now()
   where id = m.id;
  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', v_reply, m.id, 'queued', true, 'lead-note:' || m.id)
  on conflict (idempotency_key) do nothing;
  return jsonb_strip_nulls(jsonb_build_object('handled', true, 'lead_id', v_lead.id, 'comment_id', v_comment, 'reply', v_reply));
end;
$$;

revoke all on function private.add_follow_up_comment(public.leads, uuid, uuid, text, text) from public;
revoke all on function public.add_follow_up_comment(uuid, uuid, text) from public, anon;
grant execute on function public.add_follow_up_comment(uuid, uuid, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.follow_up_comments to service_role;
  end if;
end;
$$;
