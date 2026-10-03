-- Lead workflow: triggers that keep history/counters consistent, and the RPCs
-- that web and mobile clients call. All RPCs are SECURITY DEFINER and perform
-- their own authorisation checks against the caller's JWT (auth.uid()).

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function private.log_activity(
  p_lead_id uuid, p_type text, p_data jsonb default '{}'::jsonb, p_actor uuid default auth.uid()
) returns void
language sql security definer set search_path = '' as $$
  insert into public.lead_activities (lead_id, actor_id, type, data)
  values (p_lead_id, p_actor, p_type, coalesce(p_data, '{}'::jsonb))
$$;

create function private.audit(
  p_action text, p_entity_type text, p_entity_id uuid, p_data jsonb default '{}'::jsonb,
  p_actor uuid default auth.uid()
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, data)
  values (p_actor, p_action, p_entity_type, p_entity_id, coalesce(p_data, '{}'::jsonb))
$$;

-- Titles/bodies must not include lead names or numbers: they can appear on lock screens.
create function private.notify(
  p_recipient uuid, p_type text, p_title text, p_body text, p_data jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (recipient_id, type, title, body, data)
  select p.id, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb)
  from public.profiles p
  where p.id = p_recipient and p.status = 'active'
$$;

create function private.notify_team_staff(
  p_team_id uuid, p_type text, p_title text, p_body text, p_data jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (recipient_id, type, title, body, data)
  select p.id, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb)
  from public.profiles p
  where p.status = 'active'
    and (p.role = 'super_admin' or (p.role = 'teacher' and p.team_id = p_team_id))
$$;

create function private.require_active_user() returns public.app_role
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role public.app_role := private.my_role();
begin
  if v_role is null then
    raise exception 'Not signed in or account inactive' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

-- Locks the lead row and checks the caller may act on it (staff in scope, or
-- the volunteer it is currently assigned to). Returns the locked row.
create function private.lock_lead_for_action(p_lead_id uuid) returns public.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_lead public.leads;
begin
  perform private.require_active_user();
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if not (private.can_manage_team(v_lead.team_id) or v_lead.assigned_to = auth.uid()) then
    -- Same message whether the lead exists elsewhere or was reassigned away.
    raise exception 'You no longer have access to this lead' using errcode = '42501';
  end if;
  if v_lead.archived_at is not null then
    raise exception 'Lead is archived' using errcode = '22023';
  end if;
  return v_lead;
end;
$$;

create function private.assert_contact_allowed(p_status text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.lead_statuses where code = p_status and blocks_contact) then
    raise exception 'This lead is marked Do Not Contact' using errcode = '22023';
  end if;
end;
$$;

