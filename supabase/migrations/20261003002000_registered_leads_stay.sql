-- Registered leads stay with the volunteer who registered them.
--
-- A lead whose status is Registered or Converted / Course Attended can no longer be
-- unassigned, or reassigned to someone else (which would move the credit). Bulk actions
-- skip such leads and say so; a single one is refused with a clear message. A
-- registered lead that has nobody (e.g. unassigned before this rule) can still be
-- assigned, so it can be given back.

create function private.is_registered_status(p_status text)
returns boolean
language sql immutable as $$
  select p_status in ('registered', 'converted')
$$;

create or replace function public.assign_leads(p_lead_ids uuid[], p_assignee_id uuid, p_note text default null)
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
    select l.id, l.lead_code, l.team_id, l.assigned_to, l.archived_at, l.status, s.blocks_contact
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
    elsif v_lead.assigned_to is not null and private.is_registered_status(v_lead.status) then
      -- Registered with a volunteer: the credit stays with them.
      v_skipped := v_skipped || jsonb_build_object('lead_id', v_lead.id, 'reason', 'registered');
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

create or replace function public.unassign_leads(p_lead_ids uuid[], p_note text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_lead record;
  v_done uuid[] := '{}';
  v_kept integer := 0;
  v_prev_owners uuid[] := '{}';
  v_owner uuid;
  v_count integer;
begin
  if not private.is_staff() then
    raise exception 'Only teachers and admins can unassign leads' using errcode = '42501';
  end if;
  for v_lead in
    select id, lead_code, team_id, assigned_to, status from public.leads
     where id = any(p_lead_ids) order by id for update
  loop
    if not private.can_manage_team(v_lead.team_id) then
      raise exception 'Not authorised for lead %', v_lead.lead_code using errcode = '42501';
    end if;
    continue when v_lead.assigned_to is null;
    if private.is_registered_status(v_lead.status) then
      v_kept := v_kept + 1;
      continue;
    end if;
    v_prev_owners := v_prev_owners || v_lead.assigned_to;
    perform private.reassign_lead(v_lead.id, null, 'manual', v_actor, 'unassigned_manual', p_note);
    v_done := v_done || v_lead.id;
  end loop;

  -- Only registered leads were chosen: say why nothing happened.
  if v_kept > 0 and cardinality(v_done) = 0 then
    raise exception 'Registered leads stay with the volunteer who registered them, so they can''t be unassigned'
      using errcode = '55000';
  end if;

  for v_owner, v_count in select o, count(*) from unnest(v_prev_owners) o group by o loop
    perform private.notify(v_owner, 'lead_reassigned_away', 'Leads unassigned',
      format('%s of your lead(s) were unassigned by a teacher.', v_count), '{}'::jsonb);
  end loop;
  if cardinality(v_done) > 0 then
    perform private.audit('leads.unassigned', 'lead', null,
      jsonb_build_object('lead_ids', to_jsonb(v_done), 'note', p_note));
  end if;
  return jsonb_build_object('unassigned_count', cardinality(v_done), 'unassigned_ids', to_jsonb(v_done),
                            'kept_registered', v_kept);
end;
$$;
