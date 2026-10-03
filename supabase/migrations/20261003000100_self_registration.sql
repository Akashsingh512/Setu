-- Self-registration with approval.
--
-- * Accounts created by admins (admin-users edge function) carry a role in
--   app_metadata and are active immediately, as before.
-- * Self-registered accounts (public sign-up) have no role in app_metadata:
--   they become *pending* volunteers with status 'inactive', so every RLS
--   policy denies them data until approved.
-- * A registrant may name a recommending teacher. That teacher, or any super
--   admin, approves or rejects the registration.

alter table public.profiles
  add column approval_status text not null default 'approved'
    check (approval_status in ('approved', 'pending', 'rejected')),
  add column recommended_by uuid references public.profiles (id),
  add column approved_by uuid references public.profiles (id),
  add column approved_at timestamptz;

create index profiles_pending_idx on public.profiles (recommended_by) where approval_status = 'pending';

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 200);
  v_phone text := nullif(new.raw_user_meta_data ->> 'phone', '');
  v_rec_raw text := new.raw_user_meta_data ->> 'recommended_by';
  v_rec uuid;
  v_rec_team uuid;
begin
  -- Never let bad metadata block account creation.
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    v_phone := null;
  end if;

  if new.raw_app_meta_data ? 'role' then
    -- Created by an admin through the service role.
    insert into public.profiles (id, email, full_name, phone, role, team_id)
    values (new.id, new.email, v_name, v_phone,
            coalesce(nullif(new.raw_app_meta_data ->> 'role', '')::public.app_role, 'volunteer'),
            nullif(new.raw_app_meta_data ->> 'team_id', '')::uuid)
    on conflict (id) do nothing;
    return new;
  end if;

  -- Self-registration: pending volunteer. The recommending teacher must be active staff.
  if v_rec_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select p.id, p.team_id into v_rec, v_rec_team
      from public.profiles p
     where p.id = v_rec_raw::uuid and p.status = 'active' and p.role in ('teacher', 'super_admin');
  end if;

  insert into public.profiles (id, email, full_name, phone, role, status, team_id, approval_status, recommended_by)
  values (new.id, new.email, v_name, v_phone, 'volunteer', 'inactive', v_rec_team, 'pending', v_rec)
  on conflict (id) do nothing;

  insert into public.notifications (recipient_id, type, title, body, data)
  select p.id, 'registration_pending', 'New volunteer registration',
         case when p.id = v_rec then 'Someone named you as their recommending teacher. Please review their registration.'
              else 'A new volunteer registration is waiting for approval.' end,
         jsonb_build_object('profile_id', new.id)
    from public.profiles p
   where p.status = 'active' and (p.id = v_rec or p.role = 'super_admin');
  return new;
end;
$$;

-- Staff also see registrations that named them.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or private.can_manage_team(team_id)
    or (private.my_role() is not null and team_id = private.my_team_id() and role <> 'volunteer')
    or (recommended_by = (select auth.uid()) and private.is_staff())
  );

-- Public (pre-login) teacher search for the registration form: names and team only.
create function public.search_teachers(p_query text default '')
returns table (id uuid, full_name text, team_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, t.name
    from public.profiles p
    left join public.teams t on t.id = p.team_id
   where p.status = 'active'
     and p.role in ('teacher', 'super_admin')
     and p.full_name <> ''
     and (coalesce(btrim(p_query), '') = ''
          or p.full_name ilike '%' || replace(replace(btrim(p_query), '%', ''), '_', '') || '%')
   order by p.full_name
   limit 50
$$;

-- Approve or reject a pending registration: the recommending teacher or a super admin.
create function public.review_registration(p_user_id uuid, p_approve boolean, p_team_id uuid default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_target public.profiles;
  v_admin boolean := private.is_super_admin();
  v_team uuid;
begin
  if not private.is_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found or v_target.approval_status <> 'pending' then
    raise exception 'No pending registration found' using errcode = 'P0002';
  end if;
  if not v_admin and v_target.recommended_by is distinct from auth.uid() then
    raise exception 'Only the recommending teacher or a super admin can review this registration'
      using errcode = '42501';
  end if;

  if p_approve then
    v_team := case when v_admin then coalesce(p_team_id, v_target.team_id) else private.my_team_id() end;
    if v_team is null then
      raise exception 'Choose a team for this volunteer' using errcode = '22023';
    end if;
    update public.profiles
       set status = 'active', approval_status = 'approved', team_id = v_team,
           approved_by = auth.uid(), approved_at = now()
     where id = p_user_id;
    perform private.notify(p_user_id, 'registration_approved', 'Welcome!',
      'Your account has been approved. You can now use the CRM.', '{}'::jsonb);
  else
    update public.profiles
       set approval_status = 'rejected', approved_by = auth.uid(), approved_at = now()
     where id = p_user_id;
  end if;

  perform private.audit(case when p_approve then 'registration.approved' else 'registration.rejected' end,
    'profile', p_user_id, jsonb_build_object('team_id', v_team, 'recommended_by', v_target.recommended_by));
end;
$$;

revoke all on function public.search_teachers(text) from public;
revoke all on function public.review_registration(uuid, boolean, uuid) from public, anon;
grant execute on function public.search_teachers(text) to anon, authenticated;
grant execute on function public.review_registration(uuid, boolean, uuid) to authenticated;