-- Ends the lead's open assignment (if any) and optionally opens a new one with a
-- fresh contact deadline. Caller must hold the lead row lock.
create function private.reassign_lead(
  p_lead_id uuid,
  p_new_assignee uuid,
  p_kind public.assignment_kind,
  p_actor uuid,
  p_end_reason public.assignment_end_reason,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_current_id uuid;
  v_prev public.lead_assignments;
  v_new_id uuid;
  v_hours integer;
begin
  select current_assignment_id into v_current_id from public.leads where id = p_lead_id;

  if v_current_id is not null then
    update public.lead_assignments
       set ended_at = now(), end_reason = p_end_reason, ended_by = p_actor
     where id = v_current_id and ended_at is null
    returning * into v_prev;
  end if;

  if p_new_assignee is not null then
    select contact_deadline_hours into v_hours from public.org_settings where id;
    insert into public.lead_assignments
      (lead_id, assignee_id, assigned_by, kind, contact_deadline_at, note, previous_assignment_id)
    values
      (p_lead_id, p_new_assignee, p_actor, p_kind, now() + make_interval(hours => v_hours), p_note, v_prev.id)
    returning id into v_new_id;
  end if;

  -- Logged before the lead update so the timeline reads "assigned" then any status change.
  perform private.log_activity(
    p_lead_id,
    case when p_new_assignee is null then 'unassigned' else 'assigned' end,
    jsonb_strip_nulls(jsonb_build_object(
      'assignment_id', v_new_id,
      'assignee_id', p_new_assignee,
      'previous_assignee_id', v_prev.assignee_id,
      'kind', p_kind,
      'end_reason', case when v_prev.id is not null then p_end_reason end,
      'note', p_note)),
    p_actor);

  update public.leads
     set assigned_to = p_new_assignee,
         current_assignment_id = v_new_id,
         needs_attention = (p_new_assignee is null and p_end_reason = 'auto_no_candidate'),
         status = case when p_new_assignee is not null and status = 'new' then 'assigned' else status end
   where id = p_lead_id;

  -- Open follow-ups travel with the lead.
  update public.follow_ups
     set owner_id = p_new_assignee
   where lead_id = p_lead_id and status = 'open'
     and owner_id is not distinct from v_prev.assignee_id;

  return v_new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create function private.leads_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.lead_statuses;
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    select * into v_status from public.lead_statuses where code = new.status;
    if not v_status.is_active then
      raise exception 'Status "%" is not active', new.status using errcode = '22023';
    end if;
    if v_status.is_closed then
      new.needs_attention := false;
    end if;
  end if;
  if new.whatsapp_phone = new.phone then
    new.whatsapp_phone := null;  -- only store when different
  end if;
  return new;
end;
$$;
create trigger leads_before_write before insert or update on public.leads
  for each row execute function private.leads_before_write();

create function private.leads_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.log_activity(new.id, 'created',
    jsonb_build_object('source', new.source, 'status', new.status));
  return null;
end;
$$;
create trigger leads_after_insert after insert on public.leads
  for each row execute function private.leads_after_insert();

create function private.leads_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_changed text[];
begin
  if new.status is distinct from old.status then
    perform private.log_activity(new.id, 'status_changed',
      jsonb_build_object('from', old.status, 'to', new.status));

    if exists (select 1 from public.lead_statuses where code = new.status and blocks_contact) then
      update public.follow_ups
         set status = 'cancelled', completed_at = now(), completed_by = auth.uid()
       where lead_id = new.id and status = 'open';
      perform private.audit('lead.do_not_contact', 'lead', new.id,
        jsonb_build_object('from', old.status));
    end if;
  end if;

  -- Record which content fields staff edited (values stay in the row itself).
  select array_agg(key order by key) into v_changed
  from jsonb_each(to_jsonb(new)) n
  where key in ('full_name', 'phone', 'whatsapp_phone', 'email', 'source', 'source_detail',
                'met_by_name', 'met_by_id', 'met_on', 'met_at_time', 'meeting_notes',
                'course_id', 'team_id', 'notes')
    and n.value is distinct from (to_jsonb(old) -> key);
  if v_changed is not null then
    perform private.log_activity(new.id, 'updated', jsonb_build_object('fields', to_jsonb(v_changed)));
    if 'phone' = any(v_changed) or 'team_id' = any(v_changed) then
      perform private.audit('lead.updated', 'lead', new.id, jsonb_build_object('fields', to_jsonb(v_changed)));
    end if;
  end if;
  return null;
end;
$$;
create trigger leads_after_update after update on public.leads
  for each row execute function private.leads_after_update();

create function private.call_attempts_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assignment_id is null then
    select current_assignment_id into new.assignment_id from public.leads where id = new.lead_id;
  end if;
  if new.source = 'manual' then
    new.attempted_at := now();  -- never trust device clocks
  end if;
  new.created_at := now();
  return new;
end;
$$;
create trigger call_attempts_before_insert before insert on public.call_attempts
  for each row execute function private.call_attempts_before_insert();

create function private.call_attempts_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.leads
     set call_attempt_count = call_attempt_count + 1,
         latest_call_outcome = new.outcome,
         last_contact_at = greatest(coalesce(last_contact_at, new.attempted_at), new.attempted_at)
   where id = new.lead_id;

  -- A qualifying attempt stops the contact-deadline clock for the open assignment.
  update public.lead_assignments
     set first_contact_at = new.attempted_at
   where id = new.assignment_id and first_contact_at is null and ended_at is null;

  perform private.log_activity(new.lead_id, 'call_logged',
    jsonb_strip_nulls(jsonb_build_object(
      'call_attempt_id', new.id, 'outcome', new.outcome, 'source', new.source,
      'duration_seconds', new.duration_seconds)),
    new.caller_id);
  return null;
end;
$$;
create trigger call_attempts_after_insert after insert on public.call_attempts
  for each row execute function private.call_attempts_after_insert();

create function private.lead_notes_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.log_activity(new.lead_id, 'note_added', jsonb_build_object('note_id', new.id), new.author_id);
  return null;
end;
$$;
create trigger lead_notes_after_insert after insert on public.lead_notes
  for each row execute function private.lead_notes_after_insert();

create function private.follow_ups_sync_lead() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.leads l
     set next_follow_up_at = (select min(f.due_at) from public.follow_ups f
                              where f.lead_id = l.id and f.status = 'open')
   where l.id = new.lead_id;
  return null;
end;
$$;
create trigger follow_ups_sync_lead after insert or update on public.follow_ups
  for each row execute function private.follow_ups_sync_lead();

-- ---------------------------------------------------------------------------
-- RPC: assignment
-- ---------------------------------------------------------------------------
create function public.assign_leads(p_lead_ids uuid[], p_assignee_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_assignee public.profiles;
  v_kind public.assignment_kind;
  v_lead record;
  v_assigned uuid[] := '{}';
  v_prev_owners uuid[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_owner uuid;
  v_count integer;
begin
  if not private.is_staff() then
    raise exception 'Only teachers and admins can assign leads' using errcode = '42501';
  end if;
  p_lead_ids := array(select distinct x from unnest(p_lead_ids) x where x is not null);
  if cardinality(p_lead_ids) = 0 then
    raise exception 'No leads selected' using errcode = '22023';
  end if;
  if cardinality(p_lead_ids) > 2000 then
    raise exception 'At most 2000 leads can be assigned at once' using errcode = '22023';
  end if;

  select * into v_assignee from public.profiles where id = p_assignee_id;
  if not found or v_assignee.role <> 'volunteer' then
    raise exception 'Leads can only be assigned to volunteers' using errcode = '22023';
  end if;
  if v_assignee.status <> 'active' then
    raise exception 'Cannot assign leads to an inactive volunteer' using errcode = '22023';
  end if;
  if not private.can_manage_team(v_assignee.team_id) then
    raise exception 'Volunteer is outside your team' using errcode = '42501';
  end if;

  v_kind := case when cardinality(p_lead_ids) > 1 then 'bulk' else 'manual' end;

  -- Lock in a stable order so concurrent bulk operations cannot deadlock.
  for v_lead in
    select l.id, l.lead_code, l.team_id, l.assigned_to, l.archived_at, s.blocks_contact
      from public.leads l
      join public.lead_statuses s on s.code = l.status
     where l.id = any(p_lead_ids)
     order by l.id
       for update of l
  loop
    if not private.can_manage_team(v_lead.team_id) then
      raise exception 'Not authorised to assign lead %', v_lead.lead_code using errcode = '42501';
    end if;
    if v_lead.archived_at is not null then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_lead.id, 'reason', 'archived');
    elsif v_lead.blocks_contact then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_lead.id, 'reason', 'do_not_contact');
    elsif v_lead.assigned_to = p_assignee_id then
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_lead.id, 'reason', 'already_assigned');
    else
      if v_lead.assigned_to is not null then
        v_prev_owners := v_prev_owners || v_lead.assigned_to;
      end if;
      perform private.reassign_lead(v_lead.id, p_assignee_id, v_kind, v_actor, 'reassigned_manual', p_note);
      v_assigned := v_assigned || v_lead.id;
    end if;
  end loop;

  select v_skipped || coalesce(jsonb_agg(jsonb_build_object('lead_id', m, 'reason', 'not_found')), '[]'::jsonb)
    into v_skipped
    from unnest(p_lead_ids) m
   where not exists (select 1 from public.leads l where l.id = m);

  if cardinality(v_assigned) > 0 then
    perform private.notify(p_assignee_id, 'lead_assigned',
      case when cardinality(v_assigned) = 1 then 'New lead assigned' else 'New leads assigned' end,
      format('%s lead(s) assigned to you. Please contact within %s hours.',
             cardinality(v_assigned), (select contact_deadline_hours from public.org_settings where id)),
      jsonb_build_object('lead_ids', to_jsonb(v_assigned[1:100])));

    for v_owner, v_count in
      select o, count(*) from unnest(v_prev_owners) o where o <> p_assignee_id group by o
    loop
      perform private.notify(v_owner, 'lead_reassigned_away', 'Leads reassigned',
        format('%s of your lead(s) were reassigned by a teacher.', v_count), '{}'::jsonb);
    end loop;

    perform private.audit('leads.assigned', 'profile', p_assignee_id,
      jsonb_build_object('lead_ids', to_jsonb(v_assigned), 'kind', v_kind, 'note', p_note));
  end if;

  return jsonb_build_object(
    'assigned_count', cardinality(v_assigned),
    'assigned_ids', to_jsonb(v_assigned),
    'skipped', v_skipped);
