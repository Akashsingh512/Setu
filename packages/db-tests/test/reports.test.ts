import { beforeEach, describe, expect, it } from 'vitest';
import { ageOpenAssignment, createFixture, createLead, q, sq, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

type Report = {
  totals: Record<string, number>;
  by_volunteer: { volunteer_id: string; assigned: number; on_time: number; late: number; missed: number; pending: number; attempts: number; leads_contacted: number; auto_reassigned: number }[];
  outcomes: Record<string, number>;
  follow_ups: Record<string, number>;
  by_course: { course: string; leads: number; registered_now: number; registrations_in_range: number }[];
  registrations_by_course: { course: string; registrations: number }[];
  funnel: { status: string; count: number }[];
  daily: { day: string; calls: number; leads_contacted: number }[];
  overdue: { lead_id: string; hours_overdue: number }[];
};

async function report(actor: string, extra: { team?: string; volunteer?: string } = {}): Promise<Report> {
  const [row] = await q<{ r: Report }>(
    f.db,
    actor,
    `select public.report_overview(now() - interval '7 days', now() + interval '1 day', $1, $2) as r`,
    [extra.team ?? null, extra.volunteer ?? null],
  );
  return row.r;
}

async function seed() {
  const [course] = await sq<{ id: string }>(f.db, `insert into public.courses (name) values ('Happiness Program') returning id`);
  const a1 = await createLead(f.db, f.teamA, { course_id: course.id });
  const a2 = await createLead(f.db, f.teamA, { course_id: course.id });
  const a3 = await createLead(f.db, f.teamA);
  const b1 = await createLead(f.db, f.teamB);
  await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[a1, a2], f.volA1]);
  await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[a3], f.volA2]);
  await q(f.db, f.teacherB, `select public.assign_leads($1, $2)`, [[b1], f.volB1]);
  // volA1 calls a1 twice (one lead contacted, two attempts) and registers it.
  await q(f.db, f.volA1, `select public.log_call_attempt($1, 'no_answer')`, [a1]);
  await q(f.db, f.volA1, `select public.log_call_attempt($1, 'connected', null, null, 'registered')`, [a1]);
  await q(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '1 day')`, [a2]);
  // volA2 never calls a3; its deadline passes.
  await ageOpenAssignment(f.db, a3, 30);
  return { course: course.id, a1, a2, a3, b1 };
}

describe('report_overview', () => {
  it('keeps assignments, attempts, unique contacts and registrations distinct', async () => {
    await seed();
    const r = await report(f.teacherA);
    expect(r.totals).toMatchObject({
      leads_created: 3,
      assignments: 3,
      leads_assigned: 3,
      call_attempts: 2,
      leads_contacted: 1,
      registrations: 1,
      overdue_now: 1,
    });
    expect(r.outcomes).toEqual({ no_answer: 1, connected: 1 });
    expect(r.follow_ups).toMatchObject({ due: 1, open_upcoming: 1, done: 0 });
  });

  it('per-volunteer first-call performance', async () => {
    await seed();
    const r = await report(f.teacherA);
    const v1 = r.by_volunteer.find((v) => v.volunteer_id === f.volA1)!;
    const v2 = r.by_volunteer.find((v) => v.volunteer_id === f.volA2)!;
    expect(v1).toMatchObject({ assigned: 2, on_time: 1, late: 0, missed: 0, pending: 1, attempts: 2, leads_contacted: 1 });
    expect(v2).toMatchObject({ assigned: 1, on_time: 0, missed: 1, attempts: 0 });
  });

  it('registrations are reported by course', async () => {
    await seed();
    const r = await report(f.teacherA);
    expect(r.registrations_by_course).toEqual([{ course: 'Happiness Program', registrations: 1 }]);
    const hp = r.by_course.find((c) => c.course === 'Happiness Program')!;
    expect(hp).toMatchObject({ leads: 2, registered_now: 1, registrations_in_range: 1 });
    expect(r.by_course.find((c) => c.course === 'Not specified')).toMatchObject({ leads: 1 });
    expect(r.funnel.find((s) => s.status === 'registered')!.count).toBe(1);
  });

  it('daily series covers every day and sums to the totals', async () => {
    await seed();
    const r = await report(f.teacherA);
    expect(r.daily.length).toBeGreaterThanOrEqual(8);
    expect(r.daily.reduce((s, d) => s + d.calls, 0)).toBe(2);
  });

  it('is scoped by RLS: teachers see their team only, admins see all', async () => {
    await seed();
    expect((await report(f.teacherB)).totals.leads_created).toBe(1);
    expect((await report(f.admin)).totals.leads_created).toBe(4);
    expect((await report(f.admin, { team: f.teamB })).totals.leads_created).toBe(1);
  });

  it('filters by volunteer', async () => {
    await seed();
    const r = await report(f.teacherA, { volunteer: f.volA2 });
    expect(r.totals).toMatchObject({ assignments: 1, call_attempts: 0, overdue_now: 1 });
    expect(r.overdue).toHaveLength(1);
  });

  it('is refused for volunteers and for silly ranges', async () => {
    await expect(report(f.volA1)).rejects.toThrow(/teachers and admins/);
    await expect(
      q(f.db, f.admin, `select public.report_overview(now(), now() - interval '1 day')`),
    ).rejects.toThrow(/date range/);
  });
});
