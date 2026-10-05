-- Deleting leads.
--
--   * Delete (archive_leads, already there) moves leads to the Deleted list: hidden
--     everywhere, unassigned, open follow-ups cancelled, history kept.
--   * restore_leads brings them back (unassigned, with their history).
--   * purge_leads ("Delete forever", super admins, only leads already in Deleted)
--     erases the lead and everything about it: assignments, calls, notes, follow-ups
--     and their comments, timeline, seva links and notifications about it. Duplicates
--     merged into it go too. WhatsApp messages stay in the chat log, unlinked.
--     The audit log keeps one entry with the lead codes, nothing personal.
-- The history tables refuse deletes; they now allow exactly this erase, signalled
-- by a setting that only purge_leads sets, for the rest of its transaction.

create or replace function private.append_only_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and tg_table_name <> 'audit_logs' and current_setting('setu.purging_leads', true) = 'on' then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create or replace function private.lead_assignments_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('setu.purging_leads', true) = 'on' then
      return old;
    end if;
    raise exception 'Assignment history cannot be deleted' using errcode = '42501';
  end if;
  if new.lead_id <> old.lead_id or new.assignee_id <> old.assignee_id
     or new.assigned_at <> old.assigned_at or new.kind <> old.kind
     or new.contact_deadline_at <> old.contact_deadline_at
     or new.assigned_by is distinct from old.assigned_by
     or (old.ended_at is not null and (new.ended_at is distinct from old.ended_at
                                       or new.end_reason is distinct from old.end_reason))
     or (old.first_contact_at is not null and new.first_contact_at is distinct from old.first_contact_at) then
    raise exception 'Assignment history is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function public.restore_leads(p_lead_ids uuid[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_lead record;
  v_count integer := 0;
begin
  if not private.role_can('edit_leads') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  for v_lead in select id, lead_code, team_id, archived_at, merged_into_id from public.leads
                 where id = any(p_lead_ids) order by id for update loop
    if not private.can_manage_team(v_lead.team_id) then
      raise exception 'Not authorised for lead %', v_lead.lead_code using errcode = '42501';
    end if;
    continue when v_lead.archived_at is null or v_lead.merged_into_id is not null;
    update public.leads set archived_at = null where id = v_lead.id;
    perform private.log_activity(v_lead.id, 'restored', '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  perform private.audit('leads.restored', 'lead', null, jsonb_build_object('lead_ids', to_jsonb(p_lead_ids), 'count', v_count));
  return v_count;
end;
$$;

create function public.purge_leads(p_lead_ids uuid[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_codes text[];
begin
  if not private.is_super_admin() then
    raise exception 'Only super admins can delete leads for ever' using errcode = '42501';
  end if;
  if exists (select 1 from public.leads where id = any(p_lead_ids) and archived_at is null) then
    raise exception 'Delete the lead first; only leads in Deleted can be erased' using errcode = '55000';
  end if;
  -- The leads, plus any duplicates that were merged into them.
  select array_agg(id), array_agg(lead_code order by lead_code) into v_ids, v_codes
    from public.leads where id = any(p_lead_ids) or merged_into_id = any(p_lead_ids);
  if v_ids is null then
    return 0;
  end if;
  perform 1 from public.leads where id = any(v_ids) for update;

  perform set_config('setu.purging_leads', 'on', true);
  update public.leads set current_assignment_id = null, merged_into_id = null where id = any(v_ids);
  delete from public.follow_up_comments where lead_id = any(v_ids);
  delete from public.follow_ups where lead_id = any(v_ids);
  delete from public.lead_notes where lead_id = any(v_ids);
  delete from public.dv_seva_request_leads where lead_id = any(v_ids);
  delete from public.call_attempts where lead_id = any(v_ids);
  delete from public.lead_assignments where lead_id = any(v_ids);
  delete from public.lead_activities where lead_id = any(v_ids);
  update public.wa_messages set lead_id = null where lead_id = any(v_ids);
  delete from public.notifications
   where data ->> 'lead_id' = any(select unnest(v_ids)::text)
      or (jsonb_typeof(data -> 'lead_ids') = 'array'
          and exists (select 1 from jsonb_array_elements_text(data -> 'lead_ids') x where x = any(select unnest(v_ids)::text)));
  delete from public.leads where id = any(v_ids);
  perform set_config('setu.purging_leads', 'off', true);

  perform private.audit('leads.purged', 'lead', null, jsonb_build_object('lead_codes', to_jsonb(v_codes), 'count', cardinality(v_ids)));
  return cardinality(v_ids);
end;
$$;

revoke all on function public.restore_leads(uuid[]), public.purge_leads(uuid[]) from public, anon;
grant execute on function public.restore_leads(uuid[]), public.purge_leads(uuid[]) to authenticated;

-- "Delete" uses the edit_leads feature already (archive_leads); nothing else changes.