end;
$$;

create function public.unassign_leads(p_lead_ids uuid[], p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_lead record;
  v_done uuid[] := '{}';
  v_prev_owners uuid[] := '{}';
  v_owner uuid;
  v_count integer;
begin
  if not private.is_staff() then
    raise exception 'Only teachers and admins can unassign leads' using errcode = '42501';
  end if;
  for v_lead in
    select id, lead_code, team_id, assigned_to from public.leads
     where id = any(p_lead_ids) order by id for update
  loop
    if not private.can_manage_team(v_lead.team_id) then
      raise exception 'Not authorised for lead %', v_lead.lead_code using errcode = '42501';
    end if;
    continue when v_lead.assigned_to is null;
    v_prev_owners := v_prev_owners || v_lead.assigned_to;
    perform private.reassign_lead(v_lead.id, null, 'manual', v_actor, 'unassigned_manual', p_note);
    v_done := v_done || v_lead.id;
  end loop;

  for v_owner, v_count in select o, count(*) from unnest(v_prev_owners) o group by o loop
    perform private.notify(v_owner, 'lead_reassigned_away', 'Leads unassigned',
      format('%s of your lead(s) were unassigned by a teacher.', v_count), '{}'::jsonb);
  end loop;
  if cardinality(v_done) > 0 then
    perform private.audit('leads.unassigned', 'lead', null,
      jsonb_build_object('lead_ids', to_jsonb(v_done), 'note', p_note));
  end if;
  return jsonb_build_object('unassigned_count', cardinality(v_done), 'unassigned_ids', to_jsonb(v_done));
end;
$$;
