-- Sevak Directory: each person may show their phone number to other members.
-- Off by default; set in the person's own seva profile. The directory returns the
-- number only for people who switched it on (and always to the person themself).

alter table public.profiles add column show_phone_in_directory boolean not null default false;
grant update (show_phone_in_directory) on public.profiles to authenticated;

drop function public.member_directory();

create function public.member_directory()
returns table (
  id uuid, full_name text, role public.app_role, team_name text,
  seva_days text[], seva_times text[], seva_note text, nearest_centre text, address text, seva_interests text[],
  phone text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.my_role() is null or not private.role_can('sevak_directory') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  return query
  select p.id, p.full_name, p.role, t.name, p.seva_days, p.seva_times, p.seva_note, p.nearest_centre, p.address, p.seva_interests,
         case when p.show_phone_in_directory or p.id = auth.uid() then p.phone end
    from public.profiles p
    left join public.teams t on t.id = p.team_id
   where p.status = 'active'
   order by p.full_name;
end;
$$;
revoke all on function public.member_directory() from public, anon;
grant execute on function public.member_directory() to authenticated;
