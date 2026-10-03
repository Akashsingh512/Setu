-- Reports: one aggregate function for the Reports page.
--
-- SECURITY INVOKER: every table read goes through the caller's RLS, so
-- teachers get their team's numbers and super admins the organisation's.
-- Counts are deliberately separate measures - assignments, call attempts,
-- unique leads contacted, registrations - and registrations are reported by
-- course, never attributed to volunteers (the data cannot show causation).

create function public.report_overview(
  p_from timestamptz,
  p_to timestamptz,
  p_team_id uuid default null,
  p_volunteer_id uuid default null,
  p_course_id uuid default null,
  p_status text default null
) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_tz text;
  v_result jsonb;
begin
  if not private.is_staff() then
    raise exception 'Reports are available to teachers and admins' using errcode = '42501';
  end if;
  if p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'Choose a date range of up to 400 days' using errcode = '22023';
  end if;
  select default_timezone into v_tz from public.org_settings where id;

  with
  lead_scope as (           -- visible leads matching the lead filters; merged duplicates excluded
    select l.id, l.full_name, l.lead_code, l.status, l.course_id, l.team_id, l.assigned_to,
           l.current_assignment_id, l.created_at
      from public.leads l
     where l.merged_into_id is null
       and (p_team_id is null or l.team_id = p_team_id)
       and (p_course_id is null or l.course_id = p_course_id)
       and (p_status is null or l.status = p_status)
  ),
  created as (
    select * from lead_scope
     where created_at >= p_from and created_at < p_to
       and (p_volunteer_id is null or assigned_to = p_volunteer_id)
  ),
  asg as (                  -- assignments that started in the range
    select a.* from public.lead_assignments a
      join lead_scope l on l.id = a.lead_id
     where a.assigned_at >= p_from and a.assigned_at < p_to
       and (p_volunteer_id is null or a.assignee_id = p_volunteer_id)
  ),
  calls as (
    select c.* from public.call_attempts c
      join lead_scope l on l.id = c.lead_id
     where c.attempted_at >= p_from and c.attempted_at < p_to
       and (p_volunteer_id is null or c.caller_id = p_volunteer_id)
  ),
  fups as (
    select f.* from public.follow_ups f
      join lead_scope l on l.id = f.lead_id
     where f.due_at >= p_from and f.due_at < p_to
       and (p_volunteer_id is null or f.owner_id = p_volunteer_id)
  ),
  regs as (                 -- leads that moved to "registered" in the range
    select distinct on (a.lead_id) a.lead_id, l.course_id
      from public.lead_activities a
      join lead_scope l on l.id = a.lead_id
     where a.type = 'status_changed' and a.data ->> 'to' = 'registered'
       and a.created_at >= p_from and a.created_at < p_to
       and (p_volunteer_id is null or l.assigned_to = p_volunteer_id)
  ),
  overdue as (
    select a.lead_id, a.assignee_id, a.contact_deadline_at, l.full_name, l.lead_code
      from public.lead_assignments a
      join lead_scope l on l.id = a.lead_id and l.current_assignment_id = a.id
     where a.ended_at is null and a.first_contact_at is null and a.contact_deadline_at < now()
       and (p_volunteer_id is null or a.assignee_id = p_volunteer_id)
  ),
  people as (               -- everyone who was assigned or called in the range
    select assignee_id as id from asg
    union
    select caller_id from calls where caller_id is not null
  ),
  days as (
    select d::date as day
      from generate_series((p_from at time zone v_tz)::date, ((p_to - interval '1 second') at time zone v_tz)::date, interval '1 day') d
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'leads_created',   (select count(*) from created),
      'assignments',     (select count(*) from asg),
      'leads_assigned',  (select count(distinct lead_id) from asg),
      'call_attempts',   (select count(*) from calls),
      'leads_contacted', (select count(distinct lead_id) from calls),
      'registrations',   (select count(*) from regs),
      'overdue_now',     (select count(*) from overdue)
    ),
    'by_volunteer', (
      select coalesce(jsonb_agg(v order by v.assigned desc, v.name), '[]'::jsonb) from (
        select pe.id as volunteer_id,
               coalesce(nullif(p.full_name, ''), p.email, 'Unknown') as name,
               p.role,
               (select count(*) from asg a where a.assignee_id = pe.id) as assigned,
               (select count(*) from asg a where a.assignee_id = pe.id
                  and a.first_contact_at is not null and a.first_contact_at <= a.contact_deadline_at) as on_time,
               (select count(*) from asg a where a.assignee_id = pe.id
                  and a.first_contact_at > a.contact_deadline_at) as late,
               (select count(*) from asg a where a.assignee_id = pe.id and a.first_contact_at is null
                  and (a.ended_at is not null or a.contact_deadline_at < now())) as missed,
               (select count(*) from asg a where a.assignee_id = pe.id and a.first_contact_at is null
                  and a.ended_at is null and a.contact_deadline_at >= now()) as pending,
               (select count(*) from asg a where a.assignee_id = pe.id
                  and a.end_reason in ('reassigned_auto', 'auto_no_candidate')) as auto_reassigned,
               (select count(*) from calls c where c.caller_id = pe.id) as attempts,
               (select count(distinct c.lead_id) from calls c where c.caller_id = pe.id) as leads_contacted,
               (select round((percentile_cont(0.5) within group (
                          order by extract(epoch from a.first_contact_at - a.assigned_at) / 3600))::numeric, 1)
                  from asg a where a.assignee_id = pe.id and a.first_contact_at is not null) as median_hours_to_first_call
          from people pe
          left join public.profiles p on p.id = pe.id
      ) v
    ),
    'outcomes', (
      select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb)
        from (select outcome, count(*) as n from calls group by outcome) o
    ),
    'follow_ups', jsonb_build_object(
      'due',           (select count(*) from fups),
      'done',          (select count(*) from fups where status = 'done'),
      'cancelled',     (select count(*) from fups where status = 'cancelled'),
      'open_overdue',  (select count(*) from fups where status = 'open' and due_at < now()),
      'open_upcoming', (select count(*) from fups where status = 'open' and due_at >= now())
    ),
    'by_course', (
      select coalesce(jsonb_agg(c order by c.leads desc, c.course), '[]'::jsonb) from (
        select coalesce(co.name, 'Not specified') as course,
               count(*) as leads,
               count(*) filter (where cr.status = 'interested') as interested,
               count(*) filter (where cr.status = 'registration_link_shared') as link_shared,
               count(*) filter (where cr.status = 'registered') as registered_now,
               count(*) filter (where cr.status = 'converted') as converted,
               (select count(*) from regs r where r.course_id is not distinct from cr.course_id) as registrations_in_range
          from created cr
          left join public.courses co on co.id = cr.course_id
         group by cr.course_id, co.name
      ) c
    ),
    'registrations_by_course', (
      select coalesce(jsonb_agg(jsonb_build_object('course', coalesce(co.name, 'Not specified'), 'registrations', n) order by n desc), '[]'::jsonb)
        from (select course_id, count(*) as n from regs group by course_id) r
        left join public.courses co on co.id = r.course_id
    ),
    'funnel', (
      select coalesce(jsonb_agg(jsonb_build_object('status', s.code, 'label', s.label, 'count', coalesce(c.n, 0))
                                order by s.sort_order), '[]'::jsonb)
        from public.lead_statuses s
        left join (select status, count(*) as n from created group by status) c on c.status = s.code
       where s.is_active or c.n > 0
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', d.day,
               'calls', coalesce(c.n, 0),
               'leads_contacted', coalesce(c.u, 0),
               'assignments', coalesce(a.n, 0),
               'leads_created', coalesce(l.n, 0)) order by d.day), '[]'::jsonb)
        from days d
        left join (select (attempted_at at time zone v_tz)::date as day, count(*) as n, count(distinct lead_id) as u
                     from calls group by 1) c on c.day = d.day
        left join (select (assigned_at at time zone v_tz)::date as day, count(*) as n from asg group by 1) a on a.day = d.day
        left join (select (created_at at time zone v_tz)::date as day, count(*) as n from created group by 1) l on l.day = d.day
    ),
    'overdue', (
      select coalesce(jsonb_agg(o order by o.hours_overdue desc), '[]'::jsonb) from (
        select od.lead_id, od.full_name, od.lead_code,
               coalesce(nullif(p.full_name, ''), p.email, 'A volunteer') as assignee,
               round((extract(epoch from now() - od.contact_deadline_at) / 3600)::numeric, 1) as hours_overdue
          from overdue od
          left join public.profiles p on p.id = od.assignee_id
         order by od.contact_deadline_at
         limit 50
      ) o
    ),
    'timezone', v_tz
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.report_overview(timestamptz, timestamptz, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.report_overview(timestamptz, timestamptz, uuid, uuid, uuid, text) to authenticated;
