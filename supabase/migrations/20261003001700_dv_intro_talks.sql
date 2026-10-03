-- Digital Volunteer: intro talks.
--
-- A short list of upcoming intro talks (name, place, time, organiser, map link).
-- Sharing one in WhatsApp groups goes through the normal announcement flow
-- (prefilled message, chosen groups, second-person approval, schedule), so no
-- new sending rules are added here. Managed by people with "Announcements".

create table public.dv_intro_talks (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) between 1 and 150),
  location     text not null check (length(btrim(location)) between 1 and 300),
  starts_at    timestamptz not null,
  organised_by text check (length(organised_by) <= 150),
  location_url text check (location_url ~ '^https?://\S+$' and length(location_url) <= 500),
  created_by   uuid references public.profiles (id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index dv_intro_talks_starts_idx on public.dv_intro_talks (starts_at desc);

create function private.dv_intro_talks_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  perform private.audit('dv.intro_talk_' || lower(tg_op), 'dv_intro_talk', coalesce(new.id, old.id),
    jsonb_build_object('name', coalesce(new.name, old.name)));
  return coalesce(new, old);
end;
$$;
create trigger dv_intro_talks_audit before insert or update or delete on public.dv_intro_talks
  for each row execute function private.dv_intro_talks_audit();

revoke all on public.dv_intro_talks from anon, authenticated;
grant select, delete on public.dv_intro_talks to authenticated;
grant insert (name, location, starts_at, organised_by, location_url),
      update (name, location, starts_at, organised_by, location_url)
  on public.dv_intro_talks to authenticated;
alter table public.dv_intro_talks enable row level security;
create policy dv_intro_talks_select on public.dv_intro_talks for select to authenticated
  using (private.dv_can('schedule_announcements'));
create policy dv_intro_talks_insert on public.dv_intro_talks for insert to authenticated
  with check (private.dv_can('schedule_announcements'));
create policy dv_intro_talks_update on public.dv_intro_talks for update to authenticated
  using (private.dv_can('schedule_announcements')) with check (private.dv_can('schedule_announcements'));
create policy dv_intro_talks_delete on public.dv_intro_talks for delete to authenticated
  using (private.dv_can('schedule_announcements'));
