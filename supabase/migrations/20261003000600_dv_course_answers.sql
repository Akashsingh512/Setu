-- Digital Volunteer, part 2: course answers.
--
-- The gateway detects what a message asks and builds a reply from verified
-- course data (packages/shared/src/dv-answers.ts). This migration decides,
-- in the database, whether that reply may go out and how:
--   * group disabled / course answers not allowed  -> nothing is sent
--   * manual mode                                   -> flagged for a person, no draft
--   * assisted mode (default), or automatic paused  -> draft waits for approval
--   * automatic mode                                -> queued to send
-- A "hand over to a person" reply is never sent automatically.
-- One answer per message, whatever happens: idempotency key "answer:<message id>".

create table public.dv_response_templates (
  kind       text primary key check (kind in ('course_details', 'course_list', 'no_upcoming', 'fallback')),
  body       text not null check (length(btrim(body)) between 1 and 2000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id)
);
-- No row = the built-in default template (DEFAULT_DV_TEMPLATES in the shared package).

create function public.dv_save_template(p_kind text, p_body text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_content') then
    raise exception 'Not authorised to edit course responses' using errcode = '42501';
  end if;
  if p_body is null or btrim(p_body) = '' then
    delete from public.dv_response_templates where kind = p_kind;   -- back to the default
  else
    insert into public.dv_response_templates (kind, body, updated_by)
    values (p_kind, p_body, auth.uid())
    on conflict (kind) do update set body = excluded.body, updated_at = now(), updated_by = auth.uid();
  end if;
  perform private.audit('dv.template_saved', 'dv_template', null,
    jsonb_build_object('kind', p_kind, 'reset', p_body is null or btrim(p_body) = ''));
end;
$$;

-- Called by the gateway after it has analysed a new incoming message.
create function public.dv_record_intent(
  p_message_id uuid, p_intent text, p_source text, p_reply text default null, p_reply_kind text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_msg public.wa_messages;
  v_acc public.wa_account;
  v_group public.wa_groups;
  v_allowed boolean;
  v_mode public.dv_mode;
  v_outbox uuid;
  v_status text;
  v_send text;
begin
  select * into v_msg from public.wa_messages where id = p_message_id and direction = 'in';
  if v_msg.id is null then
    raise exception 'Message not found' using errcode = '22023';
  end if;
  if v_msg.intent is not null then
    return jsonb_build_object('skipped', true, 'reason', 'already_processed');
  end if;
  select * into v_acc from public.wa_account where id;

  if v_msg.chat_jid like '%@g.us' then
    select * into v_group from public.wa_groups where id = v_msg.group_id;
    v_mode := coalesce(v_group.mode, 'manual');
    v_allowed := coalesce(v_group.enabled and v_group.is_member and v_group.allow_read, false)
      and case p_intent
            when 'course_info' then v_group.allow_course_info
            when 'seva_request' then v_group.allow_seva_requests
            else false end;
  else
    v_mode := v_acc.dm_mode;
    v_allowed := case p_intent when 'course_info' then v_acc.dm_course_info when 'seva_request' then true else false end;
  end if;

  v_status := case when p_intent = 'none' or not v_allowed then 'ignored' else 'needs_review' end;

  if p_intent = 'course_info' and v_allowed and v_acc.enabled and v_mode <> 'manual'
     and coalesce(btrim(p_reply), '') <> '' then
    v_send := case when v_mode = 'automatic' and not v_acc.auto_paused and p_reply_kind is distinct from 'fallback'
                   then 'queued' else 'pending_approval' end;
    insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
    values (v_msg.chat_jid, 'reply', left(btrim(p_reply), 4000), v_msg.id, v_send, true, 'answer:' || v_msg.id)
    on conflict (idempotency_key) do nothing
    returning id into v_outbox;
    if v_send = 'queued' then
      v_status := 'processed';
    end if;
  end if;

  update public.wa_messages
     set intent = p_intent, intent_source = p_source, status = v_status, processed_at = now(), outbox_id = v_outbox
   where id = v_msg.id;

  return jsonb_strip_nulls(jsonb_build_object('status', v_status, 'outbox_id', v_outbox, 'send', v_send));
end;
$$;

-- A person approves a suggested reply (optionally editing it). It is then queued.
create function public.dv_approve_outbox(p_id uuid, p_body text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.wa_outbox;
begin
  if not private.dv_can('reply_messages') then
    raise exception 'Not authorised to send WhatsApp messages' using errcode = '42501';
  end if;
  if not (select enabled from public.wa_account where id) then
    raise exception 'Digital Volunteer is switched off' using errcode = '55000';
  end if;
  update public.wa_outbox
     set status = 'queued', approved_by = auth.uid(), send_after = now(),
         body = coalesce(nullif(btrim(p_body), ''), body)
   where id = p_id and status = 'pending_approval'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'This suggestion was already handled' using errcode = '55000';
  end if;
  if v_row.quoted_message_id is not null then
    update public.wa_messages set status = 'processed' where id = v_row.quoted_message_id and status = 'needs_review';
  end if;
  perform private.audit('dv.suggestion_approved', 'wa_outbox', p_id,
    jsonb_build_object('edited', p_body is not null and btrim(p_body) <> ''));
end;
$$;

-- A person marks a message as handled without the bot replying (e.g. answered on the phone).
create function public.dv_dismiss_message(p_message_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('reply_messages') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.wa_outbox set status = 'cancelled'
   where quoted_message_id = p_message_id and status = 'pending_approval';
  update public.wa_messages set status = 'processed' where id = p_message_id and status = 'needs_review';
  perform private.audit('dv.message_dismissed', 'wa_message', p_message_id, '{}'::jsonb);
end;
$$;

revoke all on public.dv_response_templates from anon, authenticated;
grant select on public.dv_response_templates to authenticated;
alter table public.dv_response_templates enable row level security;
create policy dv_templates_select on public.dv_response_templates for select to authenticated
  using (private.dv_is_operator());

revoke all on function public.dv_record_intent(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.dv_save_template(text, text) from public, anon;
revoke all on function public.dv_approve_outbox(uuid, text) from public, anon;
revoke all on function public.dv_dismiss_message(uuid) from public, anon;
grant execute on function public.dv_save_template(text, text), public.dv_approve_outbox(uuid, text),
                          public.dv_dismiss_message(uuid)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.dv_response_templates to service_role;
    grant execute on function public.dv_record_intent(uuid, text, text, text, text) to service_role;
  end if;
end;
$$;
