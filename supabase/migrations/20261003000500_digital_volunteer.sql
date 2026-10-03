-- Digital Volunteer, part 1: operator permissions, the linked WhatsApp account,
-- groups and their permissions, message log and outbox.
--
-- The WhatsApp connection itself lives in apps/wa-gateway (an always-on Node
-- process using the open-source Baileys library, service role). The CRM never
-- talks to WhatsApp directly: users write intents (commands, outbox rows) that
-- RLS and RPCs authorise, and the gateway carries them out.
--
-- Safety switches: wa_account.enabled = false stops all reading and sending;
-- auto_paused = true stops automatic replies only. Both default to "off".

-- ---------------------------------------------------------------------------
-- Operator permissions (granted by super admins only)
-- ---------------------------------------------------------------------------
create type public.dv_permission as enum (
  'view_messages',          -- read the inbox and message history
  'reply_messages',         -- send replies / direct messages
  'manage_groups',          -- enable groups and set their permissions
  'assign_seva',            -- approve seva requests (assigns leads)
  'update_followups',       -- confirm WhatsApp follow-ups on leads
  'manage_content',         -- course response templates
  'schedule_announcements', -- create and approve announcements
  'manage_integration',     -- link / unlink the number, safety switches
  'view_audit'              -- Digital Volunteer reports and audit
);

create table public.dv_operator_permissions (
  profile_id uuid not null references public.profiles (id),
  permission public.dv_permission not null,
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  primary key (profile_id, permission)
);

-- Super admins hold every permission; others only what was granted, and only while active.
create function private.dv_can(p_permission public.dv_permission)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_super_admin()
      or exists (
        select 1
          from public.dv_operator_permissions op
          join public.profiles p on p.id = op.profile_id
         where op.profile_id = auth.uid()
           and op.permission = p_permission
           and p.status = 'active'
           and p.role in ('super_admin', 'teacher', 'volunteer'))
$$;

create function private.dv_is_operator()
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_super_admin()
      or exists (select 1 from public.dv_operator_permissions op
                   join public.profiles p on p.id = op.profile_id
                  where op.profile_id = auth.uid() and p.status = 'active')
$$;

-- Replaces a user's permission set in one step. Super admins only, so nobody
-- can grant themselves anything.
create function public.dv_set_operator_permissions(p_profile_id uuid, p_permissions public.dv_permission[])
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.dv_permission[];
begin
  if not private.is_super_admin() then
    raise exception 'Only a super admin can change Digital Volunteer access' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and status = 'active') then
    raise exception 'User not found or inactive' using errcode = '22023';
  end if;

  select coalesce(array_agg(permission order by permission), '{}') into v_before
    from public.dv_operator_permissions where profile_id = p_profile_id;

  delete from public.dv_operator_permissions
   where profile_id = p_profile_id and permission <> all (coalesce(p_permissions, '{}'));
  insert into public.dv_operator_permissions (profile_id, permission, granted_by)
  select p_profile_id, x, auth.uid() from unnest(coalesce(p_permissions, '{}')) as x
  on conflict do nothing;

  perform private.audit('dv.permissions_changed', 'profile', p_profile_id,
    jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(coalesce(p_permissions, '{}'))));
end;
$$;

-- ---------------------------------------------------------------------------
-- The linked account (singleton), pairing QR, gateway commands, session keys
-- ---------------------------------------------------------------------------
create type public.dv_mode as enum ('manual', 'assisted', 'automatic');

create table public.wa_account (
  id               boolean primary key default true check (id),
  enabled          boolean not null default false,   -- emergency switch: nothing read or sent when false
  auto_paused      boolean not null default false,   -- automatic replies paused (assisted still works)
  status           text not null default 'not_linked'
                   check (status in ('not_linked', 'waiting_for_scan', 'connecting', 'connected',
                                     'disconnected', 'logged_out', 'error')),
  phone_e164       text,
  display_name     text,
  connected_at     timestamptz,
  gateway_seen_at  timestamptz,                      -- heartbeat: is the gateway process alive?
  last_error       text,
  last_error_at    timestamptz,
  -- Direct (1:1) chats: how messages from leads and volunteers are handled.
  dm_mode          public.dv_mode not null default 'assisted',
  dm_course_info   boolean not null default false,
  dm_followup_sync boolean not null default false,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles (id)
);
insert into public.wa_account default values;

-- The QR code links a phone to the account, so only integration managers see it.
create table public.wa_pairing (
  id          boolean primary key default true check (id),
  qr_data_url text,
  updated_at  timestamptz not null default now()
);
insert into public.wa_pairing default values;

