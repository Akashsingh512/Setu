-- Automation: contact-deadline reassignment, follow-up reminders, session
-- expiry and session notifications. Scheduled with pg_cron (guarded so the
-- migration also runs where pg_cron/realtime are unavailable, e.g. tests).

-- ---------------------------------------------------------------------------
-- Candidate selection for automatic reassignment
-- ---------------------------------------------------------------------------
-- Eligible: active volunteer, accepting leads, same team as the lead, not the
-- current assignee, under their workload cap.
-- Preference: fewest previous holds of this lead, then fewest open
-- assignments, then least recently assigned. Deterministic tie-break on id.
create function private.pick_reassignment_candidate(p_lead_id uuid, p_team_id uuid, p_exclude uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id
    from public.profiles p
    cross join public.org_settings s
    left join lateral (
      select count(*) as open_count, max(a.assigned_at) as last_assigned_at
        from public.lead_assignments a
       where a.assignee_id = p.id and a.ended_at is null
    ) w on true
    left join lateral (
      select count(*) as prior_holds
        from public.lead_assignments a
       where a.assignee_id = p.id and a.lead_id = p_lead_id
    ) h on true
   where s.id
     and p.role = 'volunteer'
     and p.status = 'active'
     and p.accepting_leads
     and p.team_id = p_team_id
     and p.id is distinct from p_exclude
     and (coalesce(p.max_open_leads, s.default_max_open_leads) is null
          or w.open_count < coalesce(p.max_open_leads, s.default_max_open_leads))
   order by h.prior_holds, w.open_count, w.last_assigned_at nulls first, p.id
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- The contact-deadline job. Safe to run concurrently and repeatedly:
--   * a transaction-level advisory lock lets only one instance work at a time;
--   * rows are locked FOR UPDATE SKIP LOCKED, so a lead being edited by a user
--     (e.g. a call being logged right now) is simply picked up next run;
--   * conditions are re-checked under the lock;
--   * lead_assignments_one_open_idx makes a double assignment impossible.
-- ---------------------------------------------------------------------------
create function public.process_overdue_assignments(p_limit integer default 500)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.org_settings;
  v_row record;
  v_candidate uuid;
  v_auto_count integer;
  v_reassigned integer := 0;
  v_queued integer := 0;
  v_summary jsonb := '{}'::jsonb;  -- team_id -> {reassigned, queued}
  v_team_id text;
  v_counts jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('crm.process_overdue_assignments')) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;

  select * into v_settings from public.org_settings where id;
  if not v_settings.auto_reassign_enabled then
    return jsonb_build_object('skipped', true, 'reason', 'disabled');
  end if;

  for v_row in
    select a.id as assignment_id, a.assignee_id, l.id as lead_id, l.team_id
      from public.lead_assignments a
      join public.leads l on l.id = a.lead_id and l.current_assignment_id = a.id
      join public.lead_statuses st on st.code = l.status
     where a.ended_at is null
       and a.first_contact_at is null
       and a.contact_deadline_at <= now()
       and l.archived_at is null
       and not st.is_closed
     order by a.contact_deadline_at
     limit p_limit
       for update of a, l skip locked
  loop
    select count(*) into v_auto_count
      from public.lead_assignments
     where lead_id = v_row.lead_id and end_reason = 'reassigned_auto';

    v_candidate := null;
    if v_auto_count < v_settings.max_auto_reassignments then
      v_candidate := private.pick_reassignment_candidate(v_row.lead_id, v_row.team_id, v_row.assignee_id);
    end if;

    perform private.reassign_lead(
      v_row.lead_id, v_candidate, 'auto_reassign', null,
      (case when v_candidate is null then 'auto_no_candidate' else 'reassigned_auto' end)::public.assignment_end_reason,
      format('No call attempt recorded within %s hours', v_settings.contact_deadline_hours));

    perform private.notify(v_row.assignee_id, 'lead_reassigned_away', 'Lead reassigned',
      format('A lead was reassigned because no call was recorded within %s hours.',
             v_settings.contact_deadline_hours),
      jsonb_build_object('lead_id', v_row.lead_id));

    if v_candidate is not null then
      perform private.notify(v_candidate, 'lead_assigned', 'New lead assigned',
        format('A lead has been assigned to you. Please contact within %s hours.',
               v_settings.contact_deadline_hours),
        jsonb_build_object('lead_ids', jsonb_build_array(v_row.lead_id), 'auto', true));
      v_reassigned := v_reassigned + 1;
    else
      v_queued := v_queued + 1;
    end if;

    perform private.audit(
      case when v_candidate is null then 'lead.auto_unassigned' else 'lead.auto_reassigned' end,
      'lead', v_row.lead_id,
      jsonb_strip_nulls(jsonb_build_object(
        'previous_assignee_id', v_row.assignee_id, 'new_assignee_id', v_candidate,
        'previous_assignment_id', v_row.assignment_id)),
      null);

    v_counts := coalesce(v_summary -> v_row.team_id::text, '{"reassigned":0,"queued":0}'::jsonb);
    v_summary := v_summary || jsonb_build_object(v_row.team_id::text, jsonb_build_object(
      'reassigned', (v_counts ->> 'reassigned')::integer + (v_candidate is not null)::integer,
      'queued',     (v_counts ->> 'queued')::integer + (v_candidate is null)::integer));
  end loop;

  -- One summary notification per team for responsible staff.
  for v_team_id, v_counts in select key, value from jsonb_each(v_summary) loop
    perform private.notify_team_staff(v_team_id::uuid,
      case when (v_counts ->> 'queued')::integer > 0 then 'leads_need_attention' else 'leads_auto_reassigned' end,
      case when (v_counts ->> 'queued')::integer > 0 then 'Leads need attention' else 'Leads auto-reassigned' end,
      format('%s lead(s) reassigned, %s lead(s) without an eligible volunteer.',
             v_counts ->> 'reassigned', v_counts ->> 'queued'),
      v_counts || jsonb_build_object('team_id', v_team_id));
  end loop;

  return jsonb_build_object('reassigned', v_reassigned, 'queued', v_queued);
