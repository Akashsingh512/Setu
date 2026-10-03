-- Automatic assignment of leads nobody has assigned.
--
-- A lead that sits unassigned for org_settings.auto_assign_after_minutes is
-- given to an eligible volunteer of its team by the same fair rule as
-- automatic reassignment (private.pick_reassignment_candidate: accepting leads,
-- under workload cap, fewest previous holds, fewest open leads, least
-- recently assigned). Left alone:
--   * leads staff deliberately returned to the pool (last end reason
--     'unassigned_manual');
--   * leads that already used up max_auto_reassignments (attention queue);
--   * closed, archived and merged leads.
-- If no volunteer is eligible the lead is flagged needs_attention and team
-- staff are notified once; it is retried on every run.

alter type public.assignment_kind add value if not exists 'auto_assign';

-- A registered (or converted) lead is never moved by the scheduler: both
-- automatic jobs skip closed statuses, and these two can never be reopened.
alter table public.lead_statuses add constraint lead_statuses_registered_closed
  check (code not in ('registered', 'converted') or is_closed);

alter table public.org_settings
  add column auto_assign_enabled boolean not null default true,
  add column auto_assign_after_minutes integer not null default 30
    check (auto_assign_after_minutes between 0 and 1440);

grant update (auto_assign_enabled, auto_assign_after_minutes) on public.org_settings to authenticated;

create function public.process_unassigned_leads(p_limit integer default 500)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.org_settings;
  v_row record;
  v_candidate uuid;
  v_assigned integer := 0;
  v_waiting integer := 0;
  v_by_volunteer jsonb := '{}'::jsonb;   -- volunteer_id -> [lead ids]
  v_newly_stuck jsonb := '{}'::jsonb;    -- team_id -> count
  v_key text;
  v_value jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('crm.process_unassigned_leads')) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;

  select * into v_settings from public.org_settings where id;
  if not v_settings.auto_assign_enabled then
    return jsonb_build_object('skipped', true, 'reason', 'disabled');
  end if;

  for v_row in
    select l.id as lead_id, l.team_id, l.needs_attention
      from public.leads l
      join public.lead_statuses st on st.code = l.status
      left join lateral (
        select a.ended_at, a.end_reason
          from public.lead_assignments a
         where a.lead_id = l.id
         order by a.assigned_at desc
         limit 1
      ) last on true
     where l.assigned_to is null
       and l.current_assignment_id is null
       and l.archived_at is null
       and l.merged_into_id is null
       and l.team_id is not null
       and not st.is_closed
       and last.end_reason is distinct from 'unassigned_manual'
       and coalesce(last.ended_at, l.created_at) <= now() - make_interval(mins => v_settings.auto_assign_after_minutes)
       and (select count(*) from public.lead_assignments a
             where a.lead_id = l.id and a.end_reason = 'reassigned_auto') < v_settings.max_auto_reassignments
     order by l.created_at
     limit p_limit
       for update of l skip locked
  loop
    v_candidate := private.pick_reassignment_candidate(v_row.lead_id, v_row.team_id, null);

    if v_candidate is null then
      v_waiting := v_waiting + 1;
      if not v_row.needs_attention then
        update public.leads set needs_attention = true where id = v_row.lead_id;
        v_newly_stuck := v_newly_stuck || jsonb_build_object(v_row.team_id::text,
          coalesce((v_newly_stuck ->> v_row.team_id::text)::integer, 0) + 1);
      end if;
      continue;
    end if;

    perform private.reassign_lead(v_row.lead_id, v_candidate, 'auto_assign', null, null,
      'Assigned automatically: nobody assigned this lead');
    perform private.audit('lead.auto_assigned', 'lead', v_row.lead_id,
      jsonb_build_object('assignee_id', v_candidate), null);

    v_by_volunteer := v_by_volunteer || jsonb_build_object(v_candidate::text,
      coalesce(v_by_volunteer -> v_candidate::text, '[]'::jsonb) || to_jsonb(v_row.lead_id));
    v_assigned := v_assigned + 1;
  end loop;

  -- One notification per volunteer per run, however many leads they got.
  for v_key, v_value in select key, value from jsonb_each(v_by_volunteer) loop
    perform private.notify(v_key::uuid, 'lead_assigned',
      case when jsonb_array_length(v_value) = 1 then 'New lead assigned' else 'New leads assigned' end,
      format('%s new lead(s) assigned to you. Please call within %s hours.',
             jsonb_array_length(v_value), v_settings.contact_deadline_hours),
      jsonb_build_object('lead_ids', v_value, 'auto', true));
  end loop;

  -- Staff hear about a stuck lead once (when it first finds nobody), not every run.
  for v_key, v_value in select key, value from jsonb_each(v_newly_stuck) loop
    perform private.notify_team_staff(v_key::uuid, 'leads_need_attention', 'Leads need attention',
      format('%s unassigned lead(s) could not be auto-assigned: no volunteer is available or all are at their limit.', v_value),
      jsonb_build_object('team_id', v_key, 'queued', v_value));
  end loop;

  return jsonb_build_object('assigned', v_assigned, 'waiting', v_waiting);
end;
$$;

revoke all on function public.process_unassigned_leads(integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.process_unassigned_leads(integer) to service_role;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-auto-assign', '*/5 * * * *', 'select public.process_unassigned_leads()');
  end if;
end;
$$;
