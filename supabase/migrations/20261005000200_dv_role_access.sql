-- Feature access for Digital Volunteer.
--
-- Each Digital Volunteer permission can now be switched on for a whole role
-- (teachers or volunteers) in Feature access, as role feature "dv_<permission>".
-- Per-person grants (Digital Volunteer > Operators) keep working: a person has a
-- permission when either gives it. All role switches start off, so nothing changes
-- until the super admin turns one on.

alter table public.role_features drop constraint role_features_feature_check;
alter table public.role_features add constraint role_features_feature_check check (feature in (
  'team_leads', 'add_leads', 'import_leads', 'edit_leads', 'assign_leads', 'manage_volunteers', 'view_reports',
  'manage_courses', 'manage_programs', 'sevak_directory', 'send_from_setu',
  'dv_view_messages', 'dv_reply_messages', 'dv_manage_groups', 'dv_assign_seva', 'dv_update_followups',
  'dv_manage_content', 'dv_schedule_announcements', 'dv_manage_integration', 'dv_view_audit'));

insert into public.role_features (role, feature, enabled)
select r.role::public.app_role, 'dv_' || e.permission::text, false
  from (values ('teacher'), ('volunteer')) r (role)
 cross join unnest(enum_range(null::public.dv_permission)) e (permission)
on conflict (role, feature) do nothing;

create or replace function private.dv_can(p_permission public.dv_permission)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_super_admin()
      or private.role_can('dv_' || p_permission::text)
      or exists (
        select 1
          from public.dv_operator_permissions op
          join public.profiles p on p.id = op.profile_id
         where op.profile_id = auth.uid()
           and op.permission = p_permission
           and p.status = 'active'
           and p.role in ('super_admin', 'teacher', 'volunteer'))
$$;

-- The same question about someone else (approvers, people to notify).
create or replace function private.dv_can_for(p_profile uuid, p_permission public.dv_permission)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
     where p.id = p_profile and p.status = 'active'
       and (p.role = 'super_admin'
            or exists (select 1 from public.role_features f
                        where f.role = p.role and f.feature = 'dv_' || p_permission::text and f.enabled)
            or exists (select 1 from public.dv_operator_permissions op
                        where op.profile_id = p.id and op.permission = p_permission)))
$$;

create or replace function private.dv_is_operator()
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_super_admin()
      or exists (select 1 from public.role_features f
                  where f.role = private.my_role() and f.feature like 'dv\_%' and f.enabled)
      or exists (select 1 from public.dv_operator_permissions op
                   join public.profiles p on p.id = op.profile_id
                  where op.profile_id = auth.uid() and p.status = 'active')
$$;

-- Lists of approvers and the people told about waiting seva requests now include
-- everyone who has the permission through their role.
create function private.swap_check(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_old in v_def) = 0 then
    raise exception 'Digital Volunteer access: "%" not found in %', p_old, p_fn;
  end if;
  execute replace(v_def, p_old, p_new);
end;
$$;

select private.swap_check('public.dv_approver_candidates()',
  'exists (select 1 from public.dv_operator_permissions op where op.profile_id = p.id and op.permission = ''assign_seva'')',
  'private.dv_can_for(p.id, ''assign_seva'')');
select private.swap_check('public.dv_reply_approver_candidates()',
  'exists (select 1 from public.dv_operator_permissions op where op.profile_id = p.id and op.permission = ''reply_messages'')',
  'private.dv_can_for(p.id, ''reply_messages'')');
select private.swap_check('private.dv_seva_open_request_core(uuid,integer)',
  'exists (select 1 from public.dv_operator_permissions op where op.profile_id = pr.id and op.permission = ''assign_seva'')',
  'private.dv_can_for(pr.id, ''assign_seva'')');

drop function private.swap_check(regprocedure, text, text);
