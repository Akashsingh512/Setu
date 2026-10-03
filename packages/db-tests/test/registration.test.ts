import { beforeEach, describe, expect, it } from 'vitest';
import { asAnon, createFixture, createLead, q, sq, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

/** Simulates a public sign-up: no role in app_metadata, user-chosen metadata. */
async function selfRegister(email: string, meta: Record<string, unknown>): Promise<string> {
  const [row] = await sq<{ id: string }>(
    f.db,
    `insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
     values ($1, '{"provider":"email","providers":["email"]}', $2) returning id`,
    [email, JSON.stringify(meta)],
  );
  return row.id;
}

async function profile(id: string) {
  const [p] = await sq<{ role: string; status: string; approval_status: string; team_id: string | null; recommended_by: string | null }>(
    f.db,
    `select role, status, approval_status, team_id, recommended_by from public.profiles where id = $1`,
    [id],
  );
  return p;
}

describe('self-registration', () => {
  it('creates a pending, inactive volunteer in the recommending teacher team', async () => {
    const id = await selfRegister('new@example.org', { full_name: 'New Person', phone: '+919811111111', recommended_by: f.teacherA });
    expect(await profile(id)).toEqual({
      role: 'volunteer',
      status: 'inactive',
      approval_status: 'pending',
      team_id: f.teamA,
      recommended_by: f.teacherA,
    });
    const notes = await sq<{ recipient_id: string }>(f.db, `select recipient_id from public.notifications where type = 'registration_pending'`);
    expect(notes.map((n) => n.recipient_id).sort()).toEqual([f.admin, f.teacherA].sort());
  });

  it('cannot grant itself a role, and ignores bogus metadata instead of failing', async () => {
    const id = await selfRegister('sneaky@example.org', { role: 'super_admin', recommended_by: 'not-a-uuid', phone: '12345' });
    expect(await profile(id)).toMatchObject({ role: 'volunteer', status: 'inactive', approval_status: 'pending', recommended_by: null, team_id: null });
  });

  it('only active staff can be named as recommending teacher', async () => {
    const id = await selfRegister('x@example.org', { recommended_by: f.volA1 });
    expect((await profile(id)).recommended_by).toBeNull();
  });

  it('pending users see no data', async () => {
    await createLead(f.db, f.teamA);
    const id = await selfRegister('p@example.org', { recommended_by: f.teacherA });
    expect(await q(f.db, id, `select id from public.leads`)).toEqual([]);
    expect(await q(f.db, id, `select id from public.courses`)).toEqual([]);
    await expect(q(f.db, id, `select public.review_registration($1, true)`, [id])).rejects.toThrow(/Not authorised/);
    // They can read their own profile (to show "awaiting approval").
    expect(await q(f.db, id, `select approval_status from public.profiles where id = $1`, [id])).toEqual([{ approval_status: 'pending' }]);
  });

  it('admin-created accounts are still active immediately', async () => {
    expect(await profile(f.volA1)).toMatchObject({ status: 'active', approval_status: 'approved' });
  });
});

describe('teacher search (public)', () => {
  it('anonymous visitors can search active teachers by name, nothing else', async () => {
    await sq(f.db, `update public.profiles set full_name = 'Vinod Kumar' where id = $1`, [f.teacherA]);
    await sq(f.db, `update public.profiles set full_name = 'Meera Rao' where id = $1`, [f.teacherB]);
    const all = await asAnon(f.db, async (tx) => (await tx.query<{ full_name: string; team_name: string }>(`select * from public.search_teachers('')`)).rows);
    const names = all.map((r) => r.full_name);
    expect(names).toEqual(expect.arrayContaining(['Vinod Kumar', 'Meera Rao']));
    expect(names).not.toContain('va1'); // volunteers are not listed

    const hit = await asAnon(f.db, async (tx) => (await tx.query<{ full_name: string; team_name: string }>(`select * from public.search_teachers('vin')`)).rows);
    expect(hit).toEqual([{ id: f.teacherA, full_name: 'Vinod Kumar', team_name: 'Team A' }]);

    // Anonymous visitors still cannot read profiles directly.
    await expect(asAnon(f.db, (tx) => tx.query(`select * from public.profiles`))).rejects.toThrow(/permission denied/);
  });
});

describe('reviewing registrations', () => {
  it('the recommending teacher sees and approves into their team', async () => {
    const id = await selfRegister('r1@example.org', { full_name: 'R One', recommended_by: f.teacherA });
    expect(await q(f.db, f.teacherA, `select id from public.profiles where approval_status = 'pending'`)).toEqual([{ id }]);
    await q(f.db, f.teacherA, `select public.review_registration($1, true)`, [id]);
    expect(await profile(id)).toMatchObject({ status: 'active', approval_status: 'approved', team_id: f.teamA });
    // Now a normal volunteer: can receive leads.
    const lead = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[lead], id]);
    expect(await q(f.db, id, `select id from public.leads`)).toEqual([{ id: lead }]);
  });

  it('another teacher cannot review it', async () => {
    const id = await selfRegister('r2@example.org', { recommended_by: f.teacherA });
    await expect(q(f.db, f.teacherB, `select public.review_registration($1, true)`, [id])).rejects.toThrow(/recommending teacher or a super admin/);
    expect(await q(f.db, f.teacherB, `select id from public.profiles where id = $1`, [id])).toEqual([]);
  });

  it('super admin approves registrations without a teacher by choosing a team', async () => {
    const id = await selfRegister('r3@example.org', {});
    await expect(q(f.db, f.admin, `select public.review_registration($1, true)`, [id])).rejects.toThrow(/Choose a team/);
    await q(f.db, f.admin, `select public.review_registration($1, true, $2)`, [id, f.teamB]);
    expect(await profile(id)).toMatchObject({ status: 'active', team_id: f.teamB });
    const welcome = await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'registration_approved'`, [id]);
    expect(welcome).toHaveLength(1);
  });

  it('rejection keeps the account locked; reviewing twice fails', async () => {
    const id = await selfRegister('r4@example.org', { recommended_by: f.teacherA });
    await q(f.db, f.teacherA, `select public.review_registration($1, false)`, [id]);
    expect(await profile(id)).toMatchObject({ status: 'inactive', approval_status: 'rejected' });
    await expect(q(f.db, f.teacherA, `select public.review_registration($1, true)`, [id])).rejects.toThrow(/No pending registration/);
    const audit = await sq(f.db, `select action from public.audit_logs where entity_id = $1`, [id]);
    expect(audit).toEqual([{ action: 'registration.rejected' }]);
  });
});
