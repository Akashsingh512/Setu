-- Leads captured offline.
--
-- The "Add lead (works offline)" page saves leads on the phone and sends them when
-- the internet is back (add_lead_from_device). Each one carries an id made on the
-- phone (client_ref), so a send that is retried after a dropped connection never
-- creates the lead twice: the second call just returns the lead already made.
--
-- The rules are the same as adding a lead online, for everyone:
--   * volunteers: own team, "met by" them, optionally assigned to themselves,
--     at most 50 a day, an existing number is not added again (staff are told);
--   * teachers / admins: a team they manage (their own by default), left
--     unassigned; an existing number is reported back instead of being added.
-- volunteer_add_lead (online form) now shares the same code.

alter table public.leads add column client_ref uuid unique;  -- not in any client grant: set only here

create function private.add_lead_core(p_lead jsonb, p_assign_to_me boolean, p_client_ref uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_volunteer boolean;
  v_team uuid;
  v_phone text := p_lead ->> 'phone';
  v_wa text := nullif(p_lead ->> 'whatsapp_phone', '');
  v_existing public.leads;
  v_id uuid;
  v_code text;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null or v_me.status <> 'active' then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  v_volunteer := v_me.role = 'volunteer';

  -- Already sent (a retry after a dropped connection): report the lead made the first time.
  if p_client_ref is not null then
    select id, lead_code into v_id, v_code from public.leads where client_ref = p_client_ref;
    if v_id is not null then
      return jsonb_build_object('id', v_id, 'lead_code', v_code, 'already_synced', true,
        'assigned_to_me', exists (select 1 from public.leads where id = v_id and assigned_to = v_me.id));
    end if;
  end if;

  if v_volunteer then
    v_team := v_me.team_id;
    if v_team is null then
      raise exception 'You are not in a team yet. Ask your teacher to add you to one' using errcode = '55000';
    end if;
    if (select count(*) from public.leads where created_by = v_me.id and created_at > now() - interval '1 day') >= 50 then
      raise exception 'You have added 50 leads today. Please ask your teacher to import the rest' using errcode = '54000';
    end if;
  else
    v_team := coalesce(nullif(p_lead ->> 'team_id', '')::uuid, v_me.team_id);
    if v_team is null then
      raise exception 'Choose a team for this lead' using errcode = '22023';
    end if;
    if not private.can_manage_team(v_team) then
      raise exception 'You cannot add leads to that team' using errcode = '42501';
    end if;
  end if;

  if coalesce(btrim(p_lead ->> 'full_name'), '') = '' then
    raise exception 'Name is required' using errcode = '22023';
  end if;
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Enter a valid mobile number' using errcode = '22023';
  end if;

  select * into v_existing from public.leads
   where (phone in (v_phone, v_wa) or whatsapp_phone in (v_phone, v_wa))
     and archived_at is null and merged_into_id is null
   order by created_at limit 1;
  if v_existing.id is not null then
    if v_volunteer then
      perform private.notify_team_staff(v_team, 'lead_duplicate_by_volunteer', 'Volunteer met an existing lead',
        'A volunteer tried to add someone who is already in Setu. Check whether they should follow up.',
        jsonb_build_object('lead_id', v_existing.id, 'volunteer_id', v_me.id));
      perform private.audit('lead.volunteer_duplicate', 'lead', v_existing.id, jsonb_build_object('volunteer_id', v_me.id));
      return jsonb_build_object('duplicate', true);
    end if;
    -- Staff may open the existing lead if it is in their scope.
    return jsonb_strip_nulls(jsonb_build_object('duplicate', true,
      'lead_id', case when private.can_manage_team(v_existing.team_id) then v_existing.id end,
      'lead_code', case when private.can_manage_team(v_existing.team_id) then v_existing.lead_code end));
  end if;

  begin
    insert into public.leads (full_name, phone, whatsapp_phone, email, source, source_detail, met_by_name, met_by_id,
                              met_on, met_at_time, meeting_notes, course_id, team_id, notes, client_ref)
    values (btrim(p_lead ->> 'full_name'), v_phone, v_wa, nullif(p_lead ->> 'email', ''),
            coalesce(nullif(p_lead ->> 'source', ''), 'other')::public.lead_source, nullif(p_lead ->> 'source_detail', ''),
            coalesce(nullif(p_lead ->> 'met_by_name', ''), v_me.full_name), v_me.id,
            nullif(p_lead ->> 'met_on', '')::date, nullif(p_lead ->> 'met_at_time', '')::time,
            nullif(p_lead ->> 'meeting_notes', ''), nullif(p_lead ->> 'course_id', '')::uuid, v_team,
            nullif(p_lead ->> 'notes', ''), p_client_ref)
    returning id, lead_code into v_id, v_code;
  exception when unique_violation then
    -- The same send arrived twice at the same moment: the other one made it.
    select id, lead_code into v_id, v_code from public.leads where client_ref = p_client_ref;
    if v_id is null then
      raise;
    end if;
    return jsonb_build_object('id', v_id, 'lead_code', v_code, 'already_synced', true, 'assigned_to_me', false);
  end;

  if v_volunteer and p_assign_to_me then
    perform private.reassign_lead(v_id, v_me.id, 'manual', v_me.id, null, 'Added by the volunteer who met them');
  elsif v_volunteer then
    perform private.notify_team_staff(v_team, 'lead_added_by_volunteer', 'New lead from a volunteer',
      'A volunteer added a lead for the team to follow up.', jsonb_build_object('lead_id', v_id));
  end if;
  perform private.audit(case when v_volunteer then 'lead.volunteer_added' else 'lead.added_from_device' end, 'lead', v_id,
    jsonb_build_object('assigned_to_self', v_volunteer and p_assign_to_me, 'offline', p_client_ref is not null));
  return jsonb_build_object('id', v_id, 'lead_code', v_code, 'assigned_to_me', v_volunteer and p_assign_to_me);
end;
$$;

create or replace function public.volunteer_add_lead(p_lead jsonb, p_assign_to_me boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'volunteer' and status = 'active') then
    raise exception 'Only active volunteers can add leads this way' using errcode = '42501';
  end if;
  return private.add_lead_core(p_lead, p_assign_to_me, null);
end;
$$;

create function public.add_lead_from_device(p_client_ref uuid, p_lead jsonb, p_assign_to_me boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_client_ref is null then
    raise exception 'Missing device reference' using errcode = '22023';
  end if;
  return private.add_lead_core(p_lead, p_assign_to_me, p_client_ref);
end;
$$;

revoke all on function public.add_lead_from_device(uuid, jsonb, boolean) from public, anon;
grant execute on function public.add_lead_from_device(uuid, jsonb, boolean) to authenticated;
