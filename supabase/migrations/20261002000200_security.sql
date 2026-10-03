-- Security: role helpers, auth.users -> profiles sync, Row Level Security, grants.
--
-- Model:
--   * RLS is enabled on every table; nothing is readable by `anon`.
--   * Supabase's default "grant all to anon/authenticated" is revoked and replaced
--     with explicit table/column grants. System-maintained columns (assignment,
--     counters, deadlines, roles) are never client-writable.
--   * Inactive users resolve to role NULL, so every policy denies them.
--   * Multi-step business operations go through SECURITY DEFINER RPCs (next migration).

-- Do not auto-expose functions created by later migrations.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Role helpers (private schema is not exposed through the REST API)
-- ---------------------------------------------------------------------------
create function private.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
$$;

create function private.my_team_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.team_id from public.profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
$$;

create function private.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = 'super_admin', false)
$$;

create function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() in ('super_admin', 'teacher'), false)
$$;

-- Super admins manage everything; teachers manage their own team.
create function private.can_manage_team(p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.my_role()
    when 'super_admin' then true
    when 'teacher' then p_team_id is not null and p_team_id = private.my_team_id()
    else false
  end
$$;

-- Staff in scope, or the volunteer the lead is *currently* assigned to.
-- History of a merged duplicate is visible to whoever can see the kept lead.
create function private.can_view_lead(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.leads l
      left join public.leads k on k.id = l.merged_into_id
     where l.id = p_lead_id
       and private.my_role() is not null
       and (private.can_manage_team(l.team_id)
            or l.assigned_to = (select auth.uid())
            or private.can_manage_team(k.team_id)
            or k.assigned_to = (select auth.uid()))
  )
$$;

revoke all on all functions in schema private from public;
grant usage on schema private to authenticated;
grant execute on function
  private.my_role(), private.my_team_id(), private.is_super_admin(), private.is_staff(),
  private.can_manage_team(uuid), private.can_view_lead(uuid)
  to authenticated;

-- Stamp creator columns from the JWT instead of trusting the client.
create function private.set_created_by() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger courses_created_by before insert on public.courses
  for each row execute function private.set_created_by();
create trigger course_sessions_created_by before insert on public.course_sessions
  for each row execute function private.set_created_by();
create trigger message_templates_created_by before insert on public.message_templates
  for each row execute function private.set_created_by();
create trigger leads_created_by before insert on public.leads
  for each row execute function private.set_created_by();

create function private.set_note_author() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    new.author_id := auth.uid();
  end if;
  new.created_at := now();
  return new;
end;
$$;
create trigger lead_notes_author before insert on public.lead_notes
  for each row execute function private.set_note_author();

-- ---------------------------------------------------------------------------
-- auth.users -> profiles
-- Role/team come from app_metadata, which only the service role can set
-- (admin-users edge function). Self sign-up is disabled in config.toml.
-- ---------------------------------------------------------------------------
create function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, phone, role, team_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(nullif(new.raw_app_meta_data ->> 'role', '')::public.app_role, 'volunteer'),
    nullif(new.raw_app_meta_data ->> 'team_id', '')::uuid
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_auth_user();

create function private.handle_auth_user_updated() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles
     set email = new.email,
         last_login_at = coalesce(new.last_sign_in_at, last_login_at)
   where id = new.id
     and (email is distinct from new.email or last_login_at is distinct from new.last_sign_in_at);
  return new;
end;
$$;

create trigger on_auth_user_updated after update of email, last_sign_in_at on auth.users
  for each row execute function private.handle_auth_user_updated();

create function private.profiles_status_change() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.deactivated_at := case when new.status = 'inactive' then now() else null end;
  end if;
  return new;
end;
$$;
create trigger profiles_status_change before update on public.profiles
  for each row execute function private.profiles_status_change();

-- System statuses are referenced by code and must stay usable.
create function private.lead_statuses_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.is_system
     and (new.code <> old.code or not new.is_active or new.blocks_contact <> old.blocks_contact) then
    raise exception 'System status "%" cannot be renamed, deactivated or change contact blocking', old.code
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger lead_statuses_guard before update on public.lead_statuses
  for each row execute function private.lead_statuses_guard();

-- Assignment history is append-only: identity/timing columns never change.
create function private.lead_assignments_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Assignment history cannot be deleted' using errcode = '42501';
  end if;
  if new.lead_id <> old.lead_id or new.assignee_id <> old.assignee_id
     or new.assigned_at <> old.assigned_at or new.kind <> old.kind
     or new.contact_deadline_at <> old.contact_deadline_at
     or new.assigned_by is distinct from old.assigned_by
     or (old.ended_at is not null and (new.ended_at is distinct from old.ended_at
                                       or new.end_reason is distinct from old.end_reason))
     or (old.first_contact_at is not null and new.first_contact_at is distinct from old.first_contact_at) then
    raise exception 'Assignment history is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger lead_assignments_guard before update or delete on public.lead_assignments
  for each row execute function private.lead_assignments_guard();

create function private.append_only_guard() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger lead_activities_append_only before update or delete on public.lead_activities
  for each row execute function private.append_only_guard();
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function private.append_only_guard();
create trigger call_attempts_append_only before update or delete on public.call_attempts
  for each row execute function private.append_only_guard();

-- ---------------------------------------------------------------------------
-- Grants: start from nothing.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to authenticated;
grant usage on sequence public.lead_code_seq to authenticated;

grant select on public.teams to authenticated;
grant insert (name, timezone, is_active), update (name, timezone, is_active) on public.teams to authenticated;

grant select on public.org_settings to authenticated;
grant update (org_name, default_timezone, default_phone_country, contact_deadline_hours,
              auto_reassign_enabled, max_auto_reassignments, default_max_open_leads,
              follow_up_reminder_minutes, branding)
  on public.org_settings to authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, phone, default_course_id, timezone, accepting_leads) on public.profiles to authenticated;

