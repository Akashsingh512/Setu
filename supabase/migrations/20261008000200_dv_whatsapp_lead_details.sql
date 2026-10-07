-- Leads sent on WhatsApp (seva requests and "Allot N leads to …") can include the
-- meeting notes and the follow-up history, like assigning in Setu can.
-- Two switches in Digital Volunteer > Seva & allotting, both off by default.
-- Kept short per lead (WhatsApp messages are limited), and any WhatsApp message
-- longer than the limit is cut with "(more in Setu)" instead of failing.

alter table public.dv_seva_settings
  add column send_notes boolean not null default false,
  add column send_history boolean not null default false;

-- The extra lines for one lead ('' when both switches are off).
create function private.dv_lead_brief(p_lead_id uuid)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.dv_seva_settings;
  l public.leads;
  v_tz text;
  v_out text := '';
  x record;
begin
  select * into s from public.dv_seva_settings where id;
  if not (coalesce(s.send_notes, false) or coalesce(s.send_history, false)) then
    return '';
  end if;
  select * into l from public.leads where id = p_lead_id;
  select default_timezone into v_tz from public.org_settings where id;
  if s.send_notes then
    if l.met_on is not null or nullif(btrim(l.met_by_name), '') is not null or nullif(btrim(l.source_detail), '') is not null then
      v_out := v_out || format(E'   Met: %s\n', concat_ws(' · ', to_char(l.met_on, 'DD Mon'), nullif(btrim(l.met_by_name), ''), nullif(btrim(l.source_detail), '')));
    end if;
    if nullif(btrim(l.meeting_notes), '') is not null then
      v_out := v_out || format(E'   Notes: %s\n', left(btrim(l.meeting_notes), 200));
    end if;
  end if;
  if s.send_history then
    for x in
      select * from (
        select ca.attempted_at as at, format('Call (%s)%s', replace(ca.outcome::text, '_', ' '),
                                             case when nullif(btrim(ca.notes), '') is not null then ': ' || left(btrim(ca.notes), 90) else '' end) as what
          from public.call_attempts ca where ca.lead_id = l.id
        union all
        select n.created_at, 'Note: ' || left(btrim(n.body), 90) from public.lead_notes n where n.lead_id = l.id
        union all
        select fc.created_at, 'Comment: ' || left(btrim(fc.body), 90) from public.follow_up_comments fc where fc.lead_id = l.id
      ) h order by h.at desc limit 3
    loop
      v_out := v_out || format(E'   - %s %s\n', to_char(x.at at time zone v_tz, 'DD Mon'), x.what);
    end loop;
  end if;
  return v_out;
end;
$$;
revoke all on function private.dv_lead_brief(uuid) from public;

-- Add those lines under each lead in both WhatsApp messages.
do $$
declare
  f regprocedure;
  v_def text;
begin
  foreach f in array array['private.dv_allot_to(public.profiles,public.profiles,integer,uuid,jsonb)'::regprocedure,
                           'private.dv_seva_allocate(uuid,uuid,integer)'::regprocedure] loop
    v_def := pg_get_functiondef(f);
    if position('private.dv_lead_brief(' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, 'v_lead.lead_code);', ''))) / length('v_lead.lead_code);') <> 1 then
        raise exception 'Lead details: expected text not found in %', f;
      end if;
      execute replace(v_def, 'v_lead.lead_code);', 'v_lead.lead_code) || private.dv_lead_brief(v_lead.id);');
    end if;
  end loop;
end;
$$;

-- A WhatsApp message over the limit is cut, never refused (it would undo the assignment).
create function private.wa_outbox_fit_body() returns trigger
language plpgsql as $$
begin
  if length(new.body) > 4000 then
    new.body := left(new.body, 3970) || E'\n…(more in Setu)';
  end if;
  return new;
end;
$$;
create trigger wa_outbox_fit_body before insert or update of body on public.wa_outbox
  for each row execute function private.wa_outbox_fit_body();

create function public.dv_save_lead_details(p_notes boolean, p_history boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.dv_can('manage_integration') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.dv_seva_settings set send_notes = p_notes, send_history = p_history, updated_at = now(), updated_by = auth.uid() where id;
  perform private.audit('dv.lead_details_setting', 'dv_seva_settings', null, jsonb_build_object('notes', p_notes, 'history', p_history));
end;
$$;
revoke all on function public.dv_save_lead_details(boolean, boolean) from public, anon;
grant execute on function public.dv_save_lead_details(boolean, boolean) to authenticated;
