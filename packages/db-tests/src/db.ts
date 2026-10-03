import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'supabase', 'migrations');

/**
 * Minimal stand-in for what Supabase provides before our migrations run:
 * API roles, the auth schema with auth.users and auth.uid(), and Supabase's
 * default privileges (everything granted to anon/authenticated), so the
 * migrations' revokes are exercised against realistic starting grants.
 */
const supabaseShim = /* sql */ `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_app_meta_data jsonb not null default '{}'::jsonb,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    last_sign_in_at timestamptz,
    created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(migrationsDir, f));
}

export async function createTestDb(): Promise<PGliteInterface> {
  const db = new PGlite();
  await db.exec(supabaseShim);
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Migration failed: ${file}\n${(err as Error).message}`);
    }
  }
  return db;
}

export type Tx = Transaction;
export type Role = 'super_admin' | 'teacher' | 'volunteer';

/** Run `fn` as an authenticated API user (RLS and grants apply), in a transaction. */
export async function asUser<T>(db: PGliteInterface, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await tx.exec('set local role authenticated');
    return fn(tx);
  });
}

export async function asAnon<T>(db: PGliteInterface, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return fn(tx);
  });
}

/** Run a single statement as the service role (what the WhatsApp gateway uses). */
export async function svc<R = Record<string, unknown>>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<R[]> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return (await tx.query<R>(sql, params)).rows;
  });
}

/** Convenience: run a single statement as a user and return its rows. */
export async function q<R = Record<string, unknown>>(
  db: PGliteInterface,
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  return asUser(db, userId, async (tx) => (await tx.query<R>(sql, params)).rows);
}

/** Superuser query (bypasses RLS) for arranging fixtures and asserting state. */
export async function sq<R = Record<string, unknown>>(db: PGliteInterface, sql: string, params: unknown[] = []): Promise<R[]> {
  return (await db.query<R>(sql, params)).rows;
}

export async function createUser(
  db: PGliteInterface,
  opts: { email: string; role: Role; teamId?: string | null; fullName?: string },
): Promise<string> {
  const [row] = await sq<{ id: string }>(
    db,
    `insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
     values ($1, $2, $3) returning id`,
    [
      opts.email,
      JSON.stringify({ role: opts.role, team_id: opts.teamId ?? null }),
      JSON.stringify({ full_name: opts.fullName ?? opts.email.split('@')[0] }),
    ],
  );
  return row.id;
}

export async function createTeam(db: PGliteInterface, name: string): Promise<string> {
  const [row] = await sq<{ id: string }>(db, `insert into public.teams (name) values ($1) returning id`, [name]);
  return row.id;
}

let phoneCounter = 1000000;
/** Unique valid E.164 number per call. */
export function nextPhone(): string {
  phoneCounter += 1;
  return `+9198${phoneCounter}`;
}

export async function createLead(
  db: PGliteInterface,
  teamId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const fields = { full_name: 'Test Lead', phone: nextPhone(), team_id: teamId, ...overrides };
  const keys = Object.keys(fields);
  const [row] = await sq<{ id: string }>(
    db,
    `insert into public.leads (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(fields),
  );
  return row.id;
}

/**
 * Simulate the passage of time for a lead's open assignment by moving its
 * timestamps into the past. Triggers are bypassed (superuser-only setting),
 * exactly because the application itself must never be able to do this.
 */
export async function ageOpenAssignment(db: PGliteInterface, leadId: string, hours: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(
      `update public.lead_assignments
          set assigned_at = assigned_at - make_interval(hours => $2),
              contact_deadline_at = contact_deadline_at - make_interval(hours => $2)
        where lead_id = $1 and ended_at is null`,
      [leadId, hours],
    );
  });
}

export async function runReassignmentJob(db: PGliteInterface): Promise<{ reassigned?: number; queued?: number; skipped?: boolean }> {
  const [row] = await sq<{ r: { reassigned?: number; queued?: number; skipped?: boolean } }>(
    db,
    `select public.process_overdue_assignments() as r`,
  );
  return row.r;
}

export interface Fixture {
  db: PGliteInterface;
  teamA: string;
  teamB: string;
  admin: string;
  teacherA: string;
  teacherB: string;
  volA1: string;
  volA2: string;
  volA3: string;
  volB1: string;
}

let template: Promise<Fixture> | undefined;

/**
 * Teams A and B, a super admin, one teacher per team, three volunteers in A and
 * one in B. Built once per test file, then cloned so each caller gets an
 * independent database quickly.
 */
export async function createFixture(): Promise<Fixture> {
  template ??= buildFixture();
  const t = await template;
  return { ...t, db: await t.db.clone() };
}

async function buildFixture(): Promise<Fixture> {
  const db = await createTestDb();
  const teamA = await createTeam(db, 'Team A');
  const teamB = await createTeam(db, 'Team B');
  const admin = await createUser(db, { email: 'admin@example.org', role: 'super_admin' });
  const teacherA = await createUser(db, { email: 'teacher.a@example.org', role: 'teacher', teamId: teamA });
  const teacherB = await createUser(db, { email: 'teacher.b@example.org', role: 'teacher', teamId: teamB });
  const volA1 = await createUser(db, { email: 'va1@example.org', role: 'volunteer', teamId: teamA });
  const volA2 = await createUser(db, { email: 'va2@example.org', role: 'volunteer', teamId: teamA });
  const volA3 = await createUser(db, { email: 'va3@example.org', role: 'volunteer', teamId: teamA });
  const volB1 = await createUser(db, { email: 'vb1@example.org', role: 'volunteer', teamId: teamB });
  return { db, teamA, teamB, admin, teacherA, teacherB, volA1, volA2, volA3, volB1 };
}
