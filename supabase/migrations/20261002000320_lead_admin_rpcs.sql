-- Lead RPCs (continued): data management, user administration, personal
-- actions, and function privileges.

-- ---------------------------------------------------------------------------
-- RPC: lead data management (staff)
-- ---------------------------------------------------------------------------
-- Returns how many leads org-wide share the number, but details only for
-- leads the caller can see (no cross-team data leak).
create function public.find_duplicate_leads(p_phone text, p_exclude_lead_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_total integer;
  v_visible jsonb;
begin
  if not private.is_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  select count(*) into v_total from public.leads l
   where (l.phone = p_phone or l.whatsapp_phone = p_phone)
     and l.archived_at is null and l.id is distinct from p_exclude_lead_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'lead_code', l.lead_code, 'full_name', l.full_name,
           'status', l.status, 'assigned_to', l.assigned_to, 'created_at', l.created_at)
           order by l.created_at), '[]'::jsonb)
    into v_visible
    from public.leads l
   where (l.phone = p_phone or l.whatsapp_phone = p_phone)
     and l.archived_at is null and l.id is distinct from p_exclude_lead_id
     and private.can_manage_team(l.team_id);
  return jsonb_build_object('total', v_total, 'visible', v_visible);
end;
$$;

create function public.archive_leads(p_lead_ids uuid[], p_reason text default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_lead record;
  v_count integer := 0;
begin
  if not private.is_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  for v_lead in select id, lead_code, team_id, assigned_to, archived_at from public.leads
                 where id = any(p_lead_ids) order by id for update loop
    if not private.can_manage_team(v_lead.team_id) then
      raise exception 'Not authorised for lead %', v_lead.lead_code using errcode = '42501';
    end if;
    continue when v_lead.archived_at is not null;
    if v_lead.assigned_to is not null then
      perform private.reassign_lead(v_lead.id, null, 'manual', auth.uid(), 'unassigned_manual', p_reason);
    end if;
    update public.follow_ups set status = 'cancelled', completed_at = now(), completed_by = auth.uid()
     where lead_id = v_lead.id and status = 'open';
    update public.leads set archived_at = now(), needs_attention = false where id = v_lead.id;
    perform private.log_activity(v_lead.id, 'archived', jsonb_build_object('reason', p_reason));
    v_count := v_count + 1;
  end loop;
  perform private.audit('leads.archived', 'lead', null,
    jsonb_build_object('lead_ids', to_jsonb(p_lead_ids), 'reason', p_reason));
  return v_count;
end;
$$;

-- Merge p_duplicate_id into p_keep_id. History stays attached to the duplicate
-- (append-only) and is shown on the kept lead via merged_into_id.
create function public.merge_leads(p_keep_id uuid, p_duplicate_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_keep public.leads;
  v_dup public.leads;
begin
  if not private.is_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_keep_id = p_duplicate_id then
    raise exception 'Cannot merge a lead into itself' using errcode = '22023';
  end if;
  perform 1 from public.leads where id in (p_keep_id, p_duplicate_id) order by id for update;
  select * into v_keep from public.leads where id = p_keep_id;
  select * into v_dup from public.leads where id = p_duplicate_id;
  if v_keep.id is null or v_dup.id is null then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  if not (private.can_manage_team(v_keep.team_id) and private.can_manage_team(v_dup.team_id)) then
    raise exception 'Not authorised for both leads' using errcode = '42501';
  end if;
  if v_keep.archived_at is not null or v_dup.archived_at is not null then
    raise exception 'Archived leads cannot be merged' using errcode = '22023';
  end if;

  if v_dup.assigned_to is not null then
    perform private.reassign_lead(v_dup.id, null, 'manual', auth.uid(), 'lead_merged', null);
  end if;
  update public.follow_ups set lead_id = v_keep.id, owner_id = coalesce(v_keep.assigned_to, owner_id)
   where lead_id = v_dup.id and status = 'open';

  update public.leads k
     set whatsapp_phone = coalesce(k.whatsapp_phone, nullif(v_dup.whatsapp_phone, k.phone),
                                   nullif(v_dup.phone, k.phone)),
         email          = coalesce(k.email, v_dup.email),
         course_id      = coalesce(k.course_id, v_dup.course_id),
         meeting_notes  = concat_ws(E'\n\n', k.meeting_notes, v_dup.meeting_notes),
         notes          = concat_ws(E'\n\n', k.notes, v_dup.notes),
         call_attempt_count = k.call_attempt_count + v_dup.call_attempt_count,
         last_contact_at = greatest(k.last_contact_at, v_dup.last_contact_at)
   where k.id = v_keep.id;

  update public.leads set merged_into_id = v_keep.id, archived_at = now(), needs_attention = false
   where id = v_dup.id;

  perform private.log_activity(v_keep.id, 'merged', jsonb_build_object('merged_lead_id', v_dup.id, 'merged_lead_code', v_dup.lead_code));
  perform private.log_activity(v_dup.id, 'merged_into', jsonb_build_object('lead_id', v_keep.id, 'lead_code', v_keep.lead_code));
  perform private.audit('leads.merged', 'lead', v_keep.id, jsonb_build_object('merged_lead_id', v_dup.id));
end;
$$;

-- Bulk import of pre-validated rows (phones already E.164; see packages/shared).
-- Each row is inserted in its own subtransaction so one bad row doesn't abort the batch.
create function public.import_leads(p_team_id uuid, p_rows jsonb, p_skip_duplicates boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_idx integer := 0;
  v_inserted integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_dupes jsonb := '[]'::jsonb;
  v_existing uuid;
begin
  if not private.can_manage_team(p_team_id) then
    raise exception 'Not authorised for this team' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Rows must be an array of at most 5000 items' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_idx := v_idx + 1;
    select id into v_existing from public.leads
     where (phone = v_row ->> 'phone' or whatsapp_phone = v_row ->> 'phone') and archived_at is null
     limit 1;
    if v_existing is not null then
      v_dupes := v_dupes || jsonb_build_object('row', v_idx, 'existing_lead_id', v_existing);
      continue when p_skip_duplicates;
    end if;
    begin
      insert into public.leads (full_name, phone, whatsapp_phone, email, source, source_detail,
                                met_by_name, met_on, meeting_notes, course_id, notes, team_id, created_by)
      values (v_row ->> 'full_name', v_row ->> 'phone', nullif(v_row ->> 'whatsapp_phone', ''),
              nullif(v_row ->> 'email', ''),
              coalesce(nullif(v_row ->> 'source', ''), 'other')::public.lead_source,
              nullif(v_row ->> 'source_detail', ''), nullif(v_row ->> 'met_by_name', ''),
              nullif(v_row ->> 'met_on', '')::date, nullif(v_row ->> 'meeting_notes', ''),
              nullif(v_row ->> 'course_id', '')::uuid, nullif(v_row ->> 'notes', ''),
              p_team_id, auth.uid());
      v_inserted := v_inserted + 1;
    exception when others then
      v_errors := v_errors || jsonb_build_object('row', v_idx, 'message', sqlerrm);
    end;
  end loop;

  perform private.audit('leads.imported', 'team', p_team_id,
    jsonb_build_object('inserted', v_inserted, 'errors', jsonb_array_length(v_errors),
                       'duplicates', jsonb_array_length(v_dupes)));
  return jsonb_build_object('inserted', v_inserted, 'errors', v_errors, 'duplicates', v_dupes);
end;
$$;

-- Exports are read through RLS; this records who exported what.
create function public.log_export(p_entity text, p_row_count integer, p_filters jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_staff() then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  perform private.audit('export', p_entity, null,
    jsonb_build_object('row_count', p_row_count, 'filters', p_filters));
end;
$$;
