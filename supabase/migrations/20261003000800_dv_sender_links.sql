-- Digital Volunteer: remember who a WhatsApp sender is.
--
-- WhatsApp often shows a sender only by a hidden account id ("...@lid") and never
-- reveals their phone number, so a volunteer can't be matched by phone. When an
-- operator confirms who such a sender is (Seva requests > Confirm identity),
-- the link is remembered, and that sender is recognised automatically from then on.
-- Links are created only by people with the "assign seva" permission, are listed
-- on the Seva requests page, and can be removed there at any time. A link to an
-- inactive volunteer is ignored.

create table public.dv_sender_links (
  sender_jid text primary key,
  profile_id uuid not null references public.profiles (id),
  linked_by  uuid references public.profiles (id),
  linked_at  timestamptz not null default now()
);

-- Requests also remember the sender id, so repeated asks from the same hidden-number
-- sender don't pile up as separate requests.
alter table public.dv_seva_requests add column sender_jid text;
update public.dv_seva_requests r set sender_jid = m.sender_jid
  from public.wa_messages m where m.id = r.message_id;
drop index public.dv_seva_one_open_per_sender;
create unique index dv_seva_one_open_per_sender on public.dv_seva_requests
  ((coalesce(requester_profile_id::text, sender_phone::text, sender_jid))) where status = 'pending';

-- Message ingest: after the phone match, fall back to a remembered link.
create or replace function public.dv_ingest_message(
  p_chat_jid text, p_provider_message_id text, p_direction text, p_sender_jid text,
  p_sender_phone text, p_sender_name text, p_body text, p_media_type text, p_sent_at timestamptz,
  p_outbox_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_group_id uuid;
  v_phone text := case when p_sender_phone ~ '^\+[1-9][0-9]{6,14}$' then p_sender_phone end;
  v_profile uuid;
  v_lead uuid;
begin
  if p_chat_jid like '%@g.us' then
    select id into v_group_id from public.wa_groups where jid = p_chat_jid;
    update public.wa_groups set last_activity_at = greatest(coalesce(last_activity_at, p_sent_at), p_sent_at)
     where id = v_group_id;
  end if;

  if p_direction = 'in' then
    if v_phone is not null then
      select id into v_profile from public.profiles where phone = v_phone and status = 'active' limit 1;
      -- A lead is linked only from a direct chat, and only when exactly one live lead has the number.
      if p_chat_jid not like '%@g.us' then
        select case when count(*) = 1 then min(id::text)::uuid end into v_lead
          from public.leads
         where (phone = v_phone or whatsapp_phone = v_phone) and archived_at is null and merged_into_id is null;
      end if;
    end if;
    if v_profile is null and p_sender_jid is not null then
      select p.id into v_profile
        from public.dv_sender_links l
        join public.profiles p on p.id = l.profile_id and p.status = 'active'
       where l.sender_jid = p_sender_jid;
    end if;
  end if;

  insert into public.wa_messages (chat_jid, provider_message_id, direction, group_id, sender_jid, sender_phone,
                                  sender_name, sender_profile_id, lead_id, body, media_type, sent_at, outbox_id,
                                  status)
  values (p_chat_jid, p_provider_message_id, p_direction, v_group_id, p_sender_jid, v_phone,
          left(p_sender_name, 200), v_profile, v_lead, left(p_body, 8000), p_media_type, p_sent_at, p_outbox_id,
          case when p_direction = 'out' then 'processed' else 'received' end)
  on conflict (chat_jid, provider_message_id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Opening a request now stores the sender id.
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

  begin
    insert into public.dv_seva_requests (message_id, group_id, chat_jid, sender_jid, sender_phone, sender_name,
                                         request_text, requested_count, requester_profile_id)
    values (m.id, m.group_id, m.chat_jid, m.sender_jid, m.sender_phone, m.sender_name, left(m.body, 500),
            p_requested, p.id)
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

-- Confirming identity also remembers the sender.
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
    raise exception 'That volunteer already has a request waiting' using errcode = '55000';
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

create function public.dv_seva_unlink_sender(p_sender_jid text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('assign_seva') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  delete from public.dv_sender_links where sender_jid = p_sender_jid;
  perform private.audit('dv.sender_unlinked', 'dv_sender_link', null, jsonb_build_object('sender', p_sender_jid));
end;
$$;

revoke all on public.dv_sender_links from anon, authenticated;
grant select on public.dv_sender_links to authenticated;
alter table public.dv_sender_links enable row level security;
create policy dv_sender_links_select on public.dv_sender_links for select to authenticated
  using (private.dv_can('assign_seva'));

revoke all on function public.dv_seva_unlink_sender(text) from public, anon;
grant execute on function public.dv_seva_unlink_sender(text) to authenticated;
