-- Core schema: enums, tables, constraints, indexes.
-- Security (RLS, grants) is in a later migration; business logic in RPC migrations.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Enums (fixed vocabularies; lead statuses are configurable and live in a table)
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('super_admin', 'teacher', 'volunteer');
create type public.account_status as enum ('active', 'inactive');
create type public.call_outcome as enum (
  'connected', 'no_answer', 'busy', 'switched_off', 'call_failed', 'wrong_number'
);
create type public.assignment_kind as enum ('manual', 'bulk', 'auto_reassign', 'import');
create type public.assignment_end_reason as enum (
  'reassigned_manual',  -- staff moved it to someone else
  'reassigned_auto',    -- contact deadline missed, moved by the scheduler
  'unassigned_manual',  -- staff returned it to the unassigned pool
  'auto_no_candidate',  -- deadline missed and nobody eligible: moved to attention queue
  'lead_merged'         -- lead merged into another lead
);
create type public.lead_source as enum (
  'event', 'public_place', 'referral', 'workshop', 'satsang', 'online', 'other'
);
create type public.session_mode as enum ('in_person', 'online', 'hybrid');
create type public.session_status as enum ('scheduled', 'cancelled', 'completed');
create type public.follow_up_status as enum ('open', 'done', 'cancelled');

-- E.164 phone numbers, normalised by clients (packages/shared/src/phone.ts).
create domain public.e164 as text check (value ~ '^\+[1-9][0-9]{6,14}$');
create domain public.http_url as text check (value ~* '^https?://[^\s]+$');

create function private.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(btrim(name)) between 1 and 120),
  timezone    text not null default 'Asia/Kolkata',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.org_settings (
  id                        boolean primary key default true check (id),
  org_name                  text not null default 'Volunteer CRM',
  default_timezone          text not null default 'Asia/Kolkata',
  default_phone_country     text not null default 'IN' check (default_phone_country ~ '^[A-Z]{2}$'),
  contact_deadline_hours    integer not null default 24 check (contact_deadline_hours between 1 and 168),
  auto_reassign_enabled     boolean not null default true,
  max_auto_reassignments    integer not null default 3 check (max_auto_reassignments between 0 and 20),
  default_max_open_leads    integer check (default_max_open_leads is null or default_max_open_leads >= 0),
  follow_up_reminder_minutes integer not null default 60 check (follow_up_reminder_minutes between 0 and 1440),
  branding                  jsonb not null default '{}'::jsonb,
  updated_at                timestamptz not null default now(),
  updated_by                uuid
);
insert into public.org_settings default values;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                uuid primary key references auth.users (id) on delete restrict,
  full_name         text not null default '' check (length(full_name) <= 200),
  email             text,
  phone             public.e164,
  role              public.app_role not null default 'volunteer',
  status            public.account_status not null default 'active',
  team_id           uuid references public.teams (id),
  accepting_leads   boolean not null default true,  -- volunteer availability / opt-out
  max_open_leads    integer check (max_open_leads is null or max_open_leads >= 0),
  default_course_id uuid,                            -- FK added after courses
  timezone          text,
  last_login_at     timestamptz,
  last_seen_at      timestamptz,
  deactivated_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index profiles_team_role_idx on public.profiles (team_id, role) where status = 'active';
create index profiles_email_idx on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------
create table public.courses (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(btrim(name)) between 1 and 200),
  short_description text check (length(short_description) <= 500),
  details           text,
  target_audience   text,
  registration_url  public.http_url,
  category          text,
  is_active         boolean not null default true,
  team_id           uuid references public.teams (id),   -- null = organisation-wide
  created_by        uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index courses_active_idx on public.courses (is_active, name);

alter table public.profiles
  add constraint profiles_default_course_fk
  foreign key (default_course_id) references public.courses (id) on delete set null;

create table public.course_sessions (
  id               uuid primary key default gen_random_uuid(),
  course_id        uuid not null references public.courses (id),
  title            text check (length(title) <= 200),       -- optional override of course name
  description      text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  timezone         text not null default 'Asia/Kolkata',     -- for display of local schedule
  schedule_note    text,                                     -- e.g. "Daily 6–8 pm"
  mode             public.session_mode not null default 'in_person',
  venue            text,
  city             text,
  meeting_url      public.http_url,
  registration_url public.http_url,                          -- overrides course link
  instructor_id    uuid references public.profiles (id),
  instructor_name  text,
  status           public.session_status not null default 'scheduled',
  poster_path      text,                                     -- storage object path
  instructions     text,
  team_id          uuid references public.teams (id),
  created_by       uuid references public.profiles (id),
  cancelled_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint course_sessions_time_order check (ends_at > starts_at)
);
create index course_sessions_upcoming_idx on public.course_sessions (starts_at) where status = 'scheduled';
create index course_sessions_course_idx on public.course_sessions (course_id);

