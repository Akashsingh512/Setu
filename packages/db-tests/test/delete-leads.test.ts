import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, type Fixture } from '../src/db';

// Delete (to the Deleted list), restore, and delete for ever.
let f: Fixture;
let lead: string;

beforeEach(async () => {
  f = await createFixture();
  lead = await createLead(f.db, f.teamA);
  await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [lead, f.volA1]);
  // Some history: a call, a note, a follow-up with a comment.
  await q(f.db, f.volA1, `select public.log_call_attempt($1, 'no_answer', 'rang twice', null, null, now() + interval '1 day', null)`, [lead]);
  await q(f.db, f.volA1, `insert into public.lead_notes (lead_id, body) values ($1, 'met at satsang')`, [lead]);
  await q(f.db, f.volA1, `select public.add_follow_up_comment($1, null, 'try evening')`, [lead]);
});

const count = async (table: string) => (await sq<{ n: number }>(f.db, `select count(*)::int as n from public.${table} where lead_id = $1`, [lead]))[0]!.n;

describe('deleting leads', () => {
  it('delete moves it to Deleted (unassigned, follow-ups cancelled); restore brings it back', async () => {
    await q(f.db, f.teacherA, `select public.archive_leads(array[$1]::uuid[], 'wrong number')`, [lead]);
    const [gone] = await sq<{ archived_at: string | null; assigned_to: string | null }>(f.db, `select archived_at, assigned_to from public.leads where id = $1`, [lead]);
    expect(gone!.archived_at).not.toBeNull();
    expect(gone!.assigned_to).toBeNull();
    expect(await sq(f.db, `select 1 from public.follow_ups where lead_id = $1 and status = 'open'`, [lead])).toHaveLength(0);

    await expect(q(f.db, f.volA1, `select public.restore_leads(array[$1]::uuid[])`, [lead])).rejects.toThrow(/Not authorised/);
    expect((await q<{ n: number }>(f.db, f.teacherA, `select public.restore_leads(array[$1]::uuid[]) as n`, [lead]))[0]!.n).toBe(1);
    expect((await sq<{ a: string | null }>(f.db, `select archived_at as a from public.leads where id = $1`, [lead]))[0]!.a).toBeNull();
    expect(await sq(f.db, `select 1 from public.lead_activities where lead_id = $1 and type = 'restored'`, [lead])).toHaveLength(1);
  });

  it('delete for ever: super admins only, only from Deleted, and everything about the lead goes', async () => {
    await expect(q(f.db, f.admin, `select public.purge_leads(array[$1]::uuid[])`, [lead])).rejects.toThrow(/Delete the lead first/);
    await q(f.db, f.teacherA, `select public.archive_leads(array[$1]::uuid[])`, [lead]);
    await expect(q(f.db, f.teacherA, `select public.purge_leads(array[$1]::uuid[])`, [lead])).rejects.toThrow(/Only super admins/);

    expect(await count('call_attempts')).toBeGreaterThan(0);
    expect((await q<{ n: number }>(f.db, f.admin, `select public.purge_leads(array[$1]::uuid[]) as n`, [lead]))[0]!.n).toBe(1);
    expect(await sq(f.db, `select 1 from public.leads where id = $1`, [lead])).toHaveLength(0);
    for (const t of ['call_attempts', 'lead_assignments', 'lead_notes', 'follow_ups', 'follow_up_comments', 'lead_activities']) expect(await count(t)).toBe(0);
    expect(await sq(f.db, `select data from public.audit_logs where action = 'leads.purged'`)).toHaveLength(1);
  });

  it('history stays protected outside an erase', async () => {
    await expect(sq(f.db, `delete from public.lead_activities where lead_id = $1`, [lead])).rejects.toThrow(/append-only/);
    await expect(sq(f.db, `delete from public.lead_assignments where lead_id = $1`, [lead])).rejects.toThrow(/cannot be deleted/);
    await expect(sq(f.db, `delete from public.audit_logs`)).rejects.toThrow(/append-only/);
  });
});
