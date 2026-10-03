import { beforeAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, createFixture, createLead, q, sq, type Fixture } from '../src/db';

let f: Fixture;
let leadA1: string; // team A, assigned to volA1
let leadA2: string; // team A, unassigned
let leadB1: string; // team B

beforeAll(async () => {
  f = await createFixture();
  leadA1 = await createLead(f.db, f.teamA, { full_name: 'Asha' });
  leadA2 = await createLead(f.db, f.teamA, { full_name: 'Bala' });
  leadB1 = await createLead(f.db, f.teamB, { full_name: 'Chitra' });
  await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[leadA1], f.volA1]);
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('anonymous access', () => {
  it('cannot read any CRM table', async () => {
    for (const table of ['leads', 'profiles', 'courses', 'lead_assignments', 'notifications', 'org_settings']) {
      await expect(asAnon(f.db, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('cannot call RPCs', async () => {
    await expect(
      asAnon(f.db, (tx) => tx.query(`select public.assign_leads($1, $2)`, [[leadA2], f.volA1])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('lead visibility', () => {
  it('volunteer sees only leads currently assigned to them', async () => {
    expect(ids(await q(f.db, f.volA1, `select id from public.leads`))).toEqual([leadA1]);
    expect(await q(f.db, f.volA2, `select id from public.leads`)).toEqual([]);
  });

  it('teacher sees only their team', async () => {
    expect(ids(await q(f.db, f.teacherA, `select id from public.leads`))).toEqual([leadA1, leadA2].sort());
    expect(ids(await q(f.db, f.teacherB, `select id from public.leads`))).toEqual([leadB1]);
  });

  it('super admin sees everything', async () => {
    expect((await q(f.db, f.admin, `select id from public.leads`)).length).toBe(3);
  });

  it('volunteer cannot read history of leads not assigned to them', async () => {
    expect(await q(f.db, f.volA2, `select * from public.lead_assignments where lead_id = $1`, [leadA1])).toEqual([]);
    expect(await q(f.db, f.volA2, `select * from public.lead_activities where lead_id = $1`, [leadA1])).toEqual([]);
  });

  it('teacher cannot create a lead in another team', async () => {
    await expect(
      q(f.db, f.teacherA, `insert into public.leads (full_name, phone, team_id) values ('X', '+919800000001', $1)`, [
        f.teamB,
      ]),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('volunteer restrictions', () => {
  it('cannot update lead rows directly', async () => {
    const rows = await q(f.db, f.volA1, `update public.leads set full_name = 'Hacked' where id = $1 returning id`, [
      leadA1,
    ]);
    expect(rows).toEqual([]);
    const [lead] = await sq<{ full_name: string }>(f.db, `select full_name from public.leads where id = $1`, [leadA1]);
    expect(lead.full_name).toBe('Asha');
  });

  it('cannot assign leads (to themselves or anyone)', async () => {
    await expect(q(f.db, f.volA1, `select public.assign_leads($1, $2)`, [[leadA2], f.volA1])).rejects.toThrow(
      /Only teachers and admins/,
    );
  });

  it('cannot change their own role or status', async () => {
    await expect(
      q(f.db, f.volA1, `update public.profiles set role = 'super_admin' where id = $1`, [f.volA1]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(f.db, f.volA1, `select public.admin_update_user($1, p_role => 'super_admin')`, [f.volA1]),
    ).rejects.toThrow(/Not authorised/);
  });

  it('can update their own safe profile fields', async () => {
    await q(f.db, f.volA1, `update public.profiles set full_name = 'Vol A1', accepting_leads = true where id = $1`, [
      f.volA1,
    ]);
    const [p] = await sq<{ full_name: string }>(f.db, `select full_name from public.profiles where id = $1`, [f.volA1]);
    expect(p.full_name).toBe('Vol A1');
  });

  it('cannot alter assignment history or deadlines', async () => {
    await expect(
      q(f.db, f.volA1, `update public.lead_assignments set contact_deadline_at = now() + interval '30 days'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(f.db, f.volA1, `insert into public.lead_assignments (lead_id, assignee_id, kind, contact_deadline_at)
                        values ($1, $2, 'manual', now() + interval '1 day')`, [leadA2, f.volA1]),
    ).rejects.toThrow(/permission denied/);
    await expect(q(f.db, f.volA1, `delete from public.lead_activities`)).rejects.toThrow(/permission denied/);
  });

  it('cannot run the reassignment job', async () => {
    await expect(q(f.db, f.volA1, `select public.process_overdue_assignments()`)).rejects.toThrow(/permission denied/);
    await expect(q(f.db, f.teacherA, `select public.process_overdue_assignments()`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('cannot insert call attempts directly (must use RPC with server time)', async () => {
    await expect(
      q(f.db, f.volA1, `insert into public.call_attempts (lead_id, outcome) values ($1, 'connected')`, [leadA1]),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot read other volunteers profiles', async () => {
    const rows = await q<{ id: string }>(f.db, f.volA1, `select id from public.profiles`);
    expect(rows.map((r) => r.id)).toContain(f.volA1);
    expect(rows.map((r) => r.id)).toContain(f.teacherA);
    expect(rows.map((r) => r.id)).not.toContain(f.volA2);
  });
});

describe('staff restrictions', () => {
  it('staff cannot write system-maintained lead columns', async () => {
    await expect(
      q(f.db, f.teacherA, `update public.leads set assigned_to = $2 where id = $1`, [leadA2, f.volA2]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(f.db, f.admin, `update public.leads set call_attempt_count = 5 where id = $1`, [leadA2]),
    ).rejects.toThrow(/permission denied/);
  });

  it('teacher cannot see other team leads via RPC tricks', async () => {
    await expect(q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[leadB1], f.volA1])).rejects.toThrow(
      /Not authorised/,
    );
  });

  it('teacher cannot assign to a volunteer in another team', async () => {
    await expect(q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[leadA2], f.volB1])).rejects.toThrow(
      /outside your team/,
    );
  });

  it('teacher can deactivate own-team volunteers but not change roles', async () => {
    await expect(
      q(f.db, f.teacherA, `select public.admin_update_user($1, p_role => 'teacher')`, [f.volA3]),
    ).rejects.toThrow(/Only super admins/);
    await expect(
      q(f.db, f.teacherA, `select public.admin_update_user($1, p_status => 'inactive')`, [f.volB1]),
    ).rejects.toThrow(/Teachers can only manage volunteers in their team/);
    await expect(
      q(f.db, f.teacherA, `select public.admin_update_user($1, p_status => 'inactive')`, [f.teacherB]),
    ).rejects.toThrow(/Teachers can only manage volunteers in their team/);
  });

  it('super admin can change roles but not lock themselves out', async () => {
    await expect(
      q(f.db, f.admin, `select public.admin_update_user($1, p_role => 'volunteer')`, [f.admin]),
    ).rejects.toThrow(/cannot change your own role/);
    await expect(
      q(f.db, f.admin, `select public.admin_update_user($1, p_status => 'inactive')`, [f.admin]),
    ).rejects.toThrow(/deactivate yourself/);
  });

  it('only super admins read the audit log and settings are admin-only writable', async () => {
    expect(await q(f.db, f.teacherA, `select * from public.audit_logs`)).toEqual([]);
    expect((await q(f.db, f.admin, `select * from public.audit_logs`)).length).toBeGreaterThan(0);
    const updated = await q(f.db, f.teacherA, `update public.org_settings set contact_deadline_hours = 99 returning id`);
    expect(updated).toEqual([]);
  });
});

describe('inactive accounts', () => {
  it('an inactive user with a still-valid JWT sees no data', async () => {
    const lead = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[lead], f.volA3]);
    expect((await q(f.db, f.volA3, `select id from public.leads`)).length).toBe(1);

    await q(f.db, f.teacherA, `select public.admin_update_user($1, p_status => 'inactive')`, [f.volA3]);
    expect(await q(f.db, f.volA3, `select id from public.leads`)).toEqual([]);
    expect(await q(f.db, f.volA3, `select id from public.courses`)).toEqual([]);
    await expect(
      q(f.db, f.volA3, `select public.log_call_attempt($1, 'connected')`, [lead]),
    ).rejects.toThrow(/inactive/);

    // Staff are alerted that the deactivated volunteer still holds leads.
    const alerts = await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'volunteer_deactivated_with_leads'`, [f.teacherA]);
    expect(alerts.length).toBe(1);

    await q(f.db, f.teacherA, `select public.admin_update_user($1, p_status => 'active')`, [f.volA3]);
  });
});

describe('notifications', () => {
  it('users read and mark only their own notifications', async () => {
    const mine = await q<{ recipient_id: string }>(f.db, f.volA1, `select recipient_id from public.notifications`);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((n) => n.recipient_id === f.volA1)).toBe(true);

    const updated = await asUser(f.db, f.volA2, async (tx) =>
      (await tx.query(`update public.notifications set read_at = now() where recipient_id = $1 returning id`, [f.volA1])).rows,
    );
    expect(updated).toEqual([]);
  });
});
