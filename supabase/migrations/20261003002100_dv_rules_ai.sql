-- Digital Volunteer: reply rules, AI settings, and approving suggested replies on WhatsApp.
--
-- 1. Reply rules (people with "Course responses" manage them). Each rule has trigger
--    words and one action: send its own reply text, send a chosen course's details,
--    treat the message as a seva request, or hand it to a person. The gateway checks
--    rules first (by priority), then the built-in keyword detection, then AI.
-- 2. AI settings (super admins only, in Settings): Anthropic API or Amazon Bedrock.
--    Keys are stored here but are never readable from the browser: only the gateway
--    (service role) reads them. Super admins see whether a key is set and its last
--    4 characters. "Test AI" asks the gateway to make one small call.
-- 3. AI drafts: when nothing in Setu answers a question, AI may draft a reply from
--    Setu's course data. A draft is NEVER sent automatically, in any mode.
-- 4. Reply approvers: chosen people get each draft on their own WhatsApp with a
--    number, and reply SEND 12 / EDIT 12 new text / SKIP 12. A WhatsApp reply is never
--    more powerful than the person's Setu account (same checks as seva approvals).

-- ---------------------------------------------------------------------------
-- 1. Reply rules
-- ---------------------------------------------------------------------------
create table public.dv_rules (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 80),
  enabled    boolean not null default true,
  priority   integer not null default 100 check (priority between 1 and 1000),  -- lower runs first
  keywords   text[] not null check (cardinality(keywords) between 1 and 50),
  action     text not null check (action in ('reply', 'course', 'seva', 'handover')),
  reply_body text check (length(reply_body) <= 2000),
  course_id  uuid references public.courses (id) on delete cascade,
  in_groups  boolean not null default true,
  in_direct  boolean not null default true,
  created_by uuid references public.profiles (id) default auth.uid(),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (action <> 'reply' or coalesce(btrim(reply_body), '') <> ''),
  check (action <> 'course' or course_id is not null),
  check (in_groups or in_direct)
);

create function private.dv_rules_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Trimmed, lower-case, unique, non-empty trigger words.
  new.keywords := array(select distinct lower(btrim(k)) from unnest(new.keywords) k where btrim(k) <> '' order by 1);
  if cardinality(new.keywords) = 0 then
    raise exception 'Add at least one trigger word' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(new.keywords) k where length(k) > 60) then
    raise exception 'Each trigger word or phrase can be up to 60 characters' using errcode = '22023';
  end if;
  if new.action <> 'reply' then new.reply_body := null; end if;
  if new.action <> 'course' then new.course_id := null; end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  perform private.audit('dv.rule_' || lower(tg_op), 'dv_rule', new.id,
    jsonb_build_object('name', new.name, 'action', new.action, 'enabled', new.enabled));
  return new;
end;
$$;
create trigger dv_rules_before_write before insert or update on public.dv_rules
  for each row execute function private.dv_rules_before_write();

create function private.dv_rules_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.audit('dv.rule_delete', 'dv_rule', old.id, jsonb_build_object('name', old.name));
  return null;
end;
$$;
create trigger dv_rules_after_delete after delete on public.dv_rules
  for each row execute function private.dv_rules_after_delete();

alter table public.wa_messages add column rule_id uuid references public.dv_rules (id) on delete set null;

revoke all on public.dv_rules from anon, authenticated;
grant select, delete on public.dv_rules to authenticated;
grant insert (name, enabled, priority, keywords, action, reply_body, course_id, in_groups, in_direct),
      update (name, enabled, priority, keywords, action, reply_body, course_id, in_groups, in_direct)
  on public.dv_rules to authenticated;
alter table public.dv_rules enable row level security;
create policy dv_rules_select on public.dv_rules for select to authenticated using (private.dv_is_operator());
create policy dv_rules_insert on public.dv_rules for insert to authenticated with check (private.dv_can('manage_content'));
create policy dv_rules_update on public.dv_rules for update to authenticated
  using (private.dv_can('manage_content')) with check (private.dv_can('manage_content'));
create policy dv_rules_delete on public.dv_rules for delete to authenticated using (private.dv_can('manage_content'));

