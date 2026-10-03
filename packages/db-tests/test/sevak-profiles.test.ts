import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, nextPhone, q, sq, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

describe('seva profile and directory', () => {
  it('members edit only their own seva details', async () => {
    await q(
      f.db,
      f.volA1,
      `update public.profiles set seva_days = '{sat,sun}', seva_times = '{evening}', nearest_centre = ' Koramangala ',
              address = 'HSR Layout', seva_interests = '{Calling leads, Kitchen ,Calling leads}' where id = $1`,
      [f.volA1],
    );
    const [p] = await sq<{ nearest_centre: string; seva_interests: string[] }>(f.db, `select nearest_centre, seva_interests from public.profiles where id = $1`, [
      f.volA1,
    ]);
    expect(p).toEqual({ nearest_centre: 'Koramangala', seva_interests: ['Calling leads', 'Kitchen'] });

    // Someone else's row: not visible to update, so nothing changes.
    await q(f.db, f.volA2, `update public.profiles set address = 'hacked' where id = $1`, [f.volA1]);
    expect((await sq<{ address: string }>(f.db, `select address from public.profiles where id = $1`, [f.volA1]))[0]!.address).toBe('HSR Layout');
    // Role and team are still not writable.
    await expect(q(f.db, f.volA1, `update public.profiles set role = 'super_admin' where id = $1`, [f.volA1])).rejects.toThrow();
  });

  it('rejects unknown days or times', async () => {
    await expect(q(f.db, f.volA1, `update public.profiles set seva_days = '{funday}' where id = $1`, [f.volA1])).rejects.toThrow();
  });

  it('every active member sees the directory, without emails or phones', async () => {
    await q(f.db, f.volA1, `update public.profiles set nearest_centre = 'Koramangala' where id = $1`, [f.volA1]);
    const rows = await q<Record<string, unknown>>(f.db, f.volB1, `select * from public.member_directory()`);
    expect(rows.find((r) => r.id === f.volA1)).toMatchObject({ nearest_centre: 'Koramangala', role: 'volunteer', team_name: 'Team A' });
    expect(Object.keys(rows[0]!)).not.toContain('email');
    expect(Object.keys(rows[0]!)).not.toContain('phone');

    await sq(f.db, `update public.profiles set status = 'inactive' where id = $1`, [f.volA2]);
    expect(rows.length - (await q(f.db, f.volB1, `select * from public.member_directory()`)).length).toBe(1);
    await expect(q(f.db, f.volA2, `select * from public.member_directory()`)).rejects.toThrow(/Not authorised/);
  });
});

describe('volunteers adding leads', () => {
  const add = (who: string, lead: Record<string, unknown>, mine = true) =>
    q<{ r: { id?: string; duplicate?: boolean; assigned_to_me?: boolean } }>(f.db, who, `select public.volunteer_add_lead($1, $2) as r`, [
      JSON.stringify({ full_name: 'Ravi', source: 'satsang', ...lead }),
      mine,
    ]).then((x) => x[0]!.r);

  it('adds a lead in their team, met by them and assigned to them', async () => {
    const r = await add(f.volA1, { phone: nextPhone() });
    const [lead] = await sq<{ team_id: string; assigned_to: string; met_by_id: string; created_by: string }>(
      f.db,
      `select team_id, assigned_to, met_by_id, created_by from public.leads where id = $1`,
      [r.id],
    );
    expect(lead).toEqual({ team_id: f.teamA, assigned_to: f.volA1, met_by_id: f.volA1, created_by: f.volA1 });
    // They can open it; a volunteer in another team cannot.
    expect(await q(f.db, f.volA1, `select id from public.leads where id = $1`, [r.id])).toHaveLength(1);
    expect(await q(f.db, f.volB1, `select id from public.leads where id = $1`, [r.id])).toHaveLength(0);
  });

  it('can hand it to the team instead; teachers are told', async () => {
    const r = await add(f.volA1, { phone: nextPhone() }, false);
    expect((await sq<{ assigned_to: string | null }>(f.db, `select assigned_to from public.leads where id = $1`, [r.id]))[0]!.assigned_to).toBeNull();
    expect(await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'lead_added_by_volunteer'`, [f.teacherA])).toHaveLength(1);
    expect(await q(f.db, f.volA1, `select id from public.leads where id = $1`, [r.id])).toHaveLength(0);
  });

  it('a number already in Setu is not added again, and nothing about it is revealed', async () => {
    const phone = nextPhone();
    await createLead(f.db, f.teamB, { phone, full_name: 'Existing person' });
    const r = await add(f.volA1, { phone });
    expect(r).toEqual({ duplicate: true });
    expect(await sq(f.db, `select 1 from public.leads where phone = $1`, [phone])).toHaveLength(1);
    expect(await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'lead_duplicate_by_volunteer'`, [f.teacherA])).toHaveLength(1);
  });

  it('only volunteers in a team; direct inserts are still blocked', async () => {
    await expect(add(f.teacherA, { phone: nextPhone() })).rejects.toThrow(/Only active volunteers/);
    await sq(f.db, `update public.profiles set team_id = null where id = $1`, [f.volA2]);
    await expect(add(f.volA2, { phone: nextPhone() })).rejects.toThrow(/not in a team/);
    await expect(
      q(f.db, f.volA1, `insert into public.leads (full_name, phone, team_id) values ('X', $1, $2)`, [nextPhone(), f.teamA]),
    ).rejects.toThrow();
  });

  it('rejects a bad phone number', async () => {
    await expect(add(f.volA1, { phone: '12345' })).rejects.toThrow(/valid mobile/);
  });
});

