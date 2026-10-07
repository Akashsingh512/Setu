-- Bulk messages: read like a person wrote them, and send only on chosen days.
--
--   * No "Reply STOP…" line any more (it made messages look automated). People who
--     reply STOP on their own are still put on the do-not-message list.
--   * send_days: the weekdays a bulk message may go out (1 = Monday … 7 = Sunday,
--     in the organisation's time zone); empty = every day. Together with the start
--     time and the sending hours this is the schedule.

alter table public.dv_bulk_campaigns alter column add_stop_line set default false;
update public.dv_bulk_campaigns set add_stop_line = false where status in ('scheduled', 'sending', 'paused');
alter table public.dv_bulk_campaigns
  add column send_days smallint[] check (send_days is null or (cardinality(send_days) between 1 and 7 and send_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]));

create or replace function private.dv_bulk_fit(c public.dv_bulk_campaigns, p_ts timestamptz, p_tz text)
returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ts timestamptz := p_ts;
  v_local timestamp;
  v_day_start timestamptz;
  i integer;
begin
  for i in 1..21 loop
    v_local := v_ts at time zone p_tz;
    -- Not a sending day: the start of the next day's sending hours.
    if c.send_days is not null and not (extract(isodow from v_local)::smallint = any (c.send_days)) then
      v_ts := ((v_local::date + 1) + coalesce(c.window_start, time '00:00')) at time zone p_tz;
      continue;
    end if;
    if c.window_start is not null then
      if v_local::time < c.window_start then
        v_ts := (v_local::date + c.window_start) at time zone p_tz;
      elsif v_local::time >= c.window_end then
        v_ts := ((v_local::date + 1) + c.window_start) at time zone p_tz;
        continue;
      end if;
    end if;
    v_day_start := ((v_ts at time zone p_tz)::date)::timestamp at time zone p_tz;
    if (select count(*) from public.dv_bulk_recipients r
         where r.campaign_id = c.id and r.scheduled_at >= v_day_start and r.scheduled_at < v_day_start + interval '1 day') < c.daily_cap then
      return v_ts;
    end if;
    -- Today's cap is used up: the start of tomorrow's sending hours.
    v_ts := ((v_ts at time zone p_tz)::date + 1 + coalesce(c.window_start, time '00:00')) at time zone p_tz;
  end loop;
  return v_ts;
end;
$$;

-- dv_bulk_create: store the sending days; no STOP line unless asked for.
create function private.swap_check(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_old in v_def) = 0 then
    raise exception 'Bulk schedule: "%" not found in %', p_old, p_fn;
  end if;
  execute replace(v_def, p_old, p_new);
end;
$$;

select private.swap_check('public.dv_bulk_create(jsonb,jsonb,boolean)',
  'batch_pause_min, created_by)',
  'batch_pause_min, send_days, created_by)');
select private.swap_check('public.dv_bulk_create(jsonb,jsonb,boolean)',
  'coalesce((p_campaign ->> ''batch_pause_min'')::integer, 0), auth.uid())',
  'coalesce((p_campaign ->> ''batch_pause_min'')::integer, 0),
          case when jsonb_typeof(p_campaign -> ''send_days'') = ''array'' and jsonb_array_length(p_campaign -> ''send_days'') between 1 and 6
               then (select array_agg(distinct d::smallint order by d::smallint) from jsonb_array_elements_text(p_campaign -> ''send_days'') d) end,
          auth.uid())');
select private.swap_check('public.dv_bulk_create(jsonb,jsonb,boolean)',
  'coalesce((p_campaign ->> ''add_stop_line'')::boolean, true)',
  'coalesce((p_campaign ->> ''add_stop_line'')::boolean, false)');

drop function private.swap_check(regprocedure, text, text);