-- ---------------------------------------------------------------------------
-- 2. AI settings (singleton). No client access at all: RPCs below.
-- ---------------------------------------------------------------------------
create table public.dv_ai_settings (
  id                    boolean primary key default true check (id),
  provider              text not null default 'none' check (provider in ('none', 'anthropic', 'bedrock')),
  anthropic_api_key     text,
  anthropic_model       text not null default 'claude-opus-5-5' check (length(anthropic_model) <= 100),
  bedrock_region        text check (length(bedrock_region) <= 40),
  bedrock_model_id      text check (length(bedrock_model_id) <= 200),
  aws_access_key_id     text,
  aws_secret_access_key text,
  classify_enabled      boolean not null default true,   -- AI works out unclear messages
  draft_enabled         boolean not null default false,  -- AI drafts replies (always needs a person)
  ask_on_whatsapp       text not null default 'ai' check (ask_on_whatsapp in ('ai', 'all', 'none')),
  last_test_at          timestamptz,
  last_test_ok          boolean,
  last_test_result      text,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.profiles (id)
);
insert into public.dv_ai_settings default values;
revoke all on public.dv_ai_settings from anon, authenticated;
alter table public.dv_ai_settings enable row level security;   -- and no policies: service role only

create function public.dv_ai_settings_get()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.dv_ai_settings;
begin
  if not private.is_super_admin() then
    raise exception 'Only a super admin can see AI settings' using errcode = '42501';
  end if;
  select * into s from public.dv_ai_settings where id;
  -- Never the keys themselves: whether they are set, and their last 4 characters.
  return jsonb_build_object(
    'provider', s.provider,
    'anthropic_model', s.anthropic_model,
    'anthropic_key_hint', case when s.anthropic_api_key is not null then right(s.anthropic_api_key, 4) end,
    'bedrock_region', s.bedrock_region,
    'bedrock_model_id', s.bedrock_model_id,
    'aws_key_hint', case when s.aws_access_key_id is not null then right(s.aws_access_key_id, 4) end,
    'aws_secret_set', s.aws_secret_access_key is not null,
    'classify_enabled', s.classify_enabled,
    'draft_enabled', s.draft_enabled,
    'ask_on_whatsapp', s.ask_on_whatsapp,
    'last_test_at', s.last_test_at,
    'last_test_ok', s.last_test_ok,
    'last_test_result', s.last_test_result,
    'updated_at', s.updated_at);
end;
$$;

