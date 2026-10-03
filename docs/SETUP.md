# Developer setup

## Prerequisites

- Node.js 20+ (developed on 24) and npm
- A Supabase project (free tier is fine for development), **or** Docker Desktop for a local stack
- Supabase CLI via `npx supabase` (no global install needed)

## 1. Install and run the tests

```bash
npm install
npm test            # shared unit tests + database tests (PGlite, no Docker needed)
npm run test:db     # database tests only
```

The database tests apply every file in `supabase/migrations/` to an in-memory
PostgreSQL 17 (PGlite) with a shim for Supabase's `auth` schema and roles.
They exercise RLS as each role, assignment, reassignment, Do Not Contact rules,
courses and reminders.

`packages/db-tests/test/concurrency.test.ts` needs two real connections and is
skipped unless `DATABASE_URL` points at a **disposable** Postgres with the
migrations applied (it writes append-only history it cannot clean up):

```bash
npx supabase start && npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:db
```

## 2. Create the database on a hosted Supabase project

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies supabase/migrations in order
```

Then in the Supabase dashboard:

1. **Authentication → Sign In / Providers → Email**: turn off "Allow new users to sign up".
   (Accounts are created by admins; `config.toml` already does this for local stacks.)
2. **Authentication → URL Configuration**: set the Site URL to the web app URL.
3. **Integrations → Cron**: confirm the three `crm-*` jobs exist (created by the migration).

## 3. Bootstrap the first super admin

Only service-role code may set a user's role, so the very first admin is created by hand:

1. Dashboard → **Authentication → Users → Add user** (email + password, auto-confirm).
2. Dashboard → **SQL Editor**:

```sql
insert into public.teams (name) values ('Main') on conflict do nothing;

update public.profiles
   set role = 'super_admin', full_name = 'Your Name'
 where email = 'you@example.org';
```

Every later account is created from inside the app (admin-users Edge Function, Phase 2).

## 4. Environment variables

Copy `.env.example`. Only the URL and the anon/publishable key go into the web
and mobile apps. The service-role key is used only inside Edge Functions, where
Supabase injects it automatically. Never put it in a `NEXT_PUBLIC_` or
`EXPO_PUBLIC_` variable.

## Repository layout

| Path | Contents |
|---|---|
| `supabase/migrations` | Schema, RLS, RPCs, scheduled jobs (source of truth for business rules) |
| `packages/shared` | Types, zod schemas, phone/WhatsApp/template helpers used by both apps |
| `packages/db-tests` | Database test suite |
| `apps/web`, `apps/mobile` | Next.js and Expo apps (Phases 2 and 6) |
| `docs/` | Architecture, decisions, setup |
