import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

async function createCourse(actor: string, teamId: string | null = null): Promise<string> {
  const [c] = await q<{ id: string }>(
    f.db,
    actor,
    `insert into public.courses (name, short_description, registration_url, category, team_id)
     values ('Happiness Program', 'Breathing and meditation', 'https://example.org/register', 'Beginner', $1)
     returning id`,
    [teamId],
  );
  return c.id;
}

async function createSession(actor: string, courseId: string, startOffset: string, endOffset: string, teamId: string | null) {
  const [s] = await q<{ id: string }>(
    f.db,
    actor,
    `insert into public.course_sessions (course_id, starts_at, ends_at, mode, venue, team_id)
     values ($1, now() + $2::interval, now() + $3::interval, 'in_person', 'Community hall', $4)
     returning id`,
    [courseId, startOffset, endOffset, teamId],
  );
  return s.id;
}

describe('courses', () => {
  it('teachers create and edit courses; volunteers read but cannot write', async () => {
    const id = await createCourse(f.teacherA);
    const [c] = await sq<{ created_by: string }>(f.db, `select created_by from public.courses where id = $1`, [id]);
    expect(c.created_by).toBe(f.teacherA);

    await q(f.db, f.teacherA, `update public.courses set short_description = 'Updated' where id = $1`, [id]);
    expect(await q(f.db, f.volA1, `select short_description from public.courses where id = $1`, [id])).toEqual([
      { short_description: 'Updated' },
    ]);

    await expect(
      q(f.db, f.volA1, `insert into public.courses (name) values ('Sneaky')`),
    ).rejects.toThrow(/row-level security/);
    expect(await q(f.db, f.volA1, `update public.courses set name = 'X' where id = $1 returning id`, [id])).toEqual([]);
  });

  it('team-scoped courses are hidden from other teams', async () => {
    const id = await createCourse(f.teacherA, f.teamA);
    expect(await q(f.db, f.volB1, `select id from public.courses where id = $1`, [id])).toEqual([]);
    expect(await q(f.db, f.volA1, `select id from public.courses where id = $1`, [id])).toHaveLength(1);
  });

  it('validates registration URLs', async () => {
    await expect(
      q(f.db, f.teacherA, `insert into public.courses (name, registration_url) values ('Bad', 'javascript:alert(1)')`),
    ).rejects.toThrow(/http_url/);
  });

  it('a volunteer default course is settable on their own profile', async () => {
    const id = await createCourse(f.teacherA);
    await q(f.db, f.volA1, `update public.profiles set default_course_id = $1 where id = $2`, [id, f.volA1]);
    const [p] = await sq<{ default_course_id: string }>(f.db, `select default_course_id from public.profiles where id = $1`, [f.volA1]);
    expect(p.default_course_id).toBe(id);
  });
});

describe('upcoming sessions', () => {
  it('only future, scheduled sessions are upcoming; expired ones are completed by the job', async () => {
    const course = await createCourse(f.teacherA);
    const future = await createSession(f.teacherA, course, '2 days', '5 days', f.teamA);
    const running = await createSession(f.teacherA, course, '-1 day', '1 day', f.teamA);
    const past = await createSession(f.teacherA, course, '-10 days', '-7 days', f.teamA);
    const cancelled = await createSession(f.teacherA, course, '3 days', '4 days', f.teamA);
    await q(f.db, f.teacherA, `update public.course_sessions set status = 'cancelled' where id = $1`, [cancelled]);

    const upcoming = await q<{ id: string; display_title: string; effective_registration_url: string }>(
      f.db, f.volA1, `select id, display_title, effective_registration_url from public.upcoming_sessions order by starts_at`,
    );
    expect(upcoming.map((u) => u.id)).toEqual([running, future]);
    expect(upcoming[0]).toMatchObject({ display_title: 'Happiness Program', effective_registration_url: 'https://example.org/register' });

    const [{ n }] = await sq<{ n: number }>(f.db, `select public.complete_past_sessions() as n`);
    expect(n).toBe(1);
    const [p] = await sq<{ status: string }>(f.db, `select status from public.course_sessions where id = $1`, [past]);
    expect(p.status).toBe('completed');
  });

  it('end must be after start', async () => {
    const course = await createCourse(f.teacherA);
    await expect(createSession(f.teacherA, course, '2 days', '1 day', f.teamA)).rejects.toThrow(/time_order/);
  });

  it('publishing and rescheduling notify the team (not the author, not other teams)', async () => {
    const course = await createCourse(f.teacherA);
    const id = await createSession(f.teacherA, course, '2 days', '3 days', f.teamA);

    const published = await sq<{ recipient_id: string }>(
      f.db, `select recipient_id from public.notifications where type = 'session_published' and data ->> 'session_id' = $1`, [id],
    );
    const recipients = published.map((r) => r.recipient_id);
    expect(recipients).toEqual(expect.arrayContaining([f.volA1, f.volA2, f.volA3, f.admin]));
    expect(recipients).not.toContain(f.teacherA);
    expect(recipients).not.toContain(f.volB1);

    await q(f.db, f.teacherA, `update public.course_sessions set starts_at = starts_at + interval '1 hour' where id = $1`, [id]);
    const updated = await sq(f.db, `select 1 from public.notifications where type = 'session_updated' and recipient_id = $1`, [f.volA1]);
    expect(updated).toHaveLength(1);

    // Edits that don't affect the schedule are silent.
    await q(f.db, f.teacherA, `update public.course_sessions set instructions = 'Bring a mat' where id = $1`, [id]);
    const after = await sq(f.db, `select 1 from public.notifications where type = 'session_updated' and recipient_id = $1`, [f.volA1]);
    expect(after).toHaveLength(1);
  });

  it('teacher cannot edit another team session', async () => {
    const course = await createCourse(f.teacherB);
    const id = await createSession(f.teacherB, course, '2 days', '3 days', f.teamB);
    expect(await q(f.db, f.teacherA, `update public.course_sessions set venue = 'X' where id = $1 returning id`, [id])).toEqual([]);
  });
});

describe('follow-up reminders', () => {
  it('reminds the owner once, shortly before the follow-up is due', async () => {
    const lead = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[lead], f.volA1]);
    await q(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '30 minutes')`, [lead]);
    await q(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '2 days')`, [lead]);

    const [{ n }] = await sq<{ n: number }>(f.db, `select public.process_follow_up_reminders() as n`);
    expect(n).toBe(1);
    const [again] = await sq<{ n: number }>(f.db, `select public.process_follow_up_reminders() as n`);
    expect(again.n).toBe(0);

    const [note] = await sq<{ title: string; body: string }>(
      f.db, `select title, body from public.notifications where recipient_id = $1 and type = 'follow_up_due'`, [f.volA1],
    );
    expect(note.title).toBe('Follow-up due');
    expect(note.body).not.toMatch(/Test Lead/);
  });
});
