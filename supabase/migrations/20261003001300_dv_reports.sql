-- Digital Volunteer, part 7: reports and audit, for people with "Reports & audit".
--
-- Both functions return counts and metadata only: no message text and no phone
-- numbers, so the permission can be given to someone who should not read chats.
-- (The audit log is otherwise visible to super admins only.)

create function public.dv_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
begin
  if not private.dv_can('view_audit') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'Choose a period of up to one year' using errcode = '22023';
  end if;
  select default_timezone into v_tz from public.org_settings where id;

  return jsonb_build_object(
    'messages', (
      select jsonb_build_object(
        'in', count(*) filter (where direction = 'in'),
        'out', count(*) filter (where direction = 'out'),
        'in_groups', count(*) filter (where direction = 'in' and group_id is not null),
        'in_direct', count(*) filter (where direction = 'in' and group_id is null),
        'needs_review', count(*) filter (where status = 'needs_review'))
        from public.wa_messages where sent_at >= p_from and sent_at < p_to),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'in', i, 'out', o) order by d)
        from (select (sent_at at time zone v_tz)::date as d,
                     count(*) filter (where direction = 'in') as i,
                     count(*) filter (where direction = 'out') as o
                from public.wa_messages where sent_at >= p_from and sent_at < p_to
               group by 1) x), '[]'::jsonb),
    'intents', coalesce((
      select jsonb_object_agg(k, n)
        from (select coalesce(intent, 'not analysed') as k, count(*) as n
                from public.wa_messages
               where direction = 'in' and sent_at >= p_from and sent_at < p_to group by 1) x), '{}'::jsonb),
    'replies', (
      select jsonb_build_object(
        'automatic', count(*) filter (where status = 'sent' and auto and approved_by is null and kind = 'reply'),
        'approved_suggestions', count(*) filter (where status = 'sent' and auto and approved_by is not null),
        'written_by_people', count(*) filter (where status = 'sent' and not auto and kind in ('reply', 'direct')),
        'seva_numbers', count(*) filter (where status = 'sent' and kind = 'seva_numbers'),
        'announcements', count(*) filter (where status = 'sent' and kind = 'announcement'),
        'failed', count(*) filter (where status = 'failed'),
        'discarded', count(*) filter (where status = 'cancelled'))
        from public.wa_outbox where created_at >= p_from and created_at < p_to),
    'seva', (
      select jsonb_build_object(
        'requests', count(*),
        'fulfilled', count(*) filter (where status = 'fulfilled'),
        'automatic', count(*) filter (where status = 'fulfilled' and auto),
        'rejected', count(*) filter (where status = 'rejected'),
        'no_leads', count(*) filter (where status = 'no_leads'),
        'pending', count(*) filter (where status = 'pending'),
        'leads_assigned', coalesce(sum(assigned_count), 0))
        from public.dv_seva_requests where created_at >= p_from and created_at < p_to),
    'announcements', coalesce((
      select jsonb_object_agg(status, n)
        from (select status, count(*) as n from public.dv_announcements
               where send_at >= p_from and send_at < p_to group by 1) x), '{}'::jsonb),
    'lead_replies', (
      select count(*) from public.lead_activities
       where type = 'whatsapp_received' and created_at >= p_from and created_at < p_to),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'in', n) order by n desc)
        from (select g.name, count(*) as n
                from public.wa_messages m join public.wa_groups g on g.id = m.group_id
               where m.direction = 'in' and m.sent_at >= p_from and m.sent_at < p_to
               group by g.id, g.name order by n desc limit 10) x), '[]'::jsonb)
  );
end;
$$;

-- Digital Volunteer audit entries, newest first, with the actor's name.
create function public.dv_audit_log(p_limit integer default 100, p_before bigint default null)
returns table (id bigint, created_at timestamptz, actor_name text, action text, entity_type text, entity_id uuid, data jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.dv_can('view_audit') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
  select a.id, a.created_at, coalesce(p.full_name, case when a.actor_id is null then 'System' else 'Someone' end),
         a.action, a.entity_type, a.entity_id, a.data
    from public.audit_logs a
    left join public.profiles p on p.id = a.actor_id
   where a.action like 'dv.%' and (p_before is null or a.id < p_before)
   order by a.id desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function public.dv_report(timestamptz, timestamptz) from public, anon;
revoke all on function public.dv_audit_log(integer, bigint) from public, anon;
grant execute on function public.dv_report(timestamptz, timestamptz), public.dv_audit_log(integer, bigint) to authenticated;
