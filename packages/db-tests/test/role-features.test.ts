import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, type Fixture } from '../src/db';

// Feature access: the super admin turns features on or off per role.
let f: Fixture;
let lead: string;

beforeEach(async () => {
  f = await createFixture();
  lead = await createLead(f.db, f.teamA);
});

const set = (role: string, feature: string, enabled: boolean) =>
  q(f.db, f.admin, `select public.set_role_feature($1::public.app_role, $2, $3)`, [role, feature, enabled]);
const visibleLeads = async (who: string) => (await q(f.db, who, `select id from public.leads`)).length;

describe('feature access', () => {
  it('defaults keep what each role could do before', async () => {
    const rows = await sq<{ role: string; feature: string; enabled: boolean }>(f.db, `select role, feature, enabled from public.role_features where enabled order by 1, 2`);
    expect(rows.filter((r) => r.role === 'teacher')).toHaveLength(11);
    expect(rows.filter((r) => r.role === 'volunteer').map((r) => r.feature)).toEqual(['add_leads', 'send_from_setu', 'sevak_directory']);
  });

  it('only a super admin can change it, and it is audited', async () => {
    await expect(q(f.db, f.teacherA, `select public.set_role_feature('volunteer', 'view_reports', true)`)).rejects.toThrow(/Only super admins/);
    await expect(set('volunteer', 'nonsense', true)).rejects.toThrow(/Unknown role or feature/);
    await set('volunteer', 'view_reports', true);
    expect(await sq(f.db, `select * from public.audit_logs where action = 'feature_access.changed'`)).toHaveLength(1);
  });

  it("team_leads gives a volunteer the whole team's leads; off takes them from a teacher", async () => {
    expect(await visibleLeads(f.volA1)).toBe(0);
    await set('volunteer', 'team_leads', true);
    expect(await visibleLeads(f.volA1)).toBe(1);
    expect(await visibleLeads(f.teacherA)).toBe(1);
    await set('teacher', 'team_leads', false);
    expect(await visibleLeads(f.teacherA)).toBe(0);
  });

  it('assigning follows assign_leads (with team access)', async () => {
    await expect(q(f.db, f.volA1, `select public.assign_leads(array[$1]::uuid[], $2)`, [lead, f.volA2])).rejects.toThrow(/Only teachers and admins/);
    await set('volunteer', 'team_leads', true);
    await set('volunteer', 'assign_leads', true);
    await q(f.db, f.volA1, `select public.assign_leads(array[$1]::uuid[], $2)`, [lead, f.volA2]);
    expect((await sq<{ a: string }>(f.db, `select assigned_to as a from public.leads where id = $1`, [lead]))[0]!.a).toBe(f.volA2);
    await set('teacher', 'assign_leads', false);
    await expect(q(f.db, f.teacherA, `select public.unassign_leads(array[$1]::uuid[])`, [lead])).rejects.toThrow(/Only teachers and admins/);
  });

  it('reports, programs and adding leads can be switched off for teachers', async () => {
    const range = `select public.report_overview(now() - interval '7 days', now())`;
    await q(f.db, f.teacherA, range);
    await set('teacher', 'view_reports', false);
    await expect(q(f.db, f.teacherA, range)).rejects.toThrow(/Reports are available/);

    const course = (await sq<{ id: string }>(f.db, `insert into public.courses (name) values ('Sahaj') returning id`))[0]!.id;
    const program = `insert into public.course_sessions (course_id, starts_at, ends_at, venue) values ($1, now() + interval '1 day', now() + interval '2 days', 'Hall')`;
    await q(f.db, f.teacherA, program, [course]);
    await set('teacher', 'manage_programs', false);
    await expect(q(f.db, f.teacherA, program, [course])).rejects.toThrow(/row-level security/);

    await set('volunteer', 'add_leads', false);
    await expect(
      q(f.db, f.volA1, `select public.volunteer_add_lead($1::jsonb, false)`, [JSON.stringify({ full_name: 'X', phone: '+919811100000' })]),
    ).rejects.toThrow(/Adding leads is not enabled/);
  });

  it('a volunteer can be given programs and courses without seeing other leads', async () => {
    await set('volunteer', 'manage_courses', true);
    await q(f.db, f.volA1, `insert into public.courses (name, team_id) values ('Volunteer course', $1)`, [f.teamA]);
    expect(await visibleLeads(f.volA1)).toBe(0);
  });

  it('the Sevak Directory can be switched off', async () => {
    await q(f.db, f.volA1, `select * from public.member_directory()`);
    await set('volunteer', 'sevak_directory', false);
    await expect(q(f.db, f.volA1, `select * from public.member_directory()`)).rejects.toThrow(/Not authorised/);
  });
});