grant select on public.lead_statuses to authenticated;
grant insert (code, label, description, sort_order, is_closed, blocks_contact, is_active, color),
      update (label, description, sort_order, is_closed, blocks_contact, is_active, color)
  on public.lead_statuses to authenticated;

grant select on public.courses to authenticated;
grant insert (name, short_description, details, target_audience, registration_url, category, is_active, team_id),
      update (name, short_description, details, target_audience, registration_url, category, is_active, team_id)
  on public.courses to authenticated;

grant select on public.course_sessions to authenticated;
grant insert (course_id, title, description, starts_at, ends_at, timezone, schedule_note, mode, venue, city,
              meeting_url, registration_url, instructor_id, instructor_name, status, poster_path,
              instructions, team_id),
      update (course_id, title, description, starts_at, ends_at, timezone, schedule_note, mode, venue, city,
              meeting_url, registration_url, instructor_id, instructor_name, status, poster_path,
              instructions, team_id)
  on public.course_sessions to authenticated;

grant select on public.message_templates to authenticated;
grant insert (name, body, course_id, team_id, is_default, is_active),
      update (name, body, course_id, team_id, is_default, is_active)
  on public.message_templates to authenticated;

grant select on public.leads to authenticated;
grant insert (full_name, phone, whatsapp_phone, email, source, source_detail, met_by_name, met_by_id,
              met_on, met_at_time, meeting_notes, course_id, team_id, status, notes),
      update (full_name, phone, whatsapp_phone, email, source, source_detail, met_by_name, met_by_id,
              met_on, met_at_time, meeting_notes, course_id, team_id, status, notes)
  on public.leads to authenticated;

grant select on public.lead_assignments to authenticated;
grant select on public.call_attempts to authenticated;
grant select on public.lead_notes to authenticated;
grant insert (lead_id, body) on public.lead_notes to authenticated;
grant select on public.follow_ups to authenticated;
grant select on public.lead_activities to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select, delete on public.push_tokens to authenticated;
grant select on public.audit_logs to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.teams             enable row level security;
alter table public.org_settings      enable row level security;
alter table public.profiles          enable row level security;
alter table public.lead_statuses     enable row level security;
alter table public.courses           enable row level security;
alter table public.course_sessions   enable row level security;
alter table public.message_templates enable row level security;
alter table public.leads             enable row level security;
alter table public.lead_assignments  enable row level security;
alter table public.call_attempts     enable row level security;
alter table public.lead_notes        enable row level security;
alter table public.follow_ups        enable row level security;
alter table public.lead_activities   enable row level security;
alter table public.notifications     enable row level security;
alter table public.push_tokens       enable row level security;
alter table public.audit_logs        enable row level security;

-- teams
create policy teams_select on public.teams for select to authenticated
  using (private.is_super_admin() or id = private.my_team_id());
