-- Push delivery for notifications.
--
-- Every notification row starts push_status = 'pending'. The dispatch-push
-- Edge Function claims pending rows (with their recipients' device tokens),
-- sends them (Web Push for browsers/installed PWA, Expo for the mobile app)
-- and reports back. It is woken by a statement trigger on notifications via
-- pg_net (async, sent after commit), with a once-a-minute cron sweep as a
-- safety net. Titles/bodies never contain lead personal data (lock screens).

-- Drop the original push_status check whatever it was named, then re-add it.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.notifications'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%push_status%'
  loop
    execute format('alter table public.notifications drop constraint %I', v_name);
  end loop;
end;
$$;
alter table public.notifications add constraint notifications_push_status_check
  check (push_status in ('pending', 'sending', 'sent', 'skipped', 'failed'));
alter table public.notifications add column push_attempted_at timestamptz;

-- Non-secret runtime configuration (e.g. the dispatch function URL).
create table private.app_config (
  key   text primary key,
  value text not null
);
revoke all on private.app_config from public;

-- ---------------------------------------------------------------------------
-- Queue: claim / complete (service role only)
-- ---------------------------------------------------------------------------
create function public.claim_push_batch(p_limit integer default 100)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_batch jsonb;
begin
  -- Old news is not pushed (e.g. a backlog after an outage); stuck claims are given up.
  update public.notifications set push_status = 'skipped'
   where push_status = 'pending' and created_at < now() - interval '1 hour';
  update public.notifications set push_status = 'failed'
   where push_status = 'sending' and push_attempted_at < now() - interval '5 minutes';

  -- Nobody to deliver to: done.
  update public.notifications n set push_status = 'skipped'
   where n.push_status = 'pending'
     and not exists (select 1 from public.push_tokens t where t.profile_id = n.recipient_id);

  with claimed as (
    update public.notifications n
       set push_status = 'sending', push_attempted_at = now()
     where n.id in (
       select id from public.notifications
        where push_status = 'pending'
        order by created_at
        limit p_limit
          for update skip locked)
    returning n.id, n.recipient_id, n.type, n.title, n.body, n.data
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'type', c.type, 'title', c.title, 'body', c.body, 'data', c.data,
           'tokens', (select coalesce(jsonb_agg(jsonb_build_object('token', t.token, 'platform', t.platform)), '[]'::jsonb)
                        from public.push_tokens t where t.profile_id = c.recipient_id))), '[]'::jsonb)
    into v_batch
    from claimed c;
  return v_batch;
end;
$$;

-- p_results: [{"id": uuid, "status": "sent" | "failed"}]; p_dead_tokens: tokens the
-- push service says no longer exist (uninstalled app, revoked permission).
create function public.complete_push_batch(p_results jsonb, p_dead_tokens text[] default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.notifications n
     set push_status = r.status
    from jsonb_to_recordset(p_results) as r(id uuid, status text)
   where n.id = r.id and n.push_status = 'sending' and r.status in ('sent', 'failed');
  delete from public.push_tokens where token = any(p_dead_tokens);
end;
$$;

revoke all on function public.claim_push_batch(integer) from public, anon, authenticated;
revoke all on function public.complete_push_batch(jsonb, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Wake-up: pg_net call to the Edge Function (no-op until configured)
-- ---------------------------------------------------------------------------
create function private.kick_push_dispatch()
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
begin
  select value into v_url from private.app_config where key = 'push_dispatch_url';
  if v_url is null or not exists (select 1 from pg_extension where extname = 'pg_net') then
    return;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := ''{"Content-Type":"application/json"}''::jsonb, timeout_milliseconds := 30000)'
    using v_url;
end;
$$;

create function private.notifications_kick_push() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.kick_push_dispatch();
  return null;
end;
$$;
create trigger notifications_kick_push after insert on public.notifications
  for each statement execute function private.notifications_kick_push();

create function public.sweep_push_queue()
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.notifications where push_status = 'pending') then
    perform private.kick_push_dispatch();
  end if;
end;
$$;
revoke all on function public.sweep_push_queue() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_push_batch(integer) to service_role;
    grant execute on function public.complete_push_batch(jsonb, text[]) to service_role;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-push-sweep', '* * * * *', 'select public.sweep_push_queue()');
  end if;
end;
$$;

-- Anything queued before push existed is history, not news.
update public.notifications set push_status = 'skipped' where push_status = 'pending';

-- Where the database sends its wake-up call (this project's dispatch-push function).
-- Other environments: update this row to their own project URL.
insert into private.app_config (key, value)
values ('push_dispatch_url', 'https://shrmtdhdiuykrwlivqra.supabase.co/functions/v1/dispatch-push')
on conflict (key) do update set value = excluded.value;
