import { beforeEach, describe, expect, it } from 'vitest';
import { ageOpenAssignment, createFixture, createLead, q, runReassignmentJob, sq, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

/** Pretend the lead was created `minutes` ago (bypasses triggers, test-only). */
async function ageLead(id: string, minutes: number) {
  await f.db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.query(`update public.leads set created_at = created_at - make_interval(mins => $2) where id = $1`, [id, minutes]);
  });
}

async function run() {
  const [row] = await sq<{ r: { assigned?: number; waiting?: number; skipped?: boolean } }>(f.db, `select public.process_unassigned_leads() as r`);
  return row.r;
}

const lead = async (id: string) =>
  (await sq<{ assigned_to: string | null; status: string; needs_attention: boolean }>(
    f.db, `select assigned_to, status, needs_attention from public.leads where id = $1`, [id],
  ))[0];

const notes = (who: string, type: string) =>
  sq<{ title: string; body: string; data: { lead_ids?: string[] } }>(
    f.db, `select title, body, data from public.notifications where recipient_id = $1 and type = $2`, [who, type],
  );

describe('process_unassigned_leads', () => {
  it('waits for the grace period, then assigns within the team and notifies once per volunteer', async () => {
    const fresh = await createLead(f.db, f.teamA);
    const old1 = await createLead(f.db, f.teamA);
    const old2 = await createLead(f.db, f.teamA);
    const old3 = await createLead(f.db, f.teamA);
    for (const id of [old1, old2, old3]) await ageLead(id, 45);

    expect(await run()).toEqual({ assigned: 3, waiting: 0 });
    expect((await lead(fresh)).assigned_to).toBeNull();

    // Spread across team A's three volunteers, never team B's.
    const owners = await Promise.all([old1, old2, old3].map(async (id) => (await lead(id)).assigned_to));
    expect(new Set(owners)).toEqual(new Set([f.volA1, f.volA2, f.volA3]));
    expect((await lead(old1)).status).toBe('assigned');

    const [a] = await sq<{ kind: string; assigned_by: string | null }>(
      f.db, `select kind, assigned_by from public.lead_assignments where lead_id = $1`, [old1]);
    expect(a).toEqual({ kind: 'auto_assign', assigned_by: null });
    expect(await notes(owners[0]!, 'lead_assigned')).toHaveLength(1);

    // Running again changes nothing.
    expect(await run()).toEqual({ assigned: 0, waiting: 0 });
  });

  it('one volunteer receiving several leads gets one notification', async () => {
    await sq(f.db, `update public.profiles set accepting_leads = false where id = any($1)`, [[f.volA2, f.volA3]]);
    const ids = [await createLead(f.db, f.teamA), await createLead(f.db, f.teamA)];
    for (const id of ids) await ageLead(id, 60);
    await run();
    const n = await notes(f.volA1, 'lead_assigned');
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe('New leads assigned');
    expect(n[0]!.data.lead_ids).toHaveLength(2);
    // Lock-screen text must not carry lead personal data.
    expect(n[0]!.body).not.toContain('Test Lead');
  });

  it('leaves leads staff deliberately returned to the pool', async () => {
    const id = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[id], f.volA1]);
    await q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[id]]);
    await sq(f.db, `update public.org_settings set auto_assign_after_minutes = 0 where id`);
    const other = await createLead(f.db, f.teamA); // control: a never-assigned lead is picked up
    expect(await run()).toEqual({ assigned: 1, waiting: 0 });
    expect((await lead(other)).assigned_to).not.toBeNull();
    expect((await lead(id)).assigned_to).toBeNull();
  });

  it('flags leads with no eligible volunteer and tells staff only once', async () => {
    await sq(f.db, `update public.profiles set accepting_leads = false where team_id = $1 and role = 'volunteer'`, [f.teamA]);
    const id = await createLead(f.db, f.teamA);
    await ageLead(id, 60);
    expect(await run()).toEqual({ assigned: 0, waiting: 1 });
    expect(await run()).toEqual({ assigned: 0, waiting: 1 });
    expect((await lead(id)).needs_attention).toBe(true);
    expect(await notes(f.teacherA, 'leads_need_attention')).toHaveLength(1);
    expect(await notes(f.teacherB, 'leads_need_attention')).toHaveLength(0);

    // A volunteer becomes available: picked up on the next run, flag cleared.
    await sq(f.db, `update public.profiles set accepting_leads = true where id = $1`, [f.volA2]);
    expect(await run()).toEqual({ assigned: 1, waiting: 0 });
    expect(await lead(id)).toMatchObject({ assigned_to: f.volA2, needs_attention: false });
  });

  it('respects the on/off switch and the delay setting', async () => {
    const id = await createLead(f.db, f.teamA);
    await ageLead(id, 20);
    expect(await run()).toEqual({ assigned: 0, waiting: 0 }); // default 30 min
    await q(f.db, f.admin, `update public.org_settings set auto_assign_after_minutes = 10 where id`);
    await q(f.db, f.admin, `update public.org_settings set auto_assign_enabled = false where id`);
    expect(await run()).toMatchObject({ skipped: true });
    await q(f.db, f.admin, `update public.org_settings set auto_assign_enabled = true where id`);
    expect(await run()).toEqual({ assigned: 1, waiting: 0 });
  });

  it('cannot be run by app users, and teachers cannot change the settings', async () => {
    await expect(q(f.db, f.admin, `select public.process_unassigned_leads()`)).rejects.toThrow(/permission denied/);
    await q(f.db, f.teacherA, `update public.org_settings set auto_assign_enabled = false where id`);
    const [s] = await sq<{ auto_assign_enabled: boolean }>(f.db, `select auto_assign_enabled from public.org_settings`);
    expect(s!.auto_assign_enabled).toBe(true);
  });
});

