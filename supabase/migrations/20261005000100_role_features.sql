-- Feature access: the super admin decides which features teachers and volunteers get.
--
-- public.role_features holds one switch per (role, feature). Super admins always
-- have every feature. The defaults below reproduce what each role could do before.
-- Every check that used to ask "is this person staff?" now asks for the feature:
--   team_leads        see and work on ALL leads of their team (drives can_manage_team)
--   add_leads         add new leads
--   import_leads      import leads from a file
--   edit_leads        edit lead details, archive and merge duplicates
--   assign_leads      assign and unassign leads
--   manage_volunteers the Volunteers page: approve sign-ups, change volunteers' settings
--   view_reports      the Reports page
--   manage_courses    create and edit courses and message templates
--   manage_programs   publish, edit, cancel and complete programs, and their posters
--   sevak_directory   the Sevak Directory
--   send_from_setu    "Send from Setu number" on a lead
-- Features that need team_leads to be useful still work on what the person can see.

create table public.role_features (
  role       public.app_role not null check (role in ('teacher', 'volunteer')),
  feature    text not null check (feature in ('team_leads', 'add_leads', 'import_leads', 'edit_leads', 'assign_leads',
                                              'manage_volunteers', 'view_reports', 'manage_courses', 'manage_programs',
                                              'sevak_directory', 'send_from_setu')),
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  primary key (role, feature)
);

insert into public.role_features (role, feature, enabled)
select r.role::public.app_role, f.feature, case r.role when 'teacher' then true else f.feature in ('add_leads', 'sevak_directory', 'send_from_setu') end
  from (values ('teacher'), ('volunteer')) r (role)
 cross join (values ('team_leads'), ('add_leads'), ('import_leads'), ('edit_leads'), ('assign_leads'), ('manage_volunteers'),
                    ('view_reports'), ('manage_courses'), ('manage_programs'), ('sevak_directory'), ('send_from_setu')) f (feature);

revoke all on public.role_features from anon, authenticated;
grant select on public.role_features to authenticated;
alter table public.role_features enable row level security;
create policy role_features_select on public.role_features for select to authenticated
  using (private.my_role() is not null);

