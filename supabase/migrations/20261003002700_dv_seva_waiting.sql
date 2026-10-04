-- Seva requests that nobody handled:
--   * A request still waiting after 24 hours expires (status "cancelled", no
--     message) the next time the same person asks, so an old forgotten request
--     no longer blocks them for ever.
--   * Asking again while a request is waiting now gets an answer ("your request
--     from ... is still waiting") instead of silence.

drop function private.dv_seva_tell_requester(public.dv_seva_requests, text);

create function private.dv_seva_tell_requester(r public.dv_seva_requests, p_kind text, p_key text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  v_first text;
  v_chat text;
  v_private boolean;
  v_body text;
  v_tz text;
begin
  if not coalesce((select enabled from public.wa_account where id), false) then
    return;
  end if;
  select * into p from public.profiles where id = r.requester_profile_id;
  select default_timezone into v_tz from public.org_settings where id;
  v_first := split_part(coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(r.sender_name), ''), ''), ' ', 1);
  v_first := case when v_first = '' then '' else ' ' || v_first end;

  if r.chat_jid not like '%@g.us' then
    v_chat := r.chat_jid;
    v_private := true;
  elsif p.phone is not null then
    v_chat := replace(p.phone, '+', '') || '@s.whatsapp.net';
    v_private := true;
  else
    v_chat := r.chat_jid;
    v_private := false;
  end if;

  v_body := case p_kind
    when 'pending' then format(E'Jai Gurudev 🙏%s\n\nYour request for leads has been received. A coordinator will approve it shortly, and the leads will be sent to you.', v_first)
    when 'still_pending' then format(E'Jai Gurudev 🙏%s\n\nYour request for leads from %s is still waiting for a coordinator. You will get the leads as soon as it is approved, no need to ask again.',
                                     v_first, to_char(r.created_at at time zone v_tz, 'DD Mon, HH12:MI am'))
    when 'no_leads' then format(E'Jai Gurudev 🙏%s\n\nAll leads are already assigned right now, so there are none to give you. Please ask again later. The coordinators have been told.', v_first)
    when 'rejected' then format(E'Jai Gurudev 🙏%s\n\nYour request for leads could not be fulfilled this time.%s', v_first,
                                case when v_private and nullif(btrim(r.reason), '') is not null then E'\nReason: ' || r.reason else '' end)
  end;
  if v_body is null then
    return;
  end if;

  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (v_chat, case when v_private and r.chat_jid like '%@g.us' then 'direct' else 'reply' end, v_body,
          case when v_chat = r.chat_jid then r.message_id end, 'queued', true,
          'seva-' || p_kind || ':' || coalesce(p_key, r.id::text))
  on conflict (idempotency_key) do nothing;
end;
$$;

alter function private.dv_seva_open_request(uuid, integer) rename to dv_seva_open_request_core;

create function private.dv_seva_open_request(p_message_id uuid, p_requested integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  v_profile uuid;
  v_result jsonb;
  r public.dv_seva_requests;
begin
  select * into m from public.wa_messages where id = p_message_id;
  select id into v_profile from public.profiles
   where id = m.sender_profile_id and status = 'active' and team_id is not null;

  -- This person's forgotten requests (waiting over 24 hours) expire quietly.
  update public.dv_seva_requests q
     set status = 'cancelled', decided_at = now(), reason = 'Expired: not handled within 24 hours'
   where q.status = 'pending' and q.created_at < now() - interval '24 hours'
     and ((v_profile is not null and q.requester_profile_id = v_profile)
          or (m.sender_phone is not null and q.sender_phone = m.sender_phone)
          or (m.sender_jid is not null and q.sender_jid = m.sender_jid));

  v_result := private.dv_seva_open_request_core(p_message_id, p_requested);

  if (v_result ->> 'duplicate')::boolean is true then
    select * into r from public.dv_seva_requests q
     where q.status = 'pending'
       and ((v_profile is not null and q.requester_profile_id = v_profile)
            or (m.sender_phone is not null and q.sender_phone = m.sender_phone)
            or (m.sender_jid is not null and q.sender_jid = m.sender_jid))
     order by q.created_at desc limit 1;
    if r.id is not null then
      perform private.dv_seva_tell_requester(r, 'still_pending', m.id::text);
    end if;
  end if;
  return v_result;
end;
$$;

revoke all on function private.dv_seva_tell_requester(public.dv_seva_requests, text, text),
                       private.dv_seva_open_request(uuid, integer),
                       private.dv_seva_open_request_core(uuid, integer) from public;
