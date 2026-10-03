-- User administration and personal RPCs, plus function privileges for all
-- lead/user RPCs.

-- ---------------------------------------------------------------------------
-- RPC: user administration (account creation itself is in the admin-users edge function)
-- ---------------------------------------------------------------------------
create function public.admin_update_user(
  p_user_id uuid,
  p_role public.app_role default null,
  p_status public.account_status default null,
  p_team_id uuid default null,
  p_accepting_leads boolean default null,
  p_max_open_leads integer default null,
  p_clear_max_open_leads boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_target public.profiles;
  v_after public.profiles;
  v_is_admin boolean := private.is_super_admin();
  v_open integer;
begin
  if not private.is_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  if not v_is_admin then
    -- Teachers: volunteers in their own team; no role or team changes.
    if v_target.role <> 'volunteer' or not private.can_manage_team(v_target.team_id) then
      raise exception 'Teachers can only manage volunteers in their team' using errcode = '42501';
    end if;
    if p_role is not null or p_team_id is not null then
      raise exception 'Only super admins can change roles or teams' using errcode = '42501';
    end if;
  end if;
  if p_user_id = auth.uid() and (p_role is distinct from null and p_role <> v_target.role
                                 or p_status = 'inactive') then
    raise exception 'You cannot change your own role or deactivate yourself' using errcode = '42501';
  end if;

  update public.profiles
     set role = coalesce(p_role, role),
         status = coalesce(p_status, status),
         team_id = coalesce(p_team_id, team_id),
         accepting_leads = coalesce(p_accepting_leads, accepting_leads),
         max_open_leads = case when p_clear_max_open_leads then null
                               else coalesce(p_max_open_leads, max_open_leads) end
   where id = p_user_id
  returning * into v_after;

  perform private.audit('user.updated', 'profile', p_user_id, jsonb_build_object(
    'before', jsonb_build_object('role', v_target.role, 'status', v_target.status, 'team_id', v_target.team_id,
                                 'accepting_leads', v_target.accepting_leads, 'max_open_leads', v_target.max_open_leads),
    'after',  jsonb_build_object('role', v_after.role, 'status', v_after.status, 'team_id', v_after.team_id,
                                 'accepting_leads', v_after.accepting_leads, 'max_open_leads', v_after.max_open_leads)));

  select count(*) into v_open from public.lead_assignments where assignee_id = p_user_id and ended_at is null;
  if v_after.status = 'inactive' and v_target.status = 'active' and v_open > 0 then
    perform private.notify_team_staff(v_after.team_id, 'volunteer_deactivated_with_leads',
      'Volunteer deactivated',
      format('A deactivated volunteer still holds %s lead(s). Please reassign them.', v_open),
      jsonb_build_object('profile_id', p_user_id));
  end if;
  return jsonb_build_object('open_assignments', v_open);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: personal
-- ---------------------------------------------------------------------------
create function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_active_user();
  -- A device token belongs to whoever is signed in on it now.
  delete from public.push_tokens where token = p_token and profile_id <> auth.uid();
  insert into public.push_tokens (profile_id, token, platform)
  values (auth.uid(), p_token, p_platform)
  on conflict (token) do update set last_used_at = now();
end;
$$;

create function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.notifications set read_at = now()
   where recipient_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.touch_last_seen()
returns void
language sql security definer set search_path = '' as $$
  update public.profiles set last_seen_at = now()
   where id = auth.uid() and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on all functions in schema private from public;
grant execute on function
  private.my_role(), private.my_team_id(), private.is_super_admin(), private.is_staff(),
  private.can_manage_team(uuid), private.can_view_lead(uuid)
  to authenticated;

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.assign_leads(uuid[], uuid, text),
  public.unassign_leads(uuid[], text),
  public.log_call_attempt(uuid, public.call_outcome, text, integer, text, timestamptz, text),
  public.update_lead_status(uuid, text, text),
  public.schedule_follow_up(uuid, timestamptz, text),
  public.complete_follow_up(uuid, boolean),
  public.find_duplicate_leads(text, uuid),
  public.archive_leads(uuid[], text),
  public.merge_leads(uuid, uuid),
  public.import_leads(uuid, jsonb, boolean),
  public.log_export(text, integer, jsonb),
  public.admin_update_user(uuid, public.app_role, public.account_status, uuid, boolean, integer, boolean),
  public.register_push_token(text, text),
  public.mark_notifications_read(uuid[]),
  public.touch_last_seen()
  to authenticated;
