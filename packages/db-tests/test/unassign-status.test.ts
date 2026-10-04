import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});
const status = (id: string) => sq<{ status: string }>(f.db, `select status from public.leads where id = $1`, [id]).then((r) => r[0]!.status);

describe('unassigning resets the automatic status', () => {
  it('New -> Assigned on assign, back to New on unassign', async () => {
    const id = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[id], f.volA1]);
    expect(await status(id)).toBe('assigned');
    await q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[id]]);
    expect(await status(id)).toBe('new');
  });

  it('a status a person chose is kept', async () => {
    const id = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[id], f.volA1]);
    const [{ code }] = await sq<{ code: string }>(f.db, `select code from public.lead_statuses where code not in ('new','assigned') and is_active and not is_closed order by sort_order limit 1`);
    await sq(f.db, `update public.leads set status = $2 where id = $1`, [id, code]);
    await q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[id]]);
    expect(await status(id)).toBe(code);
  });

  it('reassigning to another volunteer keeps Assigned', async () => {
    const id = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[id], f.volA1]);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[id], f.volA2]);
    expect(await status(id)).toBe('assigned');
  });
});
