/**
 * True concurrency needs two real database connections, which PGlite cannot
 * provide. This suite runs only when DATABASE_URL points at a DISPOSABLE
 * Postgres with the migrations applied (e.g. `supabase start` + `supabase db reset`).
 * It writes test data that cannot be deleted (history is append-only).
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('concurrent reassignment (real Postgres)', () => {
  let a: pg.Client;
  let b: pg.Client;
  let teamId: string;
  let leadIds: string[] = [];
  const tag = `conc-${Date.now()}`;

  beforeAll(async () => {
    a = new pg.Client({ connectionString: url });
    b = new pg.Client({ connectionString: url });
    await a.connect();
    await b.connect();

    teamId = (await a.query(`insert into public.teams (name) values ($1) returning id`, [tag])).rows[0].id;
    const mkUser = async (role: string, n: number) =>
      (
        await a.query(
          `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
           values (gen_random_uuid(), $1, $2, '{}') returning id`,
          [`${tag}-${role}-${n}@example.org`, JSON.stringify({ role, team_id: teamId })],
        )
      ).rows[0].id as string;
    const teacher = await mkUser('teacher', 0);
    const vols = [await mkUser('volunteer', 1), await mkUser('volunteer', 2), await mkUser('volunteer', 3)];

    for (let i = 0; i < 20; i += 1) {
      const id = (
        await a.query(`insert into public.leads (full_name, phone, team_id) values ($1, $2, $3) returning id`, [
          `${tag} lead ${i}`,
          `+9199${String(Date.now()).slice(-6)}${String(i).padStart(2, '0')}`,
          teamId,
        ])
      ).rows[0].id as string;
      leadIds.push(id);
    }
    await a.query('begin');
    await a.query(`select set_config('request.jwt.claim.sub', $1, true)`, [teacher]);
    await a.query(`set local role authenticated`);
    await a.query(`select public.assign_leads($1, $2)`, [leadIds, vols[0]]);
    await a.query('commit');

    await a.query('begin');
    await a.query(`set local session_replication_role = replica`);
    await a.query(
      `update public.lead_assignments
          set assigned_at = assigned_at - interval '25 hours',
              contact_deadline_at = contact_deadline_at - interval '25 hours'
        where lead_id = any($1) and ended_at is null`,
      [leadIds],
    );
    await a.query('commit');
  });

  afterAll(async () => {
    await a?.end();
    await b?.end();
  });

  it('a second job instance exits while the first is running', async () => {
    await a.query('begin');
    await a.query(`select pg_advisory_xact_lock(hashtext('crm.process_overdue_assignments'))`);
    const r = (await b.query(`select public.process_overdue_assignments() as r`)).rows[0].r;
    expect(r).toEqual({ skipped: true, reason: 'already_running' });
    await a.query('rollback');
  });

  it('a lead locked by a user action is skipped, then processed on the next run', async () => {
    const locked = leadIds[0];
    await a.query('begin');
    await a.query(`select id from public.leads where id = $1 for update`, [locked]);

    await b.query(`select public.process_overdue_assignments()`);
    const stillOpen = await b.query(
      `select count(*)::int n from public.lead_assignments where lead_id = $1 and ended_at is null and kind = 'bulk'`,
      [locked],
    );
    expect(stillOpen.rows[0].n).toBe(1);
    await a.query('commit');

    await b.query(`select public.process_overdue_assignments()`);
    const after = await b.query(
      `select kind from public.lead_assignments where lead_id = $1 and ended_at is null`,
      [locked],
    );
    expect(after.rows).toEqual([{ kind: 'auto_reassign' }]);
  });

  it('parallel invocations never create two open assignments for a lead', async () => {
    // Make every lead overdue again so both instances compete for the same rows.
    await a.query('begin');
    await a.query(`set local session_replication_role = replica`);
    await a.query(
      `update public.lead_assignments
          set assigned_at = assigned_at - interval '25 hours',
              contact_deadline_at = contact_deadline_at - interval '25 hours'
        where lead_id = any($1) and ended_at is null`,
      [leadIds],
    );
    await a.query('commit');

    await Promise.all([
      a.query(`select public.process_overdue_assignments()`),
      b.query(`select public.process_overdue_assignments()`),
    ]);
    const dupes = await a.query(
      `select lead_id from public.lead_assignments where lead_id = any($1) and ended_at is null
        group by lead_id having count(*) > 1`,
      [leadIds],
    );
    expect(dupes.rows).toEqual([]);
    const open = await a.query(
      `select count(*)::int n from public.lead_assignments where lead_id = any($1) and ended_at is null`,
      [leadIds],
    );
    expect(open.rows[0].n).toBe(leadIds.length);
  });
});
