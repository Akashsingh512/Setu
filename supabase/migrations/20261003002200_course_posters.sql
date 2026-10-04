-- Posters for programs and course responses.
--
--   * Each program (course_sessions.poster_path, the column already existed) can have
--     a poster. Course responses (dv_response_templates) can have one too, used when
--     the program has none.
--   * The bot's course reply carries the poster: in a private chat always, in a group
--     only when the group allows media. Otherwise it goes as text, as before.
--   * dv_send_lead_message: from a lead's page, the volunteer holding the lead (or
--     staff in scope) sends the message from the Setu WhatsApp number, with the
--     program's poster. The normal WhatsApp button still opens the person's own
--     WhatsApp with text only (a wa.me link cannot carry an image).
-- Posters live in the private "dv-posters" bucket: programs/... and templates/...

alter table public.course_sessions
  add constraint course_sessions_poster_path_check check (poster_path ~ '^programs/[A-Za-z0-9._/-]+$') not valid;

-- A row can now hold only a poster (body null = the built-in default text).
alter table public.dv_response_templates
  alter column body drop not null,
  add column poster_path text check (poster_path ~ '^templates/[A-Za-z0-9._/-]+$');

create or replace function public.dv_save_template(p_kind text, p_body text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_content') then
    raise exception 'Not authorised to edit course responses' using errcode = '42501';
  end if;
  if p_body is null or btrim(p_body) = '' then
    -- Back to the default text; a poster stays.
    update public.dv_response_templates set body = null, updated_at = now(), updated_by = auth.uid() where kind = p_kind;
    delete from public.dv_response_templates where kind = p_kind and poster_path is null;
  else
    insert into public.dv_response_templates (kind, body, updated_by)
    values (p_kind, p_body, auth.uid())
    on conflict (kind) do update set body = excluded.body, updated_at = now(), updated_by = auth.uid();
  end if;
  perform private.audit('dv.template_saved', 'dv_template', null,
    jsonb_build_object('kind', p_kind, 'reset', p_body is null or btrim(p_body) = ''));
end;
$$;

-- Set (path) or remove (null) the poster of a course response.
create function public.dv_set_template_poster(p_kind text, p_poster_path text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_content') then
    raise exception 'Not authorised to edit course responses' using errcode = '42501';
  end if;
  if p_kind not in ('course_details', 'course_list', 'no_upcoming') then
    raise exception 'This response cannot have a poster' using errcode = '22023';
  end if;
  if p_poster_path is null then
    update public.dv_response_templates set poster_path = null, updated_at = now(), updated_by = auth.uid() where kind = p_kind;
    delete from public.dv_response_templates where kind = p_kind and body is null;
  else
    insert into public.dv_response_templates (kind, poster_path, updated_by)
    values (p_kind, p_poster_path, auth.uid())
    on conflict (kind) do update set poster_path = excluded.poster_path, updated_at = now(), updated_by = auth.uid();
  end if;
  perform private.audit('dv.template_poster', 'dv_template', null,
    jsonb_build_object('kind', p_kind, 'removed', p_poster_path is null));
end;
$$;

-- ---------------------------------------------------------------------------
-- The bot's course reply, now with an optional poster
-- ---------------------------------------------------------------------------
drop function public.dv_record_intent(uuid, text, text, text, text, integer, uuid);

create function public.dv_record_intent(
  p_message_id uuid, p_intent text, p_source text, p_reply text default null, p_reply_kind text default null,
  p_requested_count integer default null, p_rule_id uuid default null, p_media_path text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_msg public.wa_messages;
  v_acc public.wa_account;
  v_group public.wa_groups;
  v_readable boolean;
  v_allowed boolean;
  v_mode public.dv_mode;
  v_outbox uuid;
  v_status text;
  v_send text;
  v_seva jsonb;
  v_ai boolean := p_reply_kind = 'ai_draft';
  v_media text;
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
    v_readable := coalesce(v_group.enabled and v_group.is_member and v_group.allow_read, false);
    v_allowed := v_readable
      and case p_intent
            when 'course_info' then v_group.allow_course_info
            when 'seva_request' then v_group.allow_seva_requests
            when 'handover' then true
            else false end;
  else
    v_mode := v_acc.dm_mode;
    v_allowed := case p_intent when 'course_info' then v_acc.dm_course_info
                               when 'seva_request' then v_acc.dm_seva_requests
                               when 'handover' then true
                               else false end;
  end if;

  -- A poster only where images are welcome; otherwise the same reply goes as text.
  if p_media_path ~ '^(programs|templates)/[A-Za-z0-9._/-]+$'
     and (v_msg.chat_jid not like '%@g.us' or coalesce(v_group.allow_media, false)) then
    v_media := p_media_path;
  end if;

  v_status := case when p_intent = 'none' or not v_allowed then 'ignored' else 'needs_review' end;

  if p_intent = 'course_info' and v_allowed and v_acc.enabled and v_mode <> 'manual'
     and coalesce(btrim(p_reply), '') <> '' then
    -- Sent by itself only in Automatic mode, never a hand-over and never an AI draft.
    v_send := case when v_mode = 'automatic' and not v_acc.auto_paused
                        and p_reply_kind is distinct from 'fallback' and not v_ai
                   then 'queued' else 'pending_approval' end;
    insert into public.wa_outbox (chat_jid, kind, body, media_path, quoted_message_id, status, auto, idempotency_key, ai_draft)
    values (v_msg.chat_jid, 'reply', left(btrim(p_reply), 4000), v_media, v_msg.id, v_send, true, 'answer:' || v_msg.id, v_ai)
    on conflict (idempotency_key) do nothing
    returning id into v_outbox;
    if v_send = 'queued' then
      v_status := 'processed';
    end if;
  end if;

  update public.wa_messages
     set intent = p_intent, intent_source = p_source, status = v_status, processed_at = now(), outbox_id = v_outbox,
         rule_id = p_rule_id
   where id = v_msg.id;

  if p_intent = 'seva_request' and v_allowed and v_acc.enabled then
    v_seva := private.dv_seva_open_request(v_msg.id, p_requested_count);
    if (v_seva ->> 'duplicate')::boolean is true then
      update public.wa_messages set status = 'ignored' where id = v_msg.id;
      v_status := 'ignored';
    elsif v_seva ->> 'status' = 'fulfilled' then
      v_status := 'processed';
    end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object('status', v_status, 'outbox_id', v_outbox, 'send', v_send, 'seva', v_seva,
                                              'poster', case when v_media is not null then true end));
end;
$$;

-- ---------------------------------------------------------------------------
-- Sending to a lead from the Setu number
-- ---------------------------------------------------------------------------
-- p_session_id: the program the message is about. Its poster goes with the message,
-- or the "One program" course response poster when the program has none.
create function public.dv_send_lead_message(p_lead_id uuid, p_body text, p_session_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_lead public.leads;
  v_jid text;
  v_media text;
  v_id uuid;
begin
  v_lead := private.lock_lead_for_action(p_lead_id);
  perform private.assert_contact_allowed(v_lead.status);
  if not coalesce((select enabled from public.wa_account where id), false) then
    raise exception 'The Setu WhatsApp number is switched off. Use the WhatsApp button instead.' using errcode = '55000';
  end if;
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Write a message' using errcode = '22023';
  end if;
  if length(p_body) > 4000 then
    raise exception 'The message is too long (4000 characters max)' using errcode = '22023';
  end if;

  v_jid := regexp_replace(coalesce(v_lead.whatsapp_phone, v_lead.phone), '[^0-9]', '', 'g') || '@s.whatsapp.net';
  if exists (select 1 from public.wa_outbox
              where chat_jid = v_jid and kind = 'direct' and created_by is not null
                and created_at > now() - interval '1 minute' and status <> 'cancelled') then
    raise exception 'A message was just sent to this lead. Wait a minute before sending another.' using errcode = '55000';
  end if;

  if p_session_id is not null then
    select coalesce(s.poster_path, t.poster_path) into v_media
      from public.course_sessions s
      left join public.dv_response_templates t on t.kind = 'course_details'
     where s.id = p_session_id
       and (s.team_id is null or private.is_super_admin() or s.team_id = private.my_team_id());
  end if;

  insert into public.wa_outbox (chat_jid, kind, body, media_path, status, auto, created_by, approved_by)
  values (v_jid, 'direct', btrim(p_body), v_media, 'queued', false, auth.uid(), auth.uid())
  returning id into v_id;

  perform private.log_activity(v_lead.id, 'whatsapp_sent',
    jsonb_build_object('outbox_id', v_id, 'preview', left(btrim(p_body), 280), 'poster', v_media is not null));
  perform private.audit('dv.lead_message_sent', 'lead', v_lead.id, jsonb_build_object('outbox_id', v_id, 'poster', v_media is not null));
  return jsonb_build_object('outbox_id', v_id, 'poster', v_media is not null);
end;
$$;

revoke all on function public.dv_record_intent(uuid, text, text, text, text, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.dv_set_template_poster(text, text) from public, anon;
revoke all on function public.dv_send_lead_message(uuid, text, uuid) from public, anon;
grant execute on function public.dv_set_template_poster(text, text), public.dv_send_lead_message(uuid, text, uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.dv_record_intent(uuid, text, text, text, text, integer, uuid, text) to service_role;
  end if;
  -- Program posters: uploaded by staff, seen by every signed-in user (they are
  -- shared publicly anyway). Response posters: uploaded by content managers.
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute $p$
      create policy dv_posters_programs_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'dv-posters' and name like 'programs/%' and private.is_staff())
    $p$;
    execute $p$
      create policy dv_posters_programs_select on storage.objects for select to authenticated
        using (bucket_id = 'dv-posters' and name like 'programs/%' and private.my_role() is not null)
    $p$;
    execute $p$
      create policy dv_posters_templates_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'dv-posters' and name like 'templates/%' and private.dv_can('manage_content'))
    $p$;
  end if;
end;
$$;
