-- Digital Volunteer, part 5: lead replies on the lead timeline.
--
-- When "Log replies from leads on the lead's timeline" is ticked (WhatsApp account
-- > direct chats), a private message from a number that matches exactly one live
-- lead (dv_ingest_message links it) is written to that lead's timeline, and the
-- volunteer currently holding the lead is told.
--   * Never counted as a call: no call_attempts row, no first contact, no change to
--     the contact deadline or counters. Only a person recording a call does that.
--   * Group messages are never linked to leads, so they never reach a timeline.
--   * The notification says nothing about who wrote (it can show on a lock screen),
--     and is sent at most once per lead per 30 minutes.
-- People with the "Update follow-ups" permission can also close an open follow-up
-- from the inbox when the lead's message shows it happened (dv_confirm_followup).

create function private.dv_log_lead_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_assignee uuid;
begin
  if new.direction <> 'in' or new.lead_id is null or new.chat_jid like '%@g.us'
     or not coalesce((select dm_followup_sync from public.wa_account where id), false) then
    return null;
  end if;

  perform private.log_activity(new.lead_id, 'whatsapp_received',
    jsonb_strip_nulls(jsonb_build_object('message_id', new.id, 'preview', left(new.body, 280), 'media_type', new.media_type)),
    null);

  select assigned_to into v_assignee from public.leads where id = new.lead_id;
  if v_assignee is not null and not exists (
       select 1 from public.notifications
        where recipient_id = v_assignee and type = 'lead_whatsapp_reply'
          and data ->> 'lead_id' = new.lead_id::text and created_at > now() - interval '30 minutes') then
    perform private.notify(v_assignee, 'lead_whatsapp_reply', 'A lead messaged on WhatsApp',
      'One of your leads wrote to the organisation number. Open the lead to see it.',
      jsonb_build_object('lead_id', new.lead_id));
  end if;
  return null;
end;
$$;

create trigger wa_messages_lead_reply after insert on public.wa_messages
  for each row execute function private.dv_log_lead_reply();

-- Open follow-ups of the leads that wrote in this chat, for the inbox.
create function public.dv_followup_candidates(p_chat_jid text)
returns table (follow_up_id uuid, lead_id uuid, lead_code text, due_at timestamptz, note text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.dv_can('update_followups') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
  select f.id, f.lead_id, l.lead_code, f.due_at, f.note
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id
   where f.status = 'open'
     and f.lead_id in (select m.lead_id from public.wa_messages m
                        where m.chat_jid = p_chat_jid and m.direction = 'in' and m.lead_id is not null)
   order by f.due_at;
end;
$$;

-- Marks an open follow-up done because the lead's WhatsApp message shows it happened.
-- The message must be from that lead; this is recorded on the timeline, never as a call.
create function public.dv_confirm_followup(p_message_id uuid, p_follow_up_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_lead uuid;
begin
  if not private.dv_can('update_followups') then
    raise exception 'Not authorised to update follow-ups' using errcode = '42501';
  end if;
  select f.lead_id into v_lead
    from public.follow_ups f
    join public.wa_messages m on m.id = p_message_id and m.direction = 'in' and m.lead_id = f.lead_id
   where f.id = p_follow_up_id;
  if v_lead is null then
    raise exception 'That follow-up does not belong to the lead who sent this message' using errcode = '22023';
  end if;

  update public.follow_ups
     set status = 'done', completed_at = now(), completed_by = auth.uid()
   where id = p_follow_up_id and status = 'open';
  if not found then
    raise exception 'This follow-up was already closed' using errcode = '55000';
  end if;
  update public.wa_messages set status = 'processed' where id = p_message_id and status = 'needs_review';

  perform private.log_activity(v_lead, 'follow_up_completed',
    jsonb_build_object('follow_up_id', p_follow_up_id, 'via', 'whatsapp', 'message_id', p_message_id));
  perform private.audit('dv.followup_confirmed', 'follow_up', p_follow_up_id, jsonb_build_object('message_id', p_message_id));
end;
$$;

revoke all on function public.dv_followup_candidates(text) from public, anon;
revoke all on function public.dv_confirm_followup(uuid, uuid) from public, anon;
grant execute on function public.dv_followup_candidates(text), public.dv_confirm_followup(uuid, uuid) to authenticated;
