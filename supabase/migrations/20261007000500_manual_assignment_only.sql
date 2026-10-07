-- Leads held for manual assignment.
--
-- leads.manual_assignment_only: automatic assignment (30 minutes after a lead arrives
-- unassigned) skips these leads; a person assigns them. Everything else (the 24-hour
-- rule once assigned, seva requests, allotting) works as usual.

alter table public.leads add column if not exists manual_assignment_only boolean not null default false;

do $$
declare
  v_def text := pg_get_functiondef('public.process_unassigned_leads(integer)'::regprocedure);
begin
  if position('and not l.manual_assignment_only' in v_def) = 0 then
    if position('and l.team_id is not null' in v_def) = 0 then
      raise exception 'process_unassigned_leads: expected text not found';
    end if;
    execute replace(v_def, 'and l.team_id is not null', 'and l.team_id is not null and not l.manual_assignment_only');
  end if;
end;
$$;