create table public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  body        text not null check (length(body) between 1 and 4000),
  course_id   uuid references public.courses (id),
  team_id     uuid references public.teams (id),
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- At most one active default template per course (null course = generic default).
create unique index message_templates_one_default_idx
  on public.message_templates (coalesce(course_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_default and is_active;

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table public.lead_statuses (
  code           text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  label          text not null,
  description    text,
  sort_order     integer not null default 100,
  is_closed      boolean not null default false,  -- outcome reached: no auto-reassignment
  blocks_contact boolean not null default false,  -- Do Not Contact: calls/follow-ups refused
  is_system      boolean not null default false,  -- referenced by code; cannot be deactivated
  is_active      boolean not null default true,
  color          text
);

insert into public.lead_statuses (code, label, sort_order, is_closed, blocks_contact, is_system) values
  ('new',                      'New',                       10, false, false, true),
  ('assigned',                 'Assigned',                  20, false, false, true),
  ('contact_pending',          'Contact Pending',           30, false, false, false),
  ('called_no_answer',         'Called — No Answer',        40, false, false, false),
  ('interested',               'Interested',                50, false, false, false),
  ('follow_up_required',       'Follow-up Required',        60, false, false, false),
  ('registration_link_shared', 'Registration Link Shared',  70, false, false, false),
  ('registered',               'Registered',                80, true,  false, false),
  ('not_interested',           'Not Interested',            90, true,  false, false),
  ('invalid_number',           'Invalid Number',           100, true,  false, false),
  ('do_not_contact',           'Do Not Contact',           110, true,  true,  true),
  ('converted',                'Converted / Course Attended',120, true, false, false);

create sequence public.lead_code_seq;

create table public.leads (
  id                    uuid primary key default gen_random_uuid(),
  lead_code             text not null unique
                          default ('L-' || lpad(nextval('public.lead_code_seq')::text, 6, '0')),
  full_name             text not null check (length(btrim(full_name)) between 1 and 200),
  phone                 public.e164 not null,
  whatsapp_phone        public.e164,
  email                 text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  source                public.lead_source not null default 'other',
  source_detail         text check (length(source_detail) <= 300),  -- event / place name
  met_by_name           text check (length(met_by_name) <= 200),
  met_by_id             uuid references public.profiles (id),
  met_on                date,
  met_at_time           time,
  meeting_notes         text,
  course_id             uuid references public.courses (id),
  team_id               uuid not null references public.teams (id),
  status                text not null default 'new' references public.lead_statuses (code) on update cascade,
  -- Current assignment (denormalised; history lives in lead_assignments).
  assigned_to           uuid references public.profiles (id),
  current_assignment_id uuid,
  needs_attention       boolean not null default false,   -- overdue / unassigned queue
  -- Maintained by triggers from call_attempts / follow_ups.
  last_contact_at       timestamptz,
  next_follow_up_at     timestamptz,
  call_attempt_count    integer not null default 0,
  latest_call_outcome   public.call_outcome,
  notes                 text,
  merged_into_id        uuid references public.leads (id),
  archived_at           timestamptz,
  created_by            uuid references public.profiles (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index leads_phone_idx on public.leads (phone);
create index leads_whatsapp_idx on public.leads (whatsapp_phone) where whatsapp_phone is not null;
create index leads_team_status_idx on public.leads (team_id, status) where archived_at is null;
create index leads_assigned_idx on public.leads (assigned_to, status) where archived_at is null;
create index leads_created_idx on public.leads (created_at desc);
create index leads_follow_up_idx on public.leads (next_follow_up_at) where next_follow_up_at is not null;
create index leads_attention_idx on public.leads (team_id) where needs_attention and archived_at is null;
create index leads_name_idx on public.leads (lower(full_name) text_pattern_ops);

create table public.lead_assignments (
  id                     uuid primary key default gen_random_uuid(),
  lead_id                uuid not null references public.leads (id),
  assignee_id            uuid not null references public.profiles (id),
  assigned_by            uuid references public.profiles (id),   -- null = system scheduler
  kind                   public.assignment_kind not null,
  assigned_at            timestamptz not null default now(),
  contact_deadline_at    timestamptz not null,
  first_contact_at       timestamptz,
  ended_at               timestamptz,
  end_reason             public.assignment_end_reason,
  ended_by               uuid references public.profiles (id),
  note                   text,
  previous_assignment_id uuid references public.lead_assignments (id),
  constraint lead_assignments_end_consistent check ((ended_at is null) = (end_reason is null)),
  constraint lead_assignments_deadline_after_start check (contact_deadline_at > assigned_at)
);
-- The core concurrency guarantee: at most one open assignment per lead.
create unique index lead_assignments_one_open_idx on public.lead_assignments (lead_id) where ended_at is null;
create index lead_assignments_lead_idx on public.lead_assignments (lead_id, assigned_at desc);
create index lead_assignments_assignee_open_idx on public.lead_assignments (assignee_id) where ended_at is null;
create index lead_assignments_assignee_time_idx on public.lead_assignments (assignee_id, assigned_at desc);
create index lead_assignments_overdue_idx on public.lead_assignments (contact_deadline_at)
  where ended_at is null and first_contact_at is null;

alter table public.leads
  add constraint leads_current_assignment_fk
  foreign key (current_assignment_id) references public.lead_assignments (id);

create table public.call_attempts (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.leads (id),
  assignment_id    uuid references public.lead_assignments (id),
  caller_id        uuid references public.profiles (id),
  outcome          public.call_outcome not null,
  notes            text check (length(notes) <= 4000),
  duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 86400),
  attempted_at     timestamptz not null default now(),          -- server time
  source           text not null default 'manual' check (source in ('manual', 'telephony')),
  provider         text,
  provider_call_id text,
  created_at       timestamptz not null default now(),
  constraint call_attempts_provider_unique unique (provider, provider_call_id)
);
create index call_attempts_lead_idx on public.call_attempts (lead_id, attempted_at desc);
create index call_attempts_caller_idx on public.call_attempts (caller_id, attempted_at desc);
create index call_attempts_assignment_idx on public.call_attempts (assignment_id);

create table public.lead_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads (id),
  author_id  uuid references public.profiles (id),
  body       text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index lead_notes_lead_idx on public.lead_notes (lead_id, created_at desc);

create table public.follow_ups (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.leads (id),
  owner_id         uuid references public.profiles (id),
  due_at           timestamptz not null,
  note             text check (length(note) <= 2000),
  status           public.follow_up_status not null default 'open',
  completed_at     timestamptz,
  completed_by     uuid references public.profiles (id),
  reminder_sent_at timestamptz,
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now()
);
create index follow_ups_lead_idx on public.follow_ups (lead_id, due_at) where status = 'open';
create index follow_ups_owner_idx on public.follow_ups (owner_id, due_at) where status = 'open';
create index follow_ups_reminder_idx on public.follow_ups (due_at) where status = 'open' and reminder_sent_at is null;

create table public.lead_activities (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references public.leads (id),
  actor_id   uuid references public.profiles (id),          -- null = system
  type       text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index lead_activities_lead_idx on public.lead_activities (lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Notifications & audit
-- ---------------------------------------------------------------------------
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id),
  type         text not null,
  title        text not null,          -- must not contain lead personal data (lock screens)
  body         text,
  data         jsonb not null default '{}'::jsonb,
  read_at      timestamptz,
  push_status  text not null default 'pending' check (push_status in ('pending', 'sent', 'skipped', 'failed')),
  created_at   timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index notifications_unread_idx on public.notifications (recipient_id) where read_at is null;
create index notifications_push_idx on public.notifications (created_at) where push_status = 'pending';

create table public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles (id),
  token        text not null unique,
  platform     text not null check (platform in ('ios', 'android', 'web')),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index push_tokens_profile_idx on public.push_tokens (profile_id);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles (id),
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

-- updated_at maintenance
create trigger teams_updated_at before update on public.teams
  for each row execute function private.set_updated_at();
create trigger org_settings_updated_at before update on public.org_settings
  for each row execute function private.set_updated_at();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger courses_updated_at before update on public.courses
  for each row execute function private.set_updated_at();
create trigger course_sessions_updated_at before update on public.course_sessions
  for each row execute function private.set_updated_at();
create trigger message_templates_updated_at before update on public.message_templates
  for each row execute function private.set_updated_at();
create trigger leads_updated_at before update on public.leads
  for each row execute function private.set_updated_at();
