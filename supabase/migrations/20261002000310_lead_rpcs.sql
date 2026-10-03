-- Lead RPCs (continued from lead_workflow): contact workflow, data management,
-- user administration, personal actions, and function privileges.

-- ---------------------------------------------------------------------------
-- RPC: contact workflow
-- ---------------------------------------------------------------------------
create function private.set_lead_status(p_lead_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.lead_statuses where code = p_status and is_active) then
    raise exception 'Unknown or inactive status "%"', p_status using errcode = '22023';
  end if;
  update public.leads set status = p_status where id = p_lead_id and status is distinct from p_status;
end;
$$;

create function private.add_follow_up(p_lead public.leads, p_due_at timestamptz, p_note text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.assert_contact_allowed(p_lead.status);
  if p_due_at < now() - interval '5 minutes' then
    raise exception 'Follow-up time must be in the future' using errcode = '22023';
  end if;
  insert into public.follow_ups (lead_id, owner_id, due_at, note, created_by)
  values (p_lead.id, coalesce(p_lead.assigned_to, auth.uid()), p_due_at, nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;
  perform private.log_activity(p_lead.id, 'follow_up_scheduled',
    jsonb_build_object('follow_up_id', v_id, 'due_at', p_due_at));
  return v_id;
end;
$$;

-- Records a qualifying call attempt (server timestamp) and optionally updates
-- the status and schedules a follow-up in the same transaction.
create function public.log_call_attempt(
  p_lead_id uuid,
  p_outcome public.call_outcome,
  p_notes text default null,
  p_duration_seconds integer default null,
  p_new_status text default null,
  p_follow_up_at timestamptz default null,
  p_follow_up_note text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_lead public.leads;
  v_call_id uuid;
  v_follow_up_id uuid;
begin
  v_lead := private.lock_lead_for_action(p_lead_id);
  perform private.assert_contact_allowed(v_lead.status);

  insert into public.call_attempts (lead_id, assignment_id, caller_id, outcome, notes, duration_seconds, source)
  values (v_lead.id, v_lead.current_assignment_id, auth.uid(), p_outcome,
          nullif(btrim(p_notes), ''), p_duration_seconds, 'manual')
  returning id into v_call_id;

  if p_new_status is not null then
    perform private.set_lead_status(v_lead.id, p_new_status);
    select * into v_lead from public.leads where id = p_lead_id;
  end if;
  if p_follow_up_at is not null then
    v_follow_up_id := private.add_follow_up(v_lead, p_follow_up_at, p_follow_up_note);
  end if;

  return jsonb_strip_nulls(jsonb_build_object('call_attempt_id', v_call_id, 'follow_up_id', v_follow_up_id));
end;
$$;

create function public.update_lead_status(p_lead_id uuid, p_status text, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_lead_for_action(p_lead_id);
  perform private.set_lead_status(p_lead_id, p_status);
  if nullif(btrim(p_note), '') is not null then
    insert into public.lead_notes (lead_id, author_id, body) values (p_lead_id, auth.uid(), btrim(p_note));
  end if;
end;
$$;

create function public.schedule_follow_up(p_lead_id uuid, p_due_at timestamptz, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  return private.add_follow_up(private.lock_lead_for_action(p_lead_id), p_due_at, p_note);
end;
$$;

create function public.complete_follow_up(p_follow_up_id uuid, p_cancel boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_lead_id uuid;
begin
  select lead_id into v_lead_id from public.follow_ups where id = p_follow_up_id;
  if v_lead_id is null then
    raise exception 'Follow-up not found' using errcode = 'P0002';
  end if;
  perform private.lock_lead_for_action(v_lead_id);
  update public.follow_ups
     set status = case when p_cancel then 'cancelled'::public.follow_up_status else 'done' end,
         completed_at = now(), completed_by = auth.uid()
   where id = p_follow_up_id and status = 'open';
  if found then
    perform private.log_activity(v_lead_id,
      case when p_cancel then 'follow_up_cancelled' else 'follow_up_completed' end,
      jsonb_build_object('follow_up_id', p_follow_up_id));
  end if;
end;
$$;
