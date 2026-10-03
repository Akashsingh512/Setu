import { beforeEach, describe, expect, it } from 'vitest';
import {
  ageOpenAssignment,
  createFixture,
  createLead,
  createUser,
  q,
  runReassignmentJob,
  sq,
  type Fixture,
} from '../src/db';

// Fresh database per test: candidate choice depends on workload, so tests must not share state.
let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

async function assign(leadIds: string[], volunteer: string) {
  await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [leadIds, volunteer]);
}

async function history(leadId: string) {
  return sq<{
    id: string;
    assignee_id: string;
    kind: string;
    end_reason: string | null;
    ended_at: string | null;
    assigned_by: string | null;
    deadline_hours_from_now: number;
  }>(
    f.db,
    `select id, assignee_id, kind, end_reason, ended_at, assigned_by,
            round(extract(epoch from contact_deadline_at - now()) / 3600)::int as deadline_hours_from_now
       from public.lead_assignments where lead_id = $1
      order by assigned_at, ended_at nulls last`,
    [leadId],
  );
}

async function lead(leadId: string) {
  const [l] = await sq<{ assigned_to: string | null; needs_attention: boolean; current_assignment_id: string | null }>(
    f.db,
    `select assigned_to, needs_attention, current_assignment_id from public.leads where id = $1`,
    [leadId],
  );
  return l;
}

describe('contact deadline', () => {
  it('records a 24h deadline on assignment', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    const [h] = await history(id);
    expect(h.deadline_hours_from_now).toBe(24);
  });

  it('uses the configured deadline', async () => {
    await q(f.db, f.admin, `update public.org_settings set contact_deadline_hours = 48`);
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    expect((await history(id))[0].deadline_hours_from_now).toBe(48);
  });

  it('does not reassign before the deadline', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 23);
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 0 });
    expect((await lead(id)).assigned_to).toBe(f.volA1);
  });
});

