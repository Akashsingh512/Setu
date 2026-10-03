-- Seva requests: approve or decline from WhatsApp.
--
-- People chosen as "WhatsApp approvers" receive a private message for each seva
-- request that waits for a decision, with a short number (#12). They reply
-- "YES 12", "YES 12 3" (only 3 leads) or "NO 12 reason" privately to the
-- organisation number.
--
-- A WhatsApp reply is never more powerful than the person's Setu account:
--   * it must come privately (not from a group) from a designated approver,
--     recognised by their Setu phone number or a remembered sender link;
--   * at the moment of the reply they must still hold the "assign seva" permission
--     (super admins always do) and be active;
--   * nobody can decide their own request; a request already handled (in Setu or
--     by another approver) is not handled again;
--   * the decision runs through the same allocation as the Setu screen, so limits,
--     lead rules, history and the 24-hour rule are identical, and the approver is
--     recorded as the person who assigned the leads;
--   * anyone else sending "YES 12" is treated as an ordinary message.

-- Short reference shown to people (#12), shared by WhatsApp and the Setu screen.
alter table public.dv_seva_requests add column ref integer generated always as identity;
create unique index dv_seva_requests_ref_idx on public.dv_seva_requests (ref);

create table public.dv_whatsapp_approvers (
  profile_id uuid primary key references public.profiles (id),
  added_by   uuid references public.profiles (id),
  added_at   timestamptz not null default now()
);

-- dv_can for a given person rather than the signed-in user (WhatsApp replies have no session).
create function private.dv_can_for(p_profile uuid, p_permission public.dv_permission)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_profile and p.status = 'active'
       and (p.role = 'super_admin'
            or exists (select 1 from public.dv_operator_permissions op
                        where op.profile_id = p.id and op.permission = p_permission)))
$$;

-- ---------------------------------------------------------------------------
-- Asking: when a request is left waiting, message each approver.
-- Deferred to the end of the transaction, so a request that was assigned
-- automatically in the same transaction never produces a message.
-- ---------------------------------------------------------------------------
create function private.dv_seva_ask_approvers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r public.dv_seva_requests;
  v_plan jsonb;
  v_who text;
  v_team text;
  v_where text;
  v_body text;
  v_note text;
  a record;
begin
  select * into r from public.dv_seva_requests where id = new.id;
  if r.status <> 'pending' or not (select enabled from public.wa_account where id) then
    return null;
  end if;

  v_where := case when r.group_id is null then 'a private chat'
                  else coalesce('"' || (select name from public.wa_groups where id = r.group_id) || '"', 'a group') end;

  if r.requester_profile_id is null then
    v_body := format(E'🙏 Seva request #%s\n\nSomeone (%s) asked for leads in %s, but could not be matched to a volunteer.\n\nPlease open Setu → Digital Volunteer → Seva requests to confirm who they are.',
                     r.ref, coalesce(nullif(btrim(r.sender_name), ''), r.sender_phone::text, 'unknown'), v_where);
  else
    select coalesce(nullif(btrim(p.full_name), ''), 'A volunteer'), t.name into v_who, v_team
      from public.profiles p left join public.teams t on t.id = p.team_id
     where p.id = r.requester_profile_id;
    v_plan := private.dv_seva_plan(r.requester_profile_id, r.group_id, r.requested_count);
    v_note := case
      when (v_plan ->> 'allowed')::integer = 0 or (v_plan ->> 'available')::integer = 0
        then E'\n⚠️ ' || coalesce(v_plan ->> 'reason', 'No leads can be given right now') || E'\n'
      else '' end;
    v_body := format(E'🙏 Seva request #%1$s\n\n%2$s%3$s asked for leads in %4$s:\n“%5$s”\n\nCan receive up to %6$s now · %7$s free lead(s) in their team.\n%8$s\nReply:\nYES %1$s → approve\nYES %1$s 3 → approve only 3\nNO %1$s reason → decline',
                     r.ref, v_who, coalesce(' (' || v_team || ')', ''), v_where, left(coalesce(r.request_text, ''), 200),
                     v_plan ->> 'allowed', v_plan ->> 'available', v_note);
  end if;

  for a in
    select p.id, p.phone
      from public.dv_whatsapp_approvers w
      join public.profiles p on p.id = w.profile_id
     where p.status = 'active' and p.phone is not null
       and p.id is distinct from r.requester_profile_id
       and private.dv_can_for(p.id, 'assign_seva')
  loop
    insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key)
    values (replace(a.phone, '+', '') || '@s.whatsapp.net', 'direct', v_body, 'queued', true,
            'seva-ask:' || r.id || ':' || a.id)
    on conflict (idempotency_key) do nothing;
  end loop;
  return null;
end;
$$;

create constraint trigger dv_seva_requests_ask_approvers
  after insert on public.dv_seva_requests
  deferrable initially deferred
  for each row execute function private.dv_seva_ask_approvers();