end;
$$;

-- ---------------------------------------------------------------------------
-- Follow-up reminders and session expiry
-- ---------------------------------------------------------------------------
create function public.process_follow_up_reminders()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_minutes integer;
  v_count integer;
begin
  select follow_up_reminder_minutes into v_minutes from public.org_settings where id;

  with due as (
    update public.follow_ups f
       set reminder_sent_at = now()
     where f.status = 'open'
       and f.reminder_sent_at is null
       and f.owner_id is not null
       and f.due_at <= now() + make_interval(mins => v_minutes)
    returning f.id, f.lead_id, f.owner_id, f.due_at
  )
  insert into public.notifications (recipient_id, type, title, body, data)
  select d.owner_id, 'follow_up_due', 'Follow-up due',
         case when d.due_at <= now() then 'A follow-up is due now.'
              else 'You have a follow-up coming up soon.' end,
         jsonb_build_object('lead_id', d.lead_id, 'follow_up_id', d.id, 'due_at', d.due_at)
    from due d
    join public.profiles p on p.id = d.owner_id and p.status = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.complete_past_sessions()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.course_sessions set status = 'completed'
   where status = 'scheduled' and ends_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Upcoming = scheduled and not yet ended. Expired sessions never show here even
-- before complete_past_sessions() has run. RLS of course_sessions applies.
create view public.upcoming_sessions with (security_invoker = true) as
select s.*,
       coalesce(s.title, c.name)                        as display_title,
       coalesce(s.description, c.short_description)     as display_description,
       coalesce(s.registration_url, c.registration_url) as effective_registration_url,
       c.name                                           as course_name,
       c.category                                       as course_category,
       s.ends_at - s.starts_at                          as duration
  from public.course_sessions s
  join public.courses c on c.id = s.course_id
 where s.status = 'scheduled'
   and s.ends_at > now();

grant select on public.upcoming_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- Session notifications (new session published / schedule changed)
-- ---------------------------------------------------------------------------
create function private.course_sessions_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_title text;
  v_body text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'scheduled' or new.ends_at <= now() then
      return null;
    end if;
    v_type := 'session_published';
    v_title := 'New upcoming program';
    v_body := (select coalesce(new.title, c.name) from public.courses c where c.id = new.course_id);
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    v_type := 'session_cancelled';
    v_title := 'Program cancelled';
    v_body := (select coalesce(new.title, c.name) from public.courses c where c.id = new.course_id);
  elsif new.status = 'scheduled'
        and (new.starts_at, new.ends_at, new.venue, new.meeting_url, new.mode)
            is distinct from (old.starts_at, old.ends_at, old.venue, old.meeting_url, old.mode) then
    v_type := 'session_updated';
    v_title := 'Program schedule updated';
    v_body := (select coalesce(new.title, c.name) from public.courses c where c.id = new.course_id);
  else
    return null;
  end if;

  insert into public.notifications (recipient_id, type, title, body, data)
  select p.id, v_type, v_title, v_body, jsonb_build_object('session_id', new.id)
    from public.profiles p
   where p.status = 'active'
     and (new.team_id is null or p.team_id = new.team_id or p.role = 'super_admin')
     and p.id is distinct from auth.uid();
  return null;
end;
$$;
create trigger course_sessions_notify after insert or update on public.course_sessions
  for each row execute function private.course_sessions_notify();

-- Scheduler functions are for pg_cron / service role only.
revoke all on function public.process_overdue_assignments(integer) from public, anon, authenticated;
revoke all on function public.process_follow_up_reminders() from public, anon, authenticated;
revoke all on function public.complete_past_sessions() from public, anon, authenticated;
revoke all on function private.pick_reassignment_candidate(uuid, uuid, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.process_overdue_assignments(integer) to service_role;
    grant execute on function public.process_follow_up_reminders() to service_role;
    grant execute on function public.complete_past_sessions() to service_role;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime (Supabase): RLS-filtered change feeds for clients
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.leads, public.lead_assignments, public.call_attempts, public.follow_ups,
      public.notifications, public.courses, public.course_sessions;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- pg_cron schedules
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('crm-overdue-assignments', '*/5 * * * *',
                          'select public.process_overdue_assignments()');
    perform cron.schedule('crm-follow-up-reminders', '*/5 * * * *',
                          'select public.process_follow_up_reminders()');
    perform cron.schedule('crm-complete-past-sessions', '15 * * * *',
                          'select public.complete_past_sessions()');
  else
    raise notice 'pg_cron not available: schedule the automation functions externally';
  end if;
end;
$$;
