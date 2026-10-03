-- Seva profiles and volunteer-added leads.
--
-- 1. Everyone can describe how they serve: which days and times they're free,
--    their nearest centre, an address/area, and the kinds of seva they like.
--    Each person edits only their own (column grants + profiles_update_self).
--    Other members see these through member_directory(), which returns only these
--    fields plus name, team and role: never email, phone or account details.
--
-- 2. Volunteers can add leads they met (volunteer_add_lead). Volunteers still see
--    only leads assigned to them, so:
--      * the lead goes into the volunteer's own team, "met by" them;
--      * by default it is assigned to them; otherwise it waits for their team
--        (teachers are told, and auto-assign may pick it up);
--      * a number already in Setu is never added twice: the volunteer is told it
--        exists (not whose it is) and their team's staff are notified instead;
--      * at most 50 per volunteer per day.

-- ---------------------------------------------------------------------------
-- Seva profile
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column seva_days       text[] not null default '{}'
    check (seva_days <@ array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  add column seva_times      text[] not null default '{}'
    check (seva_times <@ array['morning', 'afternoon', 'evening']),
  add column seva_note       text check (length(seva_note) <= 300),
  add column nearest_centre  text check (length(nearest_centre) <= 120),
  add column address         text check (length(address) <= 300),
  add column seva_interests  text[] not null default '{}'
    check (cardinality(seva_interests) <= 20);

-- Each interest is a short label (checked by trigger: CHECK can't look inside arrays).
create function private.profiles_seva_check() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from unnest(new.seva_interests) i where length(btrim(i)) not between 1 and 60) then
    raise exception 'Each seva interest must be 1 to 60 characters' using errcode = '22023';
  end if;
  new.seva_interests := array(select distinct btrim(i) from unnest(new.seva_interests) i order by 1);
  new.nearest_centre := nullif(btrim(new.nearest_centre), '');
  new.address := nullif(btrim(new.address), '');
  new.seva_note := nullif(btrim(new.seva_note), '');
  return new;
end;
$$;
create trigger profiles_seva_check before insert or update of seva_interests, nearest_centre, address, seva_note
  on public.profiles for each row execute function private.profiles_seva_check();

grant update (seva_days, seva_times, seva_note, nearest_centre, address, seva_interests) on public.profiles to authenticated;

-- The directory every active member can read.
create function public.member_directory()
returns table (
  id uuid, full_name text, role public.app_role, team_name text,
  seva_days text[], seva_times text[], seva_note text, nearest_centre text, address text, seva_interests text[]
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.my_role() is null then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
  select p.id, p.full_name, p.role, t.name, p.seva_days, p.seva_times, p.seva_note, p.nearest_centre, p.address, p.seva_interests
    from public.profiles p
    left join public.teams t on t.id = p.team_id
   where p.status = 'active'
   order by p.full_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Volunteers adding leads
-- ---------------------------------------------------------------------------
create function public.volunteer_add_lead(p_lead jsonb, p_assign_to_me boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_phone text := p_lead ->> 'phone';
  v_wa text := nullif(p_lead ->> 'whatsapp_phone', '');
  v_existing uuid;
  v_id uuid;
  v_code text;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null or v_me.status <> 'active' or v_me.role <> 'volunteer' then
    raise exception 'Only active volunteers can add leads this way' using errcode = '42501';
  end if;
  if v_me.team_id is null then
    raise exception 'You are not in a team yet. Ask your teacher to add you to one' using errcode = '55000';
  end if;
  if (select count(*) from public.leads where created_by = v_me.id and created_at > now() - interval '1 day') >= 50 then
    raise exception 'You have added 50 leads today. Please ask your teacher to import the rest' using errcode = '54000';
  end if;
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Enter a valid mobile number' using errcode = '22023';
  end if;

  select id into v_existing from public.leads
   where (phone in (v_phone, v_wa) or whatsapp_phone in (v_phone, v_wa))
     and archived_at is null and merged_into_id is null
   order by created_at limit 1;
  if v_existing is not null then
    perform private.notify_team_staff(v_me.team_id, 'lead_duplicate_by_volunteer', 'Volunteer met an existing lead',
      'A volunteer tried to add someone who is already in Setu. Check whether they should follow up.',
      jsonb_build_object('lead_id', v_existing, 'volunteer_id', v_me.id));
    perform private.audit('lead.volunteer_duplicate', 'lead', v_existing, jsonb_build_object('volunteer_id', v_me.id));
    return jsonb_build_object('duplicate', true);
  end if;

  insert into public.leads (full_name, phone, whatsapp_phone, email, source, source_detail, met_by_name, met_by_id,
                            met_on, met_at_time, meeting_notes, course_id, team_id, notes)
  values (btrim(p_lead ->> 'full_name'), v_phone, v_wa, nullif(p_lead ->> 'email', ''),
          coalesce(nullif(p_lead ->> 'source', ''), 'other')::public.lead_source, nullif(p_lead ->> 'source_detail', ''),
          coalesce(nullif(p_lead ->> 'met_by_name', ''), v_me.full_name), v_me.id,
          nullif(p_lead ->> 'met_on', '')::date, nullif(p_lead ->> 'met_at_time', '')::time,
          nullif(p_lead ->> 'meeting_notes', ''), nullif(p_lead ->> 'course_id', '')::uuid, v_me.team_id,
          nullif(p_lead ->> 'notes', ''))
  returning id, lead_code into v_id, v_code;

  if p_assign_to_me then
    perform private.reassign_lead(v_id, v_me.id, 'manual', v_me.id, null, 'Added by the volunteer who met them');
  else
    perform private.notify_team_staff(v_me.team_id, 'lead_added_by_volunteer', 'New lead from a volunteer',
      'A volunteer added a lead for the team to follow up.', jsonb_build_object('lead_id', v_id));
  end if;
  perform private.audit('lead.volunteer_added', 'lead', v_id, jsonb_build_object('assigned_to_self', p_assign_to_me));
  return jsonb_build_object('id', v_id, 'lead_code', v_code, 'assigned_to_me', p_assign_to_me);
end;
$$;

revoke all on function public.member_directory() from public, anon;
revoke all on function public.volunteer_add_lead(jsonb, boolean) from public, anon;
grant execute on function public.member_directory(), public.volunteer_add_lead(jsonb, boolean) to authenticated;