-- A key argument: null = keep the saved key, '' = remove it, anything else = replace it.
create function public.dv_ai_settings_save(
  p_provider text, p_anthropic_model text, p_bedrock_region text, p_bedrock_model_id text,
  p_classify boolean, p_draft boolean, p_ask_on_whatsapp text,
  p_anthropic_key text default null, p_aws_key_id text default null, p_aws_secret text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.dv_ai_settings;
begin
  if not private.is_super_admin() then
    raise exception 'Only a super admin can change AI settings' using errcode = '42501';
  end if;
  if p_provider not in ('none', 'anthropic', 'bedrock') then
    raise exception 'Unknown AI provider' using errcode = '22023';
  end if;
  update public.dv_ai_settings
     set provider = p_provider,
         anthropic_model = coalesce(nullif(btrim(p_anthropic_model), ''), 'claude-opus-5-5'),
         bedrock_region = nullif(btrim(p_bedrock_region), ''),
         bedrock_model_id = nullif(btrim(p_bedrock_model_id), ''),
         classify_enabled = coalesce(p_classify, classify_enabled),
         draft_enabled = coalesce(p_draft, draft_enabled),
         ask_on_whatsapp = coalesce(p_ask_on_whatsapp, ask_on_whatsapp),
         anthropic_api_key = case when p_anthropic_key is null then anthropic_api_key else nullif(btrim(p_anthropic_key), '') end,
         aws_access_key_id = case when p_aws_key_id is null then aws_access_key_id else nullif(btrim(p_aws_key_id), '') end,
         aws_secret_access_key = case when p_aws_secret is null then aws_secret_access_key else nullif(btrim(p_aws_secret), '') end,
         last_test_at = null, last_test_ok = null, last_test_result = null,
         updated_at = now(), updated_by = auth.uid()
   where id
  returning * into s;
  if s.provider = 'anthropic' and s.anthropic_api_key is null then
    raise exception 'Add the Anthropic API key' using errcode = '22023';
  end if;
  if s.provider = 'bedrock' and (s.bedrock_region is null or s.bedrock_model_id is null) then
    raise exception 'Add the AWS region and the Bedrock model id' using errcode = '22023';
  end if;
  -- The audit never contains a key.
  perform private.audit('dv.ai_settings_changed', 'dv_ai_settings', null, jsonb_build_object(
    'provider', s.provider, 'classify', s.classify_enabled, 'draft', s.draft_enabled, 'ask_on_whatsapp', s.ask_on_whatsapp,
    'anthropic_key_changed', p_anthropic_key is not null, 'aws_keys_changed', p_aws_key_id is not null or p_aws_secret is not null));
end;
$$;

-- "Test AI" goes through the gateway (the only part that holds the keys).
alter table public.wa_commands drop constraint wa_commands_command_check;
alter table public.wa_commands add constraint wa_commands_command_check
  check (command in ('link', 'logout', 'sync_groups', 'test_ai'));

create or replace function public.dv_request_command(p_command text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  if p_command not in ('link', 'logout', 'sync_groups', 'test_ai') then
    raise exception 'Unknown command' using errcode = '22023';
  end if;
  if p_command = 'test_ai' then
    if not private.is_super_admin() then
      raise exception 'Not authorised' using errcode = '42501';
    end if;
  elsif not private.dv_can(case when p_command = 'sync_groups' then 'manage_groups' else 'manage_integration' end::public.dv_permission) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  insert into public.wa_commands (command, requested_by) values (p_command, auth.uid()) returning id into v_id;
  perform private.audit('dv.command', 'wa_account', null, jsonb_build_object('command', p_command));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Deciding what happens with a message (now with rules and AI drafts)
-- ---------------------------------------------------------------------------
alter table public.wa_outbox
  add column ai_draft boolean not null default false,
  add column approval_ref integer generated always as identity;
create unique index wa_outbox_approval_ref_idx on public.wa_outbox (approval_ref);

drop function public.dv_record_intent(uuid, text, text, text, text, integer);

create function public.dv_record_intent(
  p_message_id uuid, p_intent text, p_source text, p_reply text default null, p_reply_kind text default null,
  p_requested_count integer default null, p_rule_id uuid default null
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

  v_status := case when p_intent = 'none' or not v_allowed then 'ignored' else 'needs_review' end;

  if p_intent = 'course_info' and v_allowed and v_acc.enabled and v_mode <> 'manual'
     and coalesce(btrim(p_reply), '') <> '' then
    -- Sent by itself only in Automatic mode, never a hand-over and never an AI draft.
    v_send := case when v_mode = 'automatic' and not v_acc.auto_paused
                        and p_reply_kind is distinct from 'fallback' and not v_ai
                   then 'queued' else 'pending_approval' end;
    insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key, ai_draft)
    values (v_msg.chat_jid, 'reply', left(btrim(p_reply), 4000), v_msg.id, v_send, true, 'answer:' || v_msg.id, v_ai)
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

  return jsonb_strip_nulls(jsonb_build_object('status', v_status, 'outbox_id', v_outbox, 'send', v_send, 'seva', v_seva));
end;
$$;

alter table public.wa_messages drop constraint if exists wa_messages_intent_source_check;
alter table public.wa_messages add constraint wa_messages_intent_source_check
  check (intent_source in ('keywords', 'ai', 'human', 'rule'));

-- ---------------------------------------------------------------------------
-- 4. Approving suggested replies on WhatsApp
-- ---------------------------------------------------------------------------
create table public.dv_reply_approvers (
  profile_id uuid primary key references public.profiles (id),
  added_by   uuid references public.profiles (id),
  added_at   timestamptz not null default now()
);

-- When a suggestion waits for approval, message each reply approver (deferred, like seva).
create function private.dv_reply_ask_approvers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o public.wa_outbox;
  m public.wa_messages;
  v_scope text;
  v_where text;
  v_body text;
  a record;
begin
  select * into o from public.wa_outbox where id = new.id;
  if o.status <> 'pending_approval' or o.kind <> 'reply' or not (select enabled from public.wa_account where id) then
    return null;
  end if;
  select ask_on_whatsapp into v_scope from public.dv_ai_settings where id;
  if v_scope = 'none' or (v_scope = 'ai' and not o.ai_draft) then
    return null;
  end if;
  select * into m from public.wa_messages where id = o.quoted_message_id;
  v_where := case when o.chat_jid like '%@g.us'
                  then coalesce('"' || (select name from public.wa_groups where jid = o.chat_jid) || '"', 'a group')
                  else 'a private chat' end;
  v_body := format(E'%1$s Suggested reply #%2$s\n\n%3$s asked in %4$s:\n“%5$s”\n\nSuggested reply:\n%6$s\n\nReply:\nSEND %2$s → send it\nEDIT %2$s your text → send your text instead\nSKIP %2$s → don''t reply',
                   case when o.ai_draft then '🤖' else '💬' end, o.approval_ref,
                   coalesce(nullif(btrim(m.sender_name), ''), 'Someone'), v_where,
                   left(coalesce(m.body, ''), 300), left(o.body, 1500));
  for a in
    select p.id, p.phone
      from public.dv_reply_approvers r
      join public.profiles p on p.id = r.profile_id
     where p.status = 'active' and p.phone is not null
       and private.dv_can_for(p.id, 'reply_messages')
  loop
    insert into public.wa_outbox (chat_jid, kind, body, status, auto, idempotency_key)
    values (replace(a.phone, '+', '') || '@s.whatsapp.net', 'direct', v_body, 'queued', true,
            'reply-ask:' || o.id || ':' || a.id)
    on conflict (idempotency_key) do nothing;
  end loop;
  return null;
end;
$$;

create constraint trigger wa_outbox_reply_ask_approvers
  after insert on public.wa_outbox
  deferrable initially deferred
  for each row when (new.status = 'pending_approval' and new.kind = 'reply')
  execute function private.dv_reply_ask_approvers();

-- The gateway calls this for a private "SEND 12" / "EDIT 12 text" / "SKIP 12".
-- handled=false when the sender isn't a reply approver: then it's an ordinary message.
create function public.dv_reply_whatsapp_decision(p_message_id uuid, p_action text, p_ref integer, p_text text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.wa_messages;
  v_approver uuid;
  o public.wa_outbox;
  v_reply text;
  v_text text := left(nullif(btrim(p_text), ''), 4000);
begin
  select * into m from public.wa_messages where id = p_message_id and direction = 'in';
  if m.id is null or m.chat_jid like '%@g.us' or m.intent is not null or p_action not in ('send', 'edit', 'skip') then
    return jsonb_build_object('handled', false);
  end if;
  select p.id into v_approver
    from public.profiles p join public.dv_reply_approvers r on r.profile_id = p.id
   where p.id = m.sender_profile_id and p.status = 'active';
  if v_approver is null then
    return jsonb_build_object('handled', false);
  end if;

  update public.wa_messages
     set intent = 'approval_reply', intent_source = 'keywords', status = 'processed', processed_at = now()
   where id = m.id;

  select * into o from public.wa_outbox where approval_ref = p_ref and kind = 'reply' for update;
  if not private.dv_can_for(v_approver, 'reply_messages') then
    v_reply := 'Sorry, you no longer have permission to send replies.';
  elsif not (select enabled from public.wa_account where id) then
    v_reply := 'Digital Volunteer is switched off, so nothing can be sent right now.';
  elsif o.id is null then
    v_reply := format('Suggested reply #%s was not found.', p_ref);
  elsif o.status <> 'pending_approval' then
    v_reply := format('#%s was already handled (%s).', p_ref,
      case o.status when 'queued' then 'being sent' when 'sending' then 'being sent' when 'sent' then 'sent'
                    when 'cancelled' then 'skipped' else o.status end);
  elsif p_action = 'edit' and v_text is null then
    v_reply := format('Write the reply after the number, e.g. EDIT %s Thank you, the next course is on Sunday.', p_ref);
  elsif p_action = 'skip' then
    update public.wa_outbox set status = 'cancelled' where id = o.id;
    update public.wa_messages set status = 'processed' where id = o.quoted_message_id and status = 'needs_review';
    v_reply := format('#%s skipped: no reply will be sent.', p_ref);
  else
    update public.wa_outbox
       set status = 'queued', approved_by = v_approver, send_after = now(),
           body = case when p_action = 'edit' then v_text else body end
     where id = o.id;
    update public.wa_messages set status = 'processed' where id = o.quoted_message_id and status = 'needs_review';
    v_reply := format('✅ #%s %s.', p_ref, case when p_action = 'edit' then 'your text is being sent' else 'is being sent' end);
  end if;

  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, status, auto, idempotency_key)
  values (m.chat_jid, 'direct', v_reply, m.id, 'queued', true, 'decision:' || m.id)
  on conflict (idempotency_key) do nothing;
  perform private.audit('dv.reply_whatsapp_decision', 'wa_outbox', o.id,
    jsonb_build_object('action', p_action, 'ref', p_ref, 'reply', v_reply), v_approver);
  return jsonb_build_object('handled', true, 'reply', v_reply);
end;
$$;

create function public.dv_reply_approver_candidates()
returns table (id uuid, full_name text, has_phone boolean, can_reply boolean, is_approver boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'User'), p.phone is not null,
           private.dv_can_for(p.id, 'reply_messages'),
           exists (select 1 from public.dv_reply_approvers r where r.profile_id = p.id)
      from public.profiles p
     where p.status = 'active'
       and (p.role = 'super_admin'
            or exists (select 1 from public.dv_operator_permissions op where op.profile_id = p.id and op.permission = 'reply_messages')
            or exists (select 1 from public.dv_reply_approvers r where r.profile_id = p.id))
     order by 2;
end;
$$;

create function public.dv_set_reply_approver(p_profile_id uuid, p_enabled boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_enabled then
    if not private.dv_can_for(p_profile_id, 'reply_messages') then
      raise exception 'Give this person the "Reply" permission first' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles where id = p_profile_id and phone is not null) then
      raise exception 'Save a phone number on this person''s profile first' using errcode = '22023';
    end if;
    insert into public.dv_reply_approvers (profile_id, added_by) values (p_profile_id, auth.uid())
    on conflict (profile_id) do nothing;
  else
    delete from public.dv_reply_approvers where profile_id = p_profile_id;
  end if;
  perform private.audit('dv.reply_approver_changed', 'profile', p_profile_id, jsonb_build_object('enabled', p_enabled));
end;
$$;

revoke all on public.dv_reply_approvers from anon, authenticated;
grant select on public.dv_reply_approvers to authenticated;
alter table public.dv_reply_approvers enable row level security;
create policy dv_reply_approvers_select on public.dv_reply_approvers for select to authenticated
  using (private.dv_can('manage_integration') or private.dv_can('reply_messages'));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.dv_ai_settings_get() from public, anon;
revoke all on function public.dv_ai_settings_save(text, text, text, text, boolean, boolean, text, text, text, text) from public, anon;
revoke all on function public.dv_record_intent(uuid, text, text, text, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.dv_reply_whatsapp_decision(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.dv_reply_approver_candidates() from public, anon;
revoke all on function public.dv_set_reply_approver(uuid, boolean) from public, anon;
grant execute on function public.dv_ai_settings_get(),
                          public.dv_ai_settings_save(text, text, text, text, boolean, boolean, text, text, text, text),
                          public.dv_reply_approver_candidates(),
                          public.dv_set_reply_approver(uuid, boolean)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, update on public.dv_ai_settings to service_role;
    grant select on public.dv_rules to service_role;
    grant execute on function public.dv_record_intent(uuid, text, text, text, text, integer, uuid),
                              public.dv_reply_whatsapp_decision(uuid, text, integer, text)
      to service_role;
  end if;
end;
$$;