-- Does the signed-in person have this feature?
create function private.role_can(p_feature text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.my_role()
    when 'super_admin' then true
    else coalesce((select f.enabled from public.role_features f
                    where f.role = private.my_role() and f.feature = p_feature), false)
  end
$$;
grant execute on function private.role_can(text) to authenticated;

create function public.set_role_feature(p_role public.app_role, p_feature text, p_enabled boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_super_admin() then
    raise exception 'Only super admins can change feature access' using errcode = '42501';
  end if;
  update public.role_features set enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
   where role = p_role and feature = p_feature;
  if not found then
    raise exception 'Unknown role or feature' using errcode = '22023';
  end if;
  perform private.audit('feature_access.changed', 'role_feature', null,
    jsonb_build_object('role', p_role, 'feature', p_feature, 'enabled', p_enabled));
end;
$$;
revoke all on function public.set_role_feature(public.app_role, text, boolean) from public, anon;
grant execute on function public.set_role_feature(public.app_role, text, boolean) to authenticated;

-- Team scope now follows the "team_leads" feature instead of the teacher role.
create or replace function private.can_manage_team(p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.my_role()
    when 'super_admin' then true
    else p_team_id is not null and p_team_id = private.my_team_id() and private.role_can('team_leads')
  end
$$;

-- Rewrites one check inside an existing function; fails loudly if the text is not there.
create function private.swap_check(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_old in v_def) = 0 then
    raise exception 'Feature access: "%" not found in %', p_old, p_fn;
  end if;
  execute replace(v_def, p_old, p_new);
end;
$$;

select private.swap_check('public.assign_leads(uuid[],uuid,text)', 'private.is_staff()', 'private.role_can(''assign_leads'')');
select private.swap_check('public.unassign_leads(uuid[],text)', 'private.is_staff()', 'private.role_can(''assign_leads'')');
select private.swap_check('public.archive_leads(uuid[],text)', 'private.is_staff()', 'private.role_can(''edit_leads'')');
select private.swap_check('public.merge_leads(uuid,uuid)', 'private.is_staff()', 'private.role_can(''edit_leads'')');
select private.swap_check('public.find_duplicate_leads(text,uuid)', 'private.is_staff()',
                          '(private.role_can(''add_leads'') or private.role_can(''edit_leads''))');
select private.swap_check('public.import_leads(uuid,jsonb,boolean)', 'if not private.can_manage_team(p_team_id) then',
                          'if not (private.can_manage_team(p_team_id) and private.role_can(''import_leads'')) then');
select private.swap_check('public.log_export(text,integer,jsonb)', 'private.is_staff()', 'private.role_can(''team_leads'')');
select private.swap_check('public.report_overview(timestamptz,timestamptz,uuid,uuid,uuid,text)', 'private.is_staff()',
                          'private.role_can(''view_reports'')');
select private.swap_check('public.review_registration(uuid,boolean,uuid)', 'private.is_staff()', 'private.role_can(''manage_volunteers'')');
select private.swap_check('public.admin_update_user(uuid,public.app_role,public.account_status,uuid,boolean,integer,boolean)',
                          'private.is_staff()', 'private.role_can(''manage_volunteers'')');
select private.swap_check('public.admin_update_user(uuid,public.app_role,public.account_status,uuid,boolean,integer,boolean)',
                          'not private.can_manage_team(v_target.team_id)', 'v_target.team_id is distinct from private.my_team_id()');
select private.swap_check('public.member_directory()', 'if private.my_role() is null then',
                          'if private.my_role() is null or not private.role_can(''sevak_directory'') then');
select private.swap_check('public.dv_send_lead_message(uuid,text,uuid)', 'v_lead := private.lock_lead_for_action(p_lead_id);',
                          'if not private.role_can(''send_from_setu'') then raise exception ''Sending from the Setu number is not enabled for you'' using errcode = ''42501''; end if; v_lead := private.lock_lead_for_action(p_lead_id);');
select private.swap_check('private.add_lead_core(jsonb,boolean,uuid)', 'v_volunteer := v_me.role = ''volunteer'';',
                          'if not private.role_can(''add_leads'') then raise exception ''Adding leads is not enabled for you'' using errcode = ''42501''; end if; v_volunteer := v_me.role = ''volunteer'';');

drop function private.swap_check(regprocedure, text, text);

-- Table policies: courses / message templates, programs, leads.
drop policy courses_insert on public.courses;
drop policy courses_update on public.courses;
create policy courses_insert on public.courses for insert to authenticated
  with check (private.role_can('manage_courses') and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));
create policy courses_update on public.courses for update to authenticated
  using (private.is_super_admin()
         or (private.role_can('manage_courses') and (team_id = private.my_team_id() or created_by = (select auth.uid()))))
  with check (private.role_can('manage_courses') and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));

drop policy message_templates_insert on public.message_templates;
drop policy message_templates_update on public.message_templates;
create policy message_templates_insert on public.message_templates for insert to authenticated
  with check (private.role_can('manage_courses') and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));
create policy message_templates_update on public.message_templates for update to authenticated
  using (private.is_super_admin()
         or (private.role_can('manage_courses') and (team_id = private.my_team_id() or created_by = (select auth.uid()))))
  with check (private.role_can('manage_courses') and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));

drop policy course_sessions_insert on public.course_sessions;
drop policy course_sessions_update on public.course_sessions;
create policy course_sessions_insert on public.course_sessions for insert to authenticated
  with check (private.role_can('manage_programs') and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));
create policy course_sessions_update on public.course_sessions for update to authenticated
  using (private.is_super_admin()
         or (private.role_can('manage_programs') and (team_id = private.my_team_id() or created_by = (select auth.uid()))))
  with check (private.role_can('manage_programs') and (team_id is null or private.is_super_admin() or team_id = private.my_team_id()));

drop policy leads_insert on public.leads;
drop policy leads_update on public.leads;
create policy leads_insert on public.leads for insert to authenticated
  with check (private.can_manage_team(team_id) and private.role_can('add_leads'));
create policy leads_update on public.leads for update to authenticated
  using (private.can_manage_team(team_id) and private.role_can('edit_leads'))
  with check (private.can_manage_team(team_id) and private.role_can('edit_leads'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.role_features to service_role;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute 'drop policy if exists dv_posters_programs_insert on storage.objects';
    execute $p$
      create policy dv_posters_programs_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'dv-posters' and name like 'programs/%' and private.role_can('manage_programs'))
    $p$;
  end if;
end;
$$;