create table public.wa_commands (
  id           bigint generated always as identity primary key,
  command      text not null check (command in ('link', 'logout', 'sync_groups')),
  requested_by uuid references public.profiles (id),
  requested_at timestamptz not null default now(),
  done_at      timestamptz,
  result       text
);
create index wa_commands_pending_idx on public.wa_commands (requested_at) where done_at is null;

-- Baileys session keys. Service role only: no grants, RLS with no policies.
create table public.wa_auth_state (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Groups (discovered by the gateway; permissions set by group managers)
-- ---------------------------------------------------------------------------
create table public.wa_groups (
  id                     uuid primary key default gen_random_uuid(),
  jid                    text not null unique check (jid like '%@g.us'),
  name                   text not null default '',
  description            text,
  participant_count      integer,
  is_member              boolean not null default true,  -- the linked number is still in it
  enabled                boolean not null default false,
  mode                   public.dv_mode not null default 'assisted',
  allow_read             boolean not null default false,
  allow_course_info      boolean not null default false,
  allow_seva_requests    boolean not null default false,
  allow_lead_assignment  boolean not null default false,
  allow_announcements    boolean not null default false,
  allow_media            boolean not null default false,
  responsible_admin_id   uuid references public.profiles (id),
  max_leads_per_request  integer check (max_leads_per_request between 1 and 50),
  last_activity_at       timestamptz,
  discovered_at          timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references public.profiles (id)
);

create function private.wa_groups_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then
    new.updated_by := auth.uid();
    perform private.audit('dv.group_updated', 'wa_group', new.id,
      jsonb_build_object('name', new.name, 'enabled', new.enabled, 'mode', new.mode,
        'allow_read', new.allow_read, 'allow_course_info', new.allow_course_info,
        'allow_seva_requests', new.allow_seva_requests, 'allow_lead_assignment', new.allow_lead_assignment,
        'allow_announcements', new.allow_announcements, 'allow_media', new.allow_media,
        'max_leads_per_request', new.max_leads_per_request));
  end if;
  return new;
end;
$$;
create trigger wa_groups_before_update before update on public.wa_groups
  for each row execute function private.wa_groups_before_update();

-- ---------------------------------------------------------------------------
-- Messages and outbox
-- ---------------------------------------------------------------------------
create table public.wa_messages (
  id                  uuid primary key default gen_random_uuid(),
  chat_jid            text not null,
  provider_message_id text not null,
  direction           text not null check (direction in ('in', 'out')),
  group_id            uuid references public.wa_groups (id),
  sender_jid          text,
  sender_phone        public.e164,
  sender_name         text,
  sender_profile_id   uuid references public.profiles (id),  -- matched CRM user
  lead_id             uuid references public.leads (id),     -- matched lead (direct chats)
  body                text,
  media_type          text,
  sent_at             timestamptz not null,
  received_at         timestamptz not null default now(),
  intent              text,
  intent_source       text check (intent_source in ('keywords', 'ai', 'human')),
  status              text not null default 'received'
                      check (status in ('received', 'processed', 'needs_review', 'ignored', 'failed')),
  processed_at        timestamptz,
  error               text,
  outbox_id           uuid,
  unique (chat_jid, provider_message_id)    -- a redelivered event is stored once
);
create index wa_messages_chat_idx on public.wa_messages (chat_jid, sent_at desc);
create index wa_messages_review_idx on public.wa_messages (received_at) where status = 'needs_review';
create index wa_messages_lead_idx on public.wa_messages (lead_id, sent_at desc) where lead_id is not null;

create table public.wa_outbox (
  id                  uuid primary key default gen_random_uuid(),
  chat_jid            text not null,
  kind                text not null check (kind in ('reply', 'direct', 'announcement', 'seva_numbers')),
  body                text check (length(body) <= 4000),
  media_path          text,
  quoted_message_id   uuid references public.wa_messages (id),
  status              text not null default 'queued'
                      check (status in ('pending_approval', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
  auto                boolean not null default false,
  idempotency_key     text unique,              -- e.g. "reply:<message id>": one auto reply per message
  created_by          uuid references public.profiles (id),
  approved_by         uuid references public.profiles (id),
  send_after          timestamptz not null default now(),
  attempts            integer not null default 0,
  last_error          text,
  provider_message_id text,
  claimed_at          timestamptz,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  check (body is not null or media_path is not null)
);
create index wa_outbox_queue_idx on public.wa_outbox (send_after) where status = 'queued';

-- ---------------------------------------------------------------------------
-- User-facing RPCs
-- ---------------------------------------------------------------------------
create function public.dv_set_switches(p_enabled boolean default null, p_auto_paused boolean default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.wa_account
     set enabled = coalesce(p_enabled, enabled),
         auto_paused = coalesce(p_auto_paused, auto_paused),
         updated_at = now(), updated_by = auth.uid()
   where id;
  perform private.audit('dv.switches_changed', 'wa_account', null,
    jsonb_strip_nulls(jsonb_build_object('enabled', p_enabled, 'auto_paused', p_auto_paused)));
end;
$$;

create function public.dv_set_dm_settings(p_mode public.dv_mode, p_course_info boolean, p_followup_sync boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_groups') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.wa_account
     set dm_mode = p_mode, dm_course_info = p_course_info, dm_followup_sync = p_followup_sync,
         updated_at = now(), updated_by = auth.uid()
   where id;
  perform private.audit('dv.dm_settings_changed', 'wa_account', null,
    jsonb_build_object('mode', p_mode, 'course_info', p_course_info, 'followup_sync', p_followup_sync));
end;
$$;

create function public.dv_request_command(p_command text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  if not private.dv_can(case when p_command = 'sync_groups' then 'manage_groups' else 'manage_integration' end::public.dv_permission) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_command not in ('link', 'logout', 'sync_groups') then
    raise exception 'Unknown command' using errcode = '22023';
  end if;
  insert into public.wa_commands (command, requested_by) values (p_command, auth.uid()) returning id into v_id;
  perform private.audit('dv.command', 'wa_account', null, jsonb_build_object('command', p_command));
  return v_id;
end;
$$;

-- Human reply or direct message. Goes to the outbox; the gateway sends it.
create function public.dv_send_message(p_chat_jid text, p_body text, p_quoted_message_id uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_group public.wa_groups;
  v_id uuid;
begin
  if not private.dv_can('reply_messages') then
    raise exception 'Not authorised to send WhatsApp messages' using errcode = '42501';
  end if;
  if not (select enabled from public.wa_account where id) then
    raise exception 'Digital Volunteer is switched off' using errcode = '55000';
  end if;
  if coalesce(btrim(p_body), '') = '' then
    raise exception 'Message is empty' using errcode = '22023';
  end if;
  if p_chat_jid like '%@g.us' then
    select * into v_group from public.wa_groups where jid = p_chat_jid;
    if v_group.id is null or not v_group.enabled or not v_group.is_member then
      raise exception 'This group is not enabled for Digital Volunteer' using errcode = '42501';
    end if;
  elsif not exists (select 1 from public.wa_messages where chat_jid = p_chat_jid) then
    -- Only answer people who wrote to us: no cold messaging from the inbox.
    raise exception 'You can only reply to chats that have messaged this number' using errcode = '42501';
  end if;

  insert into public.wa_outbox (chat_jid, kind, body, quoted_message_id, created_by, approved_by)
  values (p_chat_jid, case when p_quoted_message_id is null then 'direct' else 'reply' end,
          btrim(p_body), p_quoted_message_id, auth.uid(), auth.uid())
  returning id into v_id;
  perform private.audit('dv.message_queued', 'wa_outbox', v_id, jsonb_build_object('chat', p_chat_jid));
  return v_id;
end;
$$;

create function public.dv_cancel_outbox(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('reply_messages') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.wa_outbox set status = 'cancelled'
   where id = p_id and status in ('pending_approval', 'queued', 'failed');
  if not found then
    raise exception 'This message is already being sent or was sent' using errcode = '55000';
  end if;
  perform private.audit('dv.message_cancelled', 'wa_outbox', p_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Gateway RPCs (service role only)
-- ---------------------------------------------------------------------------
-- Stores an incoming or outgoing message once. Returns the row id when new,
-- null for a duplicate delivery (so the caller does not process it again).
create function public.dv_ingest_message(
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

  if v_phone is not null and p_direction = 'in' then
    select id into v_profile from public.profiles where phone = v_phone and status = 'active' limit 1;
    -- A lead is linked only from a direct chat, and only when exactly one live lead has the number.
    if p_chat_jid not like '%@g.us' then
      select case when count(*) = 1 then min(id::text)::uuid end into v_lead
        from public.leads
       where (phone = v_phone or whatsapp_phone = v_phone) and archived_at is null and merged_into_id is null;
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

create function public.dv_claim_outbox(p_limit integer default 10)
returns setof public.wa_outbox
language plpgsql security definer set search_path = '' as $$
begin
  if not (select enabled from public.wa_account where id) then
    return;
  end if;
  -- A claim that never completed (gateway crashed mid-send) is not retried
  -- blindly: the message may have gone out. It is marked failed for a human.
  update public.wa_outbox set status = 'failed', last_error = 'Sending was interrupted; check the chat before retrying'
   where status = 'sending' and claimed_at < now() - interval '5 minutes';

  return query
  update public.wa_outbox o
     set status = 'sending', claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from public.wa_outbox
      where status = 'queued' and send_after <= now()
      order by send_after
      limit p_limit
        for update skip locked)
  returning o.*;
end;
$$;

create function public.dv_complete_outbox(p_id uuid, p_ok boolean, p_provider_message_id text default null, p_error text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.wa_outbox
     set status = case when p_ok then 'sent' else 'failed' end,
         provider_message_id = p_provider_message_id,
         sent_at = case when p_ok then now() end,
         last_error = case when p_ok then null else left(p_error, 1000) end
   where id = p_id and status = 'sending';
end;
$$;

-- Gateway reports discovered groups. Never touches permission columns.
create function public.dv_sync_groups(p_groups jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.wa_groups (jid, name, description, participant_count, is_member)
  select g ->> 'jid', coalesce(g ->> 'name', ''), g ->> 'description', (g ->> 'participant_count')::integer, true
    from jsonb_array_elements(p_groups) g
  on conflict (jid) do update
     set name = excluded.name, description = excluded.description,
         participant_count = excluded.participant_count, is_member = true;
  get diagnostics v_count = row_count;
  -- Groups we were removed from stay configured but can no longer be used.
  update public.wa_groups set is_member = false
   where jid not in (select g ->> 'jid' from jsonb_array_elements(p_groups) g);
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on public.dv_operator_permissions, public.wa_account, public.wa_pairing, public.wa_commands,
              public.wa_auth_state, public.wa_groups, public.wa_messages, public.wa_outbox
  from anon, authenticated;

grant select on public.dv_operator_permissions, public.wa_account, public.wa_pairing, public.wa_groups,
                public.wa_messages, public.wa_outbox, public.wa_commands
  to authenticated;
grant update (enabled, mode, allow_read, allow_course_info, allow_seva_requests, allow_lead_assignment,
              allow_announcements, allow_media, responsible_admin_id, max_leads_per_request, description)
  on public.wa_groups to authenticated;

alter table public.dv_operator_permissions enable row level security;
alter table public.wa_account              enable row level security;
alter table public.wa_pairing              enable row level security;
alter table public.wa_commands             enable row level security;
alter table public.wa_auth_state           enable row level security;
alter table public.wa_groups               enable row level security;
alter table public.wa_messages             enable row level security;
alter table public.wa_outbox               enable row level security;

create policy dv_perms_select on public.dv_operator_permissions for select to authenticated
  using (profile_id = auth.uid() or private.is_super_admin());
create policy wa_account_select on public.wa_account for select to authenticated
  using (private.dv_is_operator());
create policy wa_pairing_select on public.wa_pairing for select to authenticated
  using (private.dv_can('manage_integration'));
create policy wa_commands_select on public.wa_commands for select to authenticated
  using (private.dv_can('manage_integration'));
create policy wa_groups_select on public.wa_groups for select to authenticated
  using (private.dv_is_operator());
create policy wa_groups_update on public.wa_groups for update to authenticated
  using (private.dv_can('manage_groups')) with check (private.dv_can('manage_groups'));
create policy wa_messages_select on public.wa_messages for select to authenticated
  using (private.dv_can('view_messages'));
create policy wa_outbox_select on public.wa_outbox for select to authenticated
  using (private.dv_can('view_messages'));
-- wa_auth_state: no policies at all (service role only).

revoke all on function public.dv_ingest_message(text, text, text, text, text, text, text, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.dv_claim_outbox(integer) from public, anon, authenticated;
revoke all on function public.dv_complete_outbox(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.dv_sync_groups(jsonb) from public, anon, authenticated;
revoke all on function public.dv_set_operator_permissions(uuid, public.dv_permission[]) from public, anon;
revoke all on function public.dv_set_switches(boolean, boolean) from public, anon;
revoke all on function public.dv_set_dm_settings(public.dv_mode, boolean, boolean) from public, anon;
revoke all on function public.dv_request_command(text) from public, anon;
revoke all on function public.dv_send_message(text, text, uuid) from public, anon;
revoke all on function public.dv_cancel_outbox(uuid) from public, anon;
grant execute on function public.dv_set_operator_permissions(uuid, public.dv_permission[]),
                          public.dv_set_switches(boolean, boolean),
                          public.dv_set_dm_settings(public.dv_mode, boolean, boolean),
                          public.dv_request_command(text),
                          public.dv_send_message(text, text, uuid),
                          public.dv_cancel_outbox(uuid)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.wa_auth_state, public.wa_account, public.wa_pairing, public.wa_commands,
                 public.wa_groups, public.wa_messages, public.wa_outbox to service_role;
    grant execute on function public.dv_ingest_message(text, text, text, text, text, text, text, text, timestamptz, uuid),
                              public.dv_claim_outbox(integer),
                              public.dv_complete_outbox(uuid, boolean, text, text),
                              public.dv_sync_groups(jsonb)
      to service_role;
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.wa_account, public.wa_pairing, public.wa_messages, public.wa_outbox;
  end if;
end;
$$;
