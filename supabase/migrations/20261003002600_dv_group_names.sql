-- Group list reload: an empty name or description (WhatsApp often sends none right
-- after a number is linked) never replaces the one already saved.

create or replace function public.dv_sync_groups(p_groups jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.wa_groups (jid, name, description, participant_count, is_member)
  select g ->> 'jid', coalesce(g ->> 'name', ''), g ->> 'description', (g ->> 'participant_count')::integer, true
    from jsonb_array_elements(p_groups) g
  on conflict (jid) do update
     set name = coalesce(nullif(btrim(excluded.name), ''), public.wa_groups.name),
         description = coalesce(nullif(btrim(excluded.description), ''), public.wa_groups.description),
         participant_count = excluded.participant_count, is_member = true;
  get diagnostics v_count = row_count;
  -- Groups we were removed from stay configured but can no longer be used.
  -- An empty list is never applied (it would mark every group as left).
  if jsonb_array_length(p_groups) > 0 then
    update public.wa_groups set is_member = false
     where is_member and jid not in (select g ->> 'jid' from jsonb_array_elements(p_groups) g);
  end if;
  return v_count;
end;
$$;
