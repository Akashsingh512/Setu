-- Local development seed (applied by `supabase db reset`). No users: create them
-- through Studio/Auth, then follow docs/SETUP.md to promote the first super admin.
insert into public.teams (name) values ('Main') on conflict do nothing;