describe('push queue', () => {
  const claim = async () => (await sq<{ r: { id: string; tokens: { token: string }[] }[] }>(f.db, `select public.claim_push_batch() as r`))[0]!.r;

  it('claims pending notifications with device tokens, once, and records results', async () => {
    await q(f.db, f.volA1, `select public.register_push_token($1, 'web')`, ['{"endpoint":"https://push.example/a"}']);
    await sq(f.db, `select private.notify($1, 'lead_assigned', 'New lead assigned', 'x')`, [f.volA1]);
    await sq(f.db, `select private.notify($1, 'lead_assigned', 'New lead assigned', 'x')`, [f.volA2]); // no device

    const batch = await claim();
    expect(batch).toHaveLength(1);
    expect(batch[0]!.tokens.map((t) => t.token)).toEqual(['{"endpoint":"https://push.example/a"}']);
    expect(await claim()).toEqual([]); // not handed out twice

    await sq(f.db, `select public.complete_push_batch($1, $2)`, [JSON.stringify([{ id: batch[0]!.id, status: 'sent' }]), ['{"endpoint":"https://push.example/a"}']]);
    const rows = await sq<{ recipient_id: string; push_status: string }>(f.db, `select recipient_id, push_status from public.notifications order by push_status`);
    expect(rows).toEqual(expect.arrayContaining([
      { recipient_id: f.volA1, push_status: 'sent' },
      { recipient_id: f.volA2, push_status: 'skipped' },
    ]));
    expect(await sq(f.db, `select * from public.push_tokens`)).toEqual([]); // dead token removed
  });

  it('is service-role only', async () => {
    await expect(q(f.db, f.admin, `select public.claim_push_batch()`)).rejects.toThrow(/permission denied/);
    await expect(q(f.db, f.admin, `select public.complete_push_batch('[]')`)).rejects.toThrow(/permission denied/);
  });
});

describe('registered leads stay put', () => {
  it('a registered lead past its call deadline is not reassigned, and Registered cannot be reopened', async () => {
    const id = await createLead(f.db, f.teamA);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[id], f.volA1]);
    await q(f.db, f.volA1, `select public.update_lead_status($1, 'registered')`, [id]);
    await ageOpenAssignment(f.db, id, 48);

    expect(await runReassignmentJob(f.db)).toMatchObject({ reassigned: 0, queued: 0 });
    expect(await lead(id)).toMatchObject({ assigned_to: f.volA1, status: 'registered', needs_attention: false });

    await expect(sq(f.db, `update public.lead_statuses set is_closed = false where code = 'registered'`)).rejects.toThrow(/registered_closed/);
  });
});

describe('leads held for manual assignment', () => {
  it('auto-assign skips them; a person can still assign them', async () => {
    const held = await createLead(f.db, f.teamA, { manual_assignment_only: true });
    const normal = await createLead(f.db, f.teamA);
    await ageLead(held, 60);
    await ageLead(normal, 60);
    await run();
    expect((await lead(held))!.assigned_to).toBeNull();
    expect((await lead(normal))!.assigned_to).not.toBeNull();
    await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [held, f.volA1]);
    expect((await lead(held))!.assigned_to).toBe(f.volA1);
  });
});
