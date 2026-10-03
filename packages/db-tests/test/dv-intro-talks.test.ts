import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, q, sq, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
  await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{schedule_announcements}')`, [f.teacherA]);
});

const add = (who: string, url: string | null = 'https://maps.app.goo.gl/abc') =>
  q<{ id: string }>(
    f.db,
    who,
    `insert into public.dv_intro_talks (name, location, starts_at, organised_by, location_url)
     values ('Happiness intro', 'Community hall, Sector 5', now() + interval '2 days', 'Bangalore Ashram', $1) returning id`,
    [url],
  ).then((r) => r[0]!.id);

describe('intro talks', () => {
  it('people with the Announcements permission manage them; it is audited', async () => {
    const id = await add(f.teacherA);
    await q(f.db, f.teacherA, `update public.dv_intro_talks set location = 'New hall' where id = $1`, [id]);
    expect((await sq<{ location: string }>(f.db, `select location from public.dv_intro_talks`))[0]!.location).toBe('New hall');
    expect((await sq<{ action: string }>(f.db, `select action from public.audit_logs where action like 'dv.intro_talk%' order by id`)).map((r) => r.action)).toEqual([
      'dv.intro_talk_insert',
      'dv.intro_talk_update',
    ]);
    await q(f.db, f.teacherA, `delete from public.dv_intro_talks where id = $1`, [id]);
    expect(await sq(f.db, `select 1 from public.dv_intro_talks`)).toHaveLength(0);
  });

  it('others can neither see nor add them', async () => {
    await add(f.teacherA);
    expect(await q(f.db, f.volA1, `select * from public.dv_intro_talks`)).toEqual([]);
    await expect(add(f.volA1)).rejects.toThrow();
    await q(f.db, f.volA1, `delete from public.dv_intro_talks`);
    expect(await sq(f.db, `select 1 from public.dv_intro_talks`)).toHaveLength(1);
  });

  it('the location link must be a web link', async () => {
    await expect(add(f.teacherA, 'javascript:alert(1)')).rejects.toThrow();
    expect(await add(f.teacherA, null)).toBeTruthy();
  });
});