describe('automatic reassignment', () => {
  it('reassigns after the deadline when no call attempt was recorded', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 25);

    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 1, queued: 0 });

    const l = await lead(id);
    expect(l.assigned_to).not.toBe(f.volA1);
    expect([f.volA2, f.volA3]).toContain(l.assigned_to);

    const h = await history(id);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ assignee_id: f.volA1, end_reason: 'reassigned_auto' });
    expect(h[1]).toMatchObject({ assignee_id: l.assigned_to, kind: 'auto_reassign', end_reason: null, assigned_by: null });
    expect(h[1].deadline_hours_from_now).toBe(24); // fresh deadline
    expect(l.current_assignment_id).toBe(h[1].id);

    // Notifications: old volunteer, new volunteer, team teacher (and super admin).
    const notes = await sq<{ recipient_id: string; type: string }>(
      f.db,
      `select recipient_id, type from public.notifications
        where type in ('lead_reassigned_away', 'lead_assigned', 'leads_auto_reassigned')
          and created_at >= (select max(assigned_at) from public.lead_assignments where lead_id = $1)`,
      [id],
    );
    expect(notes).toContainEqual({ recipient_id: f.volA1, type: 'lead_reassigned_away' });
    expect(notes).toContainEqual({ recipient_id: l.assigned_to, type: 'lead_assigned' });
    expect(notes).toContainEqual({ recipient_id: f.teacherA, type: 'leads_auto_reassigned' });
    expect(notes).toContainEqual({ recipient_id: f.admin, type: 'leads_auto_reassigned' });
    expect(notes.some((n) => n.recipient_id === f.teacherB)).toBe(false);

    const audit = await sq(f.db, `select action from public.audit_logs where entity_id = $1 and action = 'lead.auto_reassigned'`, [id]);
    expect(audit).toHaveLength(1);

    // Old volunteer can no longer see it; new one can.
    expect(await q(f.db, f.volA1, `select id from public.leads where id = $1`, [id])).toEqual([]);
    expect(await q(f.db, l.assigned_to!, `select id from public.leads where id = $1`, [id])).toHaveLength(1);
  });

  it('a recorded call attempt (any outcome) prevents reassignment', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await q(f.db, f.volA1, `select public.log_call_attempt($1, 'no_answer')`, [id]);
    await ageOpenAssignment(f.db, id, 30);
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 0 });
    expect((await lead(id)).assigned_to).toBe(f.volA1);
  });

  it('a call made under a previous assignment does not count for the new one', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await q(f.db, f.volA1, `select public.log_call_attempt($1, 'busy')`, [id]);
    await assign([id], f.volA2); // manual reassignment: new clock
    await ageOpenAssignment(f.db, id, 25);
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 1, queued: 0 });
  });

  it('a new manual assignment resets the deadline', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 23);
    await assign([id], f.volA2);
    // The old assignment would now be overdue, but it is closed; the new one has 24h.
    await ageOpenAssignment(f.db, id, 2);
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 0 });
    expect((await lead(id)).assigned_to).toBe(f.volA2);
  });

  it('skips inactive, unavailable, other-team and over-capacity volunteers', async () => {
    await sq(f.db, `update public.profiles set status = 'inactive' where id = $1`, [f.volA2]);
    await sq(f.db, `update public.profiles set accepting_leads = false where id = $1`, [f.volA3]);
    const volA4 = await createUser(f.db, { email: 'va4@example.org', role: 'volunteer', teamId: f.teamA });
    const volA5 = await createUser(f.db, { email: 'va5@example.org', role: 'volunteer', teamId: f.teamA });
    await sq(f.db, `update public.profiles set max_open_leads = 1 where id = $1`, [volA4]);
    await assign([await createLead(f.db, f.teamA)], volA4); // volA4 now at capacity

    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 25);
    await runReassignmentJob(f.db);
    expect((await lead(id)).assigned_to).toBe(volA5);
  });

  it('prefers the volunteer with the fewest open leads', async () => {
    await assign([await createLead(f.db, f.teamA), await createLead(f.db, f.teamA)], f.volA2);
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 25);
    await runReassignmentJob(f.db);
    expect((await lead(id)).assigned_to).toBe(f.volA3);
  });

  it('with no eligible volunteer, unassigns into the attention queue and alerts staff', async () => {
    await sq(f.db, `update public.profiles set status = 'inactive' where id = any($1)`, [[f.volA2, f.volA3]]);
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 25);

    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 1 });
    expect(await lead(id)).toMatchObject({ assigned_to: null, needs_attention: true, current_assignment_id: null });
    expect((await history(id))[0].end_reason).toBe('auto_no_candidate');
    const alerts = await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'leads_need_attention'`, [f.teacherA]);
    expect(alerts).toHaveLength(1);

    // Assigning it again clears the attention flag.
    await sq(f.db, `update public.profiles set status = 'active' where id = $1`, [f.volA2]);
    await assign([id], f.volA2);
    expect((await lead(id)).needs_attention).toBe(false);
  });

  it('does not assign back to the same volunteer even if they are the only one', async () => {
    await sq(f.db, `update public.profiles set status = 'inactive' where id = any($1)`, [[f.volA2, f.volA3]]);
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 25);
    await runReassignmentJob(f.db);
    expect((await lead(id)).assigned_to).toBeNull();
  });

  it('stops cycling after max_auto_reassignments and queues the lead', async () => {
    await sq(f.db, `update public.org_settings set max_auto_reassignments = 2`);
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    for (let i = 0; i < 2; i += 1) {
      await ageOpenAssignment(f.db, id, 25);
      expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 1, queued: 0 });
    }
    await ageOpenAssignment(f.db, id, 25);
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 1 });
    expect(await history(id)).toHaveLength(3);
  });

  it('never reassigns closed leads (registered, not interested, DNC …)', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await q(f.db, f.teacherA, `update public.leads set status = 'registered' where id = $1`, [id]);
    await ageOpenAssignment(f.db, id, 25);
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 0 });
  });

  it('respects the auto-reassign switch', async () => {
    await sq(f.db, `update public.org_settings set auto_reassign_enabled = false`);
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await ageOpenAssignment(f.db, id, 25);
    expect(await runReassignmentJob(f.db)).toEqual({ skipped: true, reason: 'disabled' });
  });

  it('reassigns within the lead team only', async () => {
    const id = await createLead(f.db, f.teamB);
    await q(f.db, f.teacherB, `select public.assign_leads($1, $2)`, [[id], f.volB1]);
    await ageOpenAssignment(f.db, id, 25);
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 1 });
  });
});

describe('idempotency and integrity', () => {
  it('running the job repeatedly never double-reassigns', async () => {
    const ids = [await createLead(f.db, f.teamA), await createLead(f.db, f.teamA), await createLead(f.db, f.teamA)];
    await assign(ids, f.volA1);
    for (const id of ids) await ageOpenAssignment(f.db, id, 25);

    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 3, queued: 0 });
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 0 });
    expect(await runReassignmentJob(f.db)).toEqual({ reassigned: 0, queued: 0 });

    const open = await sq<{ n: number }>(f.db, `select count(*)::int n from public.lead_assignments where lead_id = any($1) and ended_at is null`, [ids]);
    expect(open[0].n).toBe(3);
    const total = await sq<{ n: number }>(f.db, `select count(*)::int n from public.lead_assignments where lead_id = any($1)`, [ids]);
    expect(total[0].n).toBe(6);
  });

  it('the database refuses a second open assignment for the same lead', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await expect(
      sq(f.db, `insert into public.lead_assignments (lead_id, assignee_id, kind, contact_deadline_at)
                values ($1, $2, 'manual', now() + interval '1 day')`, [id, f.volA2]),
    ).rejects.toThrow(/lead_assignments_one_open_idx/);
  });

  it('assignment history is immutable even for privileged code paths', async () => {
    const id = await createLead(f.db, f.teamA);
    await assign([id], f.volA1);
    await expect(
      sq(f.db, `update public.lead_assignments set assignee_id = $2 where lead_id = $1`, [id, f.volA2]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sq(f.db, `update public.lead_assignments set contact_deadline_at = now() + interval '9 days' where lead_id = $1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(sq(f.db, `delete from public.lead_assignments where lead_id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
  });
});