-- ---------------------------------------------------------------------------
-- Deciding: the gateway calls this when a private message looks like
-- "YES 12" / "NO 12 ...". Returns handled=false when the sender is not an
-- approver, so the message is processed as an ordinary one.
-- ---------------------------------------------------------------------------
create function public.dv_seva_whatsapp_decision(
  p_message_id uuid, p_action text, p_ref integer, p_count integer default null, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  v_approver uuid;
  r public.dv_seva_requests;
  v_res jsonb;
  v_reply text;
  v_reason text := left(nullif(btrim(p_reason), ''), 300);
begin
  select * into m from public.wa_messages where id = p_message_id and direction = 'in';
  if m.id is null or m.chat_jid like '%@g.us' or m.intent is not null or p_action not in ('approve', 'decline') then
    return jsonb_build_object('handled', false);
  end if;
  select p.id into v_approver
    from public.profiles p
    join public.dv_whatsapp_approvers w on w.profile_id = p.id
   where p.id = m.sender_profile_id and p.status = 'active';
  if v_approver is null then
    return jsonb_build_object('handled', false);   -- not an approver: an ordinary message
  end if;

  update public.wa_messages
     set intent = 'approval_reply', intent_source = 'keywords', status = 'processed', processed_at = now()
   where id = m.id;

  select * into r from public.dv_seva_requests where ref = p_ref;
  if not private.dv_can_for(v_approver, 'assign_seva') then
    v_reply := 'Sorry, you no longer have permission to approve seva requests.';
  elsif r.id is null then
    v_reply := format('Request #%s was not found.', p_ref);
  elsif r.status <> 'pending' then
    v_reply := format('Request #%s was already handled (%s).', p_ref,
      case r.status when 'fulfilled' then 'leads assigned' when 'rejected' then 'declined'
                    when 'no_leads' then 'no leads were available' else r.status end);
  elsif r.requester_profile_id = v_approver then
    v_reply := 'You cannot approve your own request.';
  elsif p_action = 'approve' then
    if r.requester_profile_id is null then
      v_reply := format('Request #%s: please confirm who this is in Setu first (Digital Volunteer → Seva requests).', p_ref);
    elsif p_count is not null and (p_count < 1 or p_count > 50) then
      v_reply := 'Please choose between 1 and 50 leads.';
    else
      begin
        v_res := private.dv_seva_allocate(r.id, v_approver, p_count);
        v_reply := case v_res ->> 'status'
          when 'fulfilled' then format('✅ #%s approved: %s lead(s) assigned and sent to the volunteer.', p_ref, v_res ->> 'assigned')
          when 'no_leads' then format('#%s: there are no free leads for their team right now. The volunteer has been told.', p_ref)
          else format('#%s could not be fulfilled: %s.', p_ref, coalesce(v_res ->> 'reason', 'limits reached')) end;
      exception when others then
        v_reply := format('#%s could not be approved: %s', p_ref, left(sqlerrm, 150));
      end;
    end if;
  else
    update public.dv_seva_requests
       set status = 'rejected', decided_by = v_approver, decided_at = now(), reason = v_reason
     where id = r.id and status = 'pending';
    update public.wa_messages set status = 'processed' where id = r.message_id;
    if r.requester_profile_id is not null then
      perform private.notify(r.requester_profile_id, 'seva_request_declined', 'Seva request not approved',
        coalesce(left(v_reason, 200), 'Your request for leads was not approved this time.'), jsonb_build_object('request_id', r.id));
    end if;
    perform private.audit('dv.seva_rejected', 'dv_seva_request', r.id, jsonb_build_object('reason', v_reason, 'via', 'whatsapp'), v_approver);
    v_reply := format('❌ #%s declined.%s', p_ref, case when v_reason is null then '' else ' The volunteer will see your reason.' end);
  end if;

  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', v_reply, m.id, 'queued', true, 'decision:' || m.id)
  on conflict (idempotency_key) do nothing;
  perform private.audit('dv.seva_whatsapp_decision', 'dv_seva_request', r.id,
    jsonb_build_object('action', p_action, 'ref', p_ref, 'count', p_count, 'reply', v_reply), v_approver);
  return jsonb_build_object('handled', true, 'reply', v_reply);
end;
$$;

-- ---------------------------------------------------------------------------
-- Choosing approvers (integration managers)
-- ---------------------------------------------------------------------------
create function public.dv_approver_candidates()
returns table (id uuid, full_name text, has_phone boolean, can_approve boolean, is_approver boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'User'), p.phone is not null,
           private.dv_can_for(p.id, 'assign_seva'),
           exists (select 1 from public.dv_whatsapp_approvers w where w.profile_id = p.id)
      from public.profiles p
     where p.status = 'active'
       and (p.role = 'super_admin'
            or exists (select 1 from public.dv_operator_permissions op where op.profile_id = p.id and op.permission = 'assign_seva')
            or exists (select 1 from public.dv_whatsapp_approvers w where w.profile_id = p.id))
     order by 2;
end;
$$;

create function public.dv_set_whatsapp_approver(p_profile_id uuid, p_enabled boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_enabled then
    if not private.dv_can_for(p_profile_id, 'assign_seva') then
      raise exception 'Give this person the "Assign seva leads" permission first' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles where id = p_profile_id and phone is not null) then
      raise exception 'Save a phone number on this person''s profile first' using errcode = '22023';
    end if;
    insert into public.dv_whatsapp_approvers (profile_id, added_by) values (p_profile_id, auth.uid())
    on conflict (profile_id) do nothing;
  else
    delete from public.dv_whatsapp_approvers where profile_id = p_profile_id;
  end if;
  perform private.audit('dv.whatsapp_approver_changed', 'profile', p_profile_id, jsonb_build_object('enabled', p_enabled));
end;
$$;

revoke all on public.dv_whatsapp_approvers from anon, authenticated;
grant select on public.dv_whatsapp_approvers to authenticated;
alter table public.dv_whatsapp_approvers enable row level security;
create policy dv_whatsapp_approvers_select on public.dv_whatsapp_approvers for select to authenticated
  using (private.dv_can('manage_integration') or private.dv_can('assign_seva'));

revoke all on function public.dv_seva_whatsapp_decision(uuid, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.dv_approver_candidates() from public, anon;
revoke all on function public.dv_set_whatsapp_approver(uuid, boolean) from public, anon;
grant execute on function public.dv_approver_candidates(), public.dv_set_whatsapp_approver(uuid, boolean) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_seva_whatsapp_decision(uuid, text, integer, integer, text) to service_role;
  end if;
end;
$$;