describe('leads captured offline', () => {
  const ref = () => crypto.randomUUID();
  const sync = (who: string, clientRef: string, lead: Record<string, unknown>, mine = true) =>
    q<{ r: Record<string, unknown> }>(f.db, who, `select public.add_lead_from_device($1, $2, $3) as r`, [
      clientRef,
      JSON.stringify({ full_name: 'Field lead', source: 'event', ...lead }),
      mine,
    ]).then((x) => x[0]!.r);

  it('a retried send never creates the lead twice', async () => {
    const r1 = ref();
    const phone = nextPhone();
    const first = await sync(f.volA1, r1, { phone });
    const again = await sync(f.volA1, r1, { phone });
    expect(again).toMatchObject({ id: first.id, already_synced: true, assigned_to_me: true });
    expect(await sq(f.db, `select 1 from public.leads where phone = $1`, [phone])).toHaveLength(1);
  });

  it('teachers add to their own team, unassigned; existing numbers are reported back', async () => {
    const phone = nextPhone();
    const r = await sync(f.teacherA, ref(), { phone });
    const [lead] = await sq<{ team_id: string; assigned_to: string | null }>(f.db, `select team_id, assigned_to from public.leads where id = $1`, [r.id]);
    expect(lead).toEqual({ team_id: f.teamA, assigned_to: null });
    expect(await sync(f.teacherA, ref(), { phone })).toMatchObject({ duplicate: true, lead_id: r.id });
    // Another team's lead: duplicate, but not revealed.
    expect(await sync(f.teacherB, ref(), { phone })).toEqual({ duplicate: true });
    await expect(sync(f.teacherA, ref(), { phone: nextPhone(), team_id: f.teamB })).rejects.toThrow(/cannot add leads to that team/);
  });

  it('a super admin picks the team', async () => {
    await expect(sync(f.admin, ref(), { phone: nextPhone() })).rejects.toThrow(/Choose a team/);
    const r = await sync(f.admin, ref(), { phone: nextPhone(), team_id: f.teamB });
    expect((await sq<{ team_id: string }>(f.db, `select team_id from public.leads where id = $1`, [r.id]))[0]!.team_id).toBe(f.teamB);
  });

  it('volunteers follow the same rules as online', async () => {
    const r = await sync(f.volA1, ref(), { phone: nextPhone(), team_id: f.teamB }, false);
    const [lead] = await sq<{ team_id: string; assigned_to: string | null }>(f.db, `select team_id, assigned_to from public.leads where id = $1`, [r.id]);
    expect(lead).toEqual({ team_id: f.teamA, assigned_to: null }); // team from the profile, not the request
    await expect(sync(f.volA1, ref(), { phone: nextPhone(), full_name: ' ' })).rejects.toThrow(/Name is required/);
  });

  it('clients cannot set client_ref themselves', async () => {
    await expect(
      q(f.db, f.teacherA, `insert into public.leads (full_name, phone, team_id, client_ref) values ('X', $1, $2, $3)`, [nextPhone(), f.teamA, ref()]),
    ).rejects.toThrow();
  });
});
