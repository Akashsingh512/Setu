-- Digital Volunteer: whoever asks for leads on WhatsApp always gets an answer there.
--
-- Until now only a fulfilled request was answered on WhatsApp; everything else
-- was an in-app notification the person might never see. Now:
--   * waiting for approval  -> "received, a coordinator will approve it shortly"
--   * no free leads         -> "all leads are assigned right now, ask again later"
--                              (and the team's staff are told in Setu)
--   * declined / limits     -> "could not be fulfilled: <reason>"
-- Where: in a private chat, back to that chat. For a group request, privately to
-- the volunteer's own number when Setu knows it (a reason can be personal);
-- otherwise in the group, without the reason. One message per outcome.

create function private.dv_seva_tell_requester(r public.dv_seva_requests, p_kind text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  v_first text;
  v_chat text;
  v_private boolean;
  v_body text;
begin
  if not coalesce((select enabled from public.wa_account where id), false) then
    return;
  end if;
  select * into p from public.profiles where id = r.requester_profile_id;
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
    when 'no_leads' then format(E'Jai Gurudev 🙏%s\n\nAll leads are already assigned right now, so there are none to give you. Please ask again later. The coordinators have been told.', v_first)
    when 'rejected' then format(E'Jai Gurudev 🙏%s\n\nYour request for leads could not be fulfilled this time.%s', v_first,
                                case when v_private and nullif(btrim(r.reason), '') is not null then E'\nReason: ' || r.reason else '' end)
  end;
  if v_body is null then
    return;
  end if;

  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (v_chat, case when v_private and r.chat_jid like '%@g.us' then 'direct' else 'reply' end, v_body,
          case when v_chat = r.chat_jid then r.message_id end, 'queued', true, 'seva-' || p_kind || ':' || r.id)
  on conflict (idempotency_key) do nothing;
end;
$$;

-- No leads / declined: answer the person; for "no leads", also tell the team's staff.
create function private.dv_seva_after_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
  v_admin uuid;
  v_note text;
begin
  perform private.dv_seva_tell_requester(new, new.status);
  if new.status = 'no_leads' then
    select team_id into v_team from public.profiles where id = new.requester_profile_id;
    select responsible_admin_id into v_admin from public.wa_groups where id = new.group_id;
    v_note := format('%s asked for leads on WhatsApp, but every lead is already assigned. Add or free up leads for the team.',
                     coalesce((select nullif(btrim(full_name), '') from public.profiles where id = new.requester_profile_id), 'A volunteer'));
    if v_admin is not null then
      perform private.notify(v_admin, 'seva_no_leads', 'No free leads for a seva request', v_note, jsonb_build_object('request_id', new.id));
    elsif v_team is not null then
      perform private.notify_team_staff(v_team, 'seva_no_leads', 'No free leads for a seva request', v_note, jsonb_build_object('request_id', new.id));
    end if;
  end if;
  return null;
end;
$$;

create trigger dv_seva_requests_decided
  after update of status on public.dv_seva_requests
  for each row when (old.status = 'pending' and new.status in ('no_leads', 'rejected'))
  execute function private.dv_seva_after_decision();

-- Waiting for approval: checked at the end of the transaction, because an
-- automatic request is fulfilled (or declined) right after it is created.
create function private.dv_seva_ack_pending() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r public.dv_seva_requests;
begin
  select * into r from public.dv_seva_requests where id = new.id;
  if r.status = 'pending' then
    perform private.dv_seva_tell_requester(r, 'pending');
  end if;
  return null;
end;
$$;

create constraint trigger dv_seva_requests_ack
  after insert on public.dv_seva_requests
  deferrable initially deferred
  for each row execute function private.dv_seva_ack_pending();

revoke all on function private.dv_seva_tell_requester(public.dv_seva_requests, text), private.dv_seva_after_decision(),
                       private.dv_seva_ack_pending() from public;