create policy teams_insert on public.teams for insert to authenticated
  with check (private.is_super_admin());
create policy teams_update on public.teams for update to authenticated
  using (private.is_super_admin()) with check (private.is_super_admin());

-- org_settings
create policy org_settings_select on public.org_settings for select to authenticated
  using (private.my_role() is not null);
create policy org_settings_update on public.org_settings for update to authenticated
  using (private.is_super_admin()) with check (private.is_super_admin());

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or private.can_manage_team(team_id)
    or (private.my_role() is not null and team_id = private.my_team_id() and role <> 'volunteer')
  );
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()) and private.my_role() is not null)
  with check (id = (select auth.uid()));

-- lead_statuses
create policy lead_statuses_select on public.lead_statuses for select to authenticated
  using (private.my_role() is not null);
create policy lead_statuses_insert on public.lead_statuses for insert to authenticated
  with check (private.is_super_admin());
create policy lead_statuses_update on public.lead_statuses for update to authenticated
  using (private.is_super_admin()) with check (private.is_super_admin());

-- courses / sessions / templates: org-wide (team_id null) or team-scoped
create policy courses_select on public.courses for select to authenticated
  using (private.my_role() is not null
         and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));
create policy courses_insert on public.courses for insert to authenticated
  with check (private.is_staff() and (team_id is null or private.can_manage_team(team_id)));
create policy courses_update on public.courses for update to authenticated
  using (private.is_super_admin()
         or (private.is_staff() and (team_id = private.my_team_id() or created_by = (select auth.uid()))))
  with check (private.is_staff() and (team_id is null or private.can_manage_team(team_id)));

create policy course_sessions_select on public.course_sessions for select to authenticated
  using (private.my_role() is not null
         and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));
create policy course_sessions_insert on public.course_sessions for insert to authenticated
  with check (private.is_staff() and (team_id is null or private.can_manage_team(team_id)));
create policy course_sessions_update on public.course_sessions for update to authenticated
  using (private.is_super_admin()
         or (private.is_staff() and (team_id = private.my_team_id() or created_by = (select auth.uid()))))
  with check (private.is_staff() and (team_id is null or private.can_manage_team(team_id)));

create policy message_templates_select on public.message_templates for select to authenticated
  using (private.my_role() is not null
         and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));
create policy message_templates_insert on public.message_templates for insert to authenticated
  with check (private.is_staff() and (team_id is null or private.can_manage_team(team_id)));
create policy message_templates_update on public.message_templates for update to authenticated
  using (private.is_super_admin()
         or (private.is_staff() and (team_id = private.my_team_id() or created_by = (select auth.uid()))))
  with check (private.is_staff() and (team_id is null or private.can_manage_team(team_id)));

-- leads: staff by team; volunteers only what is currently assigned to them (read-only)
create policy leads_select on public.leads for select to authenticated
  using (
    private.can_manage_team(team_id)
    or (assigned_to = (select auth.uid()) and private.my_role() is not null)
  );
create policy leads_insert on public.leads for insert to authenticated
  with check (private.can_manage_team(team_id));
create policy leads_update on public.leads for update to authenticated
  using (private.can_manage_team(team_id))
  with check (private.can_manage_team(team_id));

-- lead children: visible with the lead; writes go through RPCs (except notes)
create policy lead_assignments_select on public.lead_assignments for select to authenticated
  using (private.can_view_lead(lead_id));
create policy call_attempts_select on public.call_attempts for select to authenticated
  using (private.can_view_lead(lead_id));
create policy lead_notes_select on public.lead_notes for select to authenticated
  using (private.can_view_lead(lead_id));
create policy lead_notes_insert on public.lead_notes for insert to authenticated
  with check (private.can_view_lead(lead_id));
create policy follow_ups_select on public.follow_ups for select to authenticated
  using (private.can_view_lead(lead_id));
create policy lead_activities_select on public.lead_activities for select to authenticated
  using (private.can_view_lead(lead_id));

-- notifications / push tokens: own rows only
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_id = (select auth.uid())) with check (recipient_id = (select auth.uid()));
create policy push_tokens_select on public.push_tokens for select to authenticated
  using (profile_id = (select auth.uid()));
create policy push_tokens_delete on public.push_tokens for delete to authenticated
  using (profile_id = (select auth.uid()));

-- audit log: super admins only
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (private.is_super_admin());
