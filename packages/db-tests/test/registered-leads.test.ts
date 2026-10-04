import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, type Fixture } from '../src/db';

let f: Fixture;
let reg: string;
let open: string;
beforeEach(async () => {
  f = await createFixture();
  reg = await createLead(f.db, f.teamA);
  open = await createLead(f.db, f.teamA);
  await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[reg, open], f.volA1]);
  await sq(f.db, `update public.leads set status = 'registered' where id = $1`, [reg]);
});
const holder = (id: string) => sq<{ a: string | null }>(f.db, `select assigned_to as a from public.leads where id = $1`, [id]).then((r) => r[0]!.a);

describe('registered leads stay with their volunteer', () => {
  it('a registered lead cannot be unassigned', async () => {
    await expect(q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[reg]])).rejects.toThrow(/Registered leads stay/);
    expect(await holder(reg)).toBe(f.volA1);
  });

  it('in a bulk unassign, registered ones are kept and the rest go', async () => {
    const [{ r }] = (await q<{ r: { unassigned_count: number; kept_registered: number } }>(
      f.db,
      f.teacherA,
      `select public.unassign_leads($1) as r`,
      [[reg, open]],
    )) as [{ r: { unassigned_count: number; kept_registered: number } }];
    expect(r).toMatchObject({ unassigned_count: 1, kept_registered: 1 });
    expect(await holder(reg)).toBe(f.volA1);
    expect(await holder(open)).toBeNull();
  });

  it('cannot be reassigned to another volunteer either', async () => {
    const [{ r }] = (await q<{ r: { assigned_count: number; skipped: { reason: string }[] } }>(
      f.db,
      f.teacherA,
      `select public.assign_leads($1, $2) as r`,
      [[reg], f.volA2],
    )) as [{ r: { assigned_count: number; skipped: { reason: string }[] } }];
    expect(r.assigned_count).toBe(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(['registered']);
    expect(await holder(reg)).toBe(f.volA1);
  });

  it('a registered lead with nobody can still be given back', async () => {
    const lone = await createLead(f.db, f.teamA, { status: 'registered' });
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[lone], f.volA2]);
    expect(await holder(lone)).toBe(f.volA2);
  });

  it('Converted / Course Attended is protected too', async () => {
    await sq(f.db, `update public.leads set status = 'converted' where id = $1`, [reg]);
    await expect(q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[reg]])).rejects.toThrow(/Registered leads stay/);
  });
});
