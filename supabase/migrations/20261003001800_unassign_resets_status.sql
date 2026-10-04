-- Unassigning a lead puts its status back from "Assigned" to "New".
--
-- Assigning moves New -> Assigned automatically, but losing the volunteer (manual
-- unassign, no candidate for auto-reassignment, an undone seva request) left the
-- lead showing "Assigned" with nobody holding it. Only the automatic "Assigned"
-- status is reverted; anything a person chose (Interested, Registered, ...) stays.

create or replace function private.reassign_lead(
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
         status = case
                    when p_new_assignee is not null and status = 'new' then 'assigned'
                    when p_new_assignee is null and status = 'assigned' then 'new'
                    else status end
   where id = p_lead_id;

  -- Open follow-ups travel with the lead.
  update public.follow_ups
     set owner_id = p_new_assignee
   where lead_id = p_lead_id and status = 'open'
     and owner_id is not distinct from v_prev.assignee_id;

  return v_new_id;
end;
$$;

-- Leads already left "Assigned" with nobody holding them.
update public.leads set status = 'new'
 where status = 'assigned' and assigned_to is null;
