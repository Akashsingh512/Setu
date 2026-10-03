import { beforeAll, describe, expect, it } from 'vitest';
import { createFixture, createLead, nextPhone, q, sq, type Fixture } from '../src/db';

let f: Fixture;

beforeAll(async () => {
  f = await createFixture();
});

type AssignResult = { assigned_count: number; assigned_ids: string[]; skipped: { lead_id: string; reason: string }[] };

async function assign(actor: string, leadIds: string[], assignee: string): Promise<AssignResult> {
  const [row] = await q<{ r: AssignResult }>(f.db, actor, `select public.assign_leads($1, $2) as r`, [leadIds, assignee]);
  return row.r;
}

describe('lead creation and validation', () => {
  it('teacher creates a lead; code, creator and timeline are set server-side', async () => {
    const [lead] = await q<{ id: string; lead_code: string; created_by: string; status: string }>(
      f.db,
      f.teacherA,
      `insert into public.leads (full_name, phone, team_id, source, source_detail, met_on)
       values ('Devi', $1, $2, 'workshop', 'Sunday workshop', '2026-09-30')
       returning id, lead_code, created_by, status`,
      [nextPhone(), f.teamA],
    );
    expect(lead.lead_code).toMatch(/^L-\d{6}$/);
    expect(lead.created_by).toBe(f.teacherA);
    expect(lead.status).toBe('new');
    const acts = await sq(f.db, `select type from public.lead_activities where lead_id = $1`, [lead.id]);
    expect(acts).toEqual([{ type: 'created' }]);
  });

  it('rejects missing name and non-E.164 phone numbers', async () => {
    await expect(
      q(f.db, f.teacherA, `insert into public.leads (full_name, phone, team_id) values ('  ', $1, $2)`, [nextPhone(), f.teamA]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      q(f.db, f.teacherA, `insert into public.leads (full_name, phone, team_id) values ('E', '98450 12345', $1)`, [f.teamA]),
    ).rejects.toThrow(/e164/);
  });

  it('duplicate check counts org-wide but only reveals visible leads', async () => {
    const phone = nextPhone();
    const own = await createLead(f.db, f.teamA, { phone });
    await createLead(f.db, f.teamB, { phone });
    const [row] = await q<{ r: { total: number; visible: { id: string }[] } }>(
      f.db, f.teacherA, `select public.find_duplicate_leads($1) as r`, [phone],
    );
    expect(row.r.total).toBe(2);
    expect(row.r.visible.map((v) => v.id)).toEqual([own]);
  });
});

describe('bulk assignment', () => {
  it('assigns many leads transactionally with history, status and one notification', async () => {
    const leads = await Promise.all([1, 2, 3, 4, 5].map(() => createLead(f.db, f.teamA)));
    const before = await sq<{ n: number }>(f.db, `select count(*)::int n from public.notifications where recipient_id = $1`, [f.volA1]);

    const r = await assign(f.teacherA, leads, f.volA1);
    expect(r.assigned_count).toBe(5);
    expect(r.skipped).toEqual([]);

    const rows = await sq<{ assigned_to: string; status: string; current_assignment_id: string }>(
      f.db, `select assigned_to, status, current_assignment_id from public.leads where id = any($1)`, [leads],
    );
    expect(rows.every((l) => l.assigned_to === f.volA1 && l.status === 'assigned' && l.current_assignment_id)).toBe(true);

    const hist = await sq<{ kind: string; hours: number }>(
      f.db,
      `select kind, round(extract(epoch from contact_deadline_at - assigned_at) / 3600)::int as hours
         from public.lead_assignments where lead_id = any($1)`,
      [leads],
    );
    expect(hist).toHaveLength(5);
    expect(hist.every((h) => h.kind === 'bulk' && h.hours === 24)).toBe(true);

    const after = await sq<{ n: number }>(f.db, `select count(*)::int n from public.notifications where recipient_id = $1`, [f.volA1]);
    expect(after[0].n - before[0].n).toBe(1);

    const [n] = await sq<{ title: string; body: string }>(
      f.db, `select title, body from public.notifications where recipient_id = $1 order by created_at desc limit 1`, [f.volA1],
    );
    expect(n.title).toBe('New leads assigned');
    expect(n.body).not.toMatch(/Test Lead/); // no lead PII on lock screens
  });

  it('skips duplicates, Do Not Contact and unknown ids; rolls nothing back for valid ones', async () => {
    const already = await createLead(f.db, f.teamA);
    const dnc = await createLead(f.db, f.teamA, { status: 'do_not_contact' });
    const fresh = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [already], f.volA2);

    const ghost = '00000000-0000-0000-0000-000000000001';
    const r = await assign(f.teacherA, [already, dnc, fresh, ghost, fresh], f.volA2);
    expect(r.assigned_ids).toEqual([fresh]);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.lead_id, s.reason]));
    expect(reasons).toEqual({ [already]: 'already_assigned', [dnc]: 'do_not_contact', [ghost]: 'not_found' });

    const open = await sq<{ n: number }>(f.db, `select count(*)::int n from public.lead_assignments where lead_id = $1 and ended_at is null`, [already]);
    expect(open[0].n).toBe(1);
  });

  it('refuses inactive volunteers and the whole batch if any lead is out of scope', async () => {
    const lead = await createLead(f.db, f.teamA);
    await sq(f.db, `update public.profiles set status = 'inactive' where id = $1`, [f.volA3]);
    await expect(assign(f.teacherA, [lead], f.volA3)).rejects.toThrow(/inactive volunteer/);
    await sq(f.db, `update public.profiles set status = 'active' where id = $1`, [f.volA3]);

    const other = await createLead(f.db, f.teamB);
    await expect(assign(f.teacherA, [lead, other], f.volA1)).rejects.toThrow(/Not authorised/);
    const [l] = await sq<{ assigned_to: string | null }>(f.db, `select assigned_to from public.leads where id = $1`, [lead]);
    expect(l.assigned_to).toBeNull(); // transactional: nothing partially applied
  });

  it('manual reassignment ends the old assignment, resets the deadline and keeps history', async () => {
    const lead = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [lead], f.volA1);
    await assign(f.teacherA, [lead], f.volA2);

    const hist = await sq<{ assignee_id: string; end_reason: string | null; ended_at: string | null; previous_assignment_id: string | null }>(
      f.db, `select assignee_id, end_reason, ended_at, previous_assignment_id from public.lead_assignments where lead_id = $1 order by assigned_at, ended_at nulls last`, [lead],
    );
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({ assignee_id: f.volA1, end_reason: 'reassigned_manual' });
    expect(hist[1]).toMatchObject({ assignee_id: f.volA2, end_reason: null, ended_at: null });
    expect(hist[1].previous_assignment_id).not.toBeNull();

    expect(await q(f.db, f.volA1, `select id from public.leads where id = $1`, [lead])).toEqual([]);
    expect((await q(f.db, f.volA2, `select id from public.leads where id = $1`, [lead])).length).toBe(1);

    const away = await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'lead_reassigned_away'`, [f.volA1]);
    expect(away.length).toBeGreaterThan(0);
  });

  it('unassign returns leads to the pool without losing history', async () => {
    const lead = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [lead], f.volA1);
    await q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[lead]]);
    const [l] = await sq<{ assigned_to: string | null; current_assignment_id: string | null }>(
      f.db, `select assigned_to, current_assignment_id from public.leads where id = $1`, [lead],
    );
    expect(l).toEqual({ assigned_to: null, current_assignment_id: null });
    const [h] = await sq<{ end_reason: string }>(f.db, `select end_reason from public.lead_assignments where lead_id = $1`, [lead]);
    expect(h.end_reason).toBe('unassigned_manual');
  });
});

describe('contact workflow', () => {
  it('volunteer logs a call: counters, deadline clock stopped, timeline, status and follow-up', async () => {
    const lead = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [lead], f.volA1);

    const [res] = await q<{ r: { call_attempt_id: string; follow_up_id: string } }>(
      f.db, f.volA1,
      `select public.log_call_attempt($1, 'no_answer', 'Rang twice', null, 'follow_up_required', now() + interval '1 day', 'Try evening') as r`,
      [lead],
    );
    expect(res.r.call_attempt_id).toBeTruthy();
    expect(res.r.follow_up_id).toBeTruthy();

    const [l] = await sq<{ call_attempt_count: number; latest_call_outcome: string; status: string; last_contact_at: string; next_follow_up_at: string }>(
      f.db, `select call_attempt_count, latest_call_outcome, status, last_contact_at, next_follow_up_at from public.leads where id = $1`, [lead],
    );
    expect(l).toMatchObject({ call_attempt_count: 1, latest_call_outcome: 'no_answer', status: 'follow_up_required' });
    expect(l.last_contact_at).toBeTruthy();
    expect(l.next_follow_up_at).toBeTruthy();

    const [a] = await sq<{ first_contact_at: string | null }>(f.db, `select first_contact_at from public.lead_assignments where lead_id = $1 and ended_at is null`, [lead]);
    expect(a.first_contact_at).not.toBeNull();

    const [call] = await sq<{ caller_id: string; assignment_id: string }>(f.db, `select caller_id, assignment_id from public.call_attempts where lead_id = $1`, [lead]);
    expect(call.caller_id).toBe(f.volA1);
    expect(call.assignment_id).toBeTruthy();

    const types = (await q<{ type: string }>(f.db, f.volA1, `select type from public.lead_activities where lead_id = $1 order by id`, [lead])).map((r) => r.type);
    expect(types).toEqual(['created', 'assigned', 'status_changed', 'call_logged', 'status_changed', 'follow_up_scheduled']);
  });

  it('volunteer adds notes to assigned leads only', async () => {
    const mine = await createLead(f.db, f.teamA);
    const notMine = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [mine], f.volA1);
    const [n] = await q<{ author_id: string }>(f.db, f.volA1, `insert into public.lead_notes (lead_id, body) values ($1, 'Prefers Hindi') returning author_id`, [mine]);
    expect(n.author_id).toBe(f.volA1);
    await expect(
      q(f.db, f.volA1, `insert into public.lead_notes (lead_id, body) values ($1, 'x')`, [notMine]),
    ).rejects.toThrow(/row-level security/);
  });

  it('a reassigned volunteer loses access immediately, follow-ups move to the new owner', async () => {
    const lead = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [lead], f.volA1);
    await q(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '2 days', 'call back')`, [lead]);
    await assign(f.teacherA, [lead], f.volA2);

    await expect(q(f.db, f.volA1, `select public.log_call_attempt($1, 'connected')`, [lead])).rejects.toThrow(/no longer have access/);
    const [fu] = await sq<{ owner_id: string }>(f.db, `select owner_id from public.follow_ups where lead_id = $1`, [lead]);
    expect(fu.owner_id).toBe(f.volA2);
    // The new volunteer sees prior context.
    expect((await q(f.db, f.volA2, `select * from public.lead_assignments where lead_id = $1`, [lead])).length).toBe(2);
  });

  it('Do Not Contact blocks calls and follow-ups and cancels open ones', async () => {
    const lead = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [lead], f.volA1);
    await q(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '1 day')`, [lead]);
    await q(f.db, f.volA1, `select public.update_lead_status($1, 'do_not_contact', 'Asked not to be called')`, [lead]);

    const [fu] = await sq<{ status: string }>(f.db, `select status from public.follow_ups where lead_id = $1`, [lead]);
    expect(fu.status).toBe('cancelled');
    await expect(q(f.db, f.volA1, `select public.log_call_attempt($1, 'connected')`, [lead])).rejects.toThrow(/Do Not Contact/);
    await expect(q(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '1 day')`, [lead])).rejects.toThrow(/Do Not Contact/);
    const notes = await sq(f.db, `select body from public.lead_notes where lead_id = $1`, [lead]);
    expect(notes).toEqual([{ body: 'Asked not to be called' }]);
  });

  it('rejects unknown statuses and past follow-ups; completes follow-ups', async () => {
    const lead = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [lead], f.volA1);
    await expect(q(f.db, f.volA1, `select public.update_lead_status($1, 'bogus')`, [lead])).rejects.toThrow(/Unknown or inactive status/);
    await expect(q(f.db, f.volA1, `select public.schedule_follow_up($1, now() - interval '1 day')`, [lead])).rejects.toThrow(/future/);

    const [{ id }] = await q<{ id: string }>(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '3 hours') as id`, [lead]);
    await q(f.db, f.volA1, `select public.complete_follow_up($1)`, [id]);
    const [l] = await sq<{ next_follow_up_at: string | null }>(f.db, `select next_follow_up_at from public.leads where id = $1`, [lead]);
    expect(l.next_follow_up_at).toBeNull();
  });
});

describe('import, merge, archive', () => {
  it('imports valid rows, reports bad rows and duplicates', async () => {
    const existing = nextPhone();
    await createLead(f.db, f.teamA, { phone: existing });
    const rows = [
      { full_name: 'Imported One', phone: nextPhone(), source: 'event', source_detail: 'Mall stall' },
      { full_name: 'Bad Phone', phone: '12345' },
      { full_name: 'Dup', phone: existing },
    ];
    const [r] = await q<{ r: { inserted: number; errors: { row: number }[]; duplicates: { row: number }[] } }>(
      f.db, f.teacherA, `select public.import_leads($1, $2) as r`, [f.teamA, JSON.stringify(rows)],
    );
    expect(r.r.inserted).toBe(1);
    expect(r.r.errors.map((e) => e.row)).toEqual([2]);
    expect(r.r.duplicates.map((d) => d.row)).toEqual([3]);
  });

  it('import then assign: the importer can find and assign the new leads; other teams are refused', async () => {
    const phones = [nextPhone(), nextPhone()];
    const rows = phones.map((phone, i) => ({
      full_name: `Bulk ${i}`, phone, whatsapp_phone: null, email: null, source: 'satsang', source_detail: null,
      course_id: null, met_by_name: 'Anita', met_on: '2026-09-28', meeting_notes: null, notes: null,
    }));
    const [r] = await q<{ r: { inserted: number } }>(
      f.db, f.teacherA, `select public.import_leads($1, $2) as r`, [f.teamA, JSON.stringify(rows)],
    );
    expect(r.r.inserted).toBe(2);
    // Same lookup the web importer runs (through RLS) before assigning.
    const found = await q<{ id: string }>(
      f.db, f.teacherA,
      `select id from public.leads where team_id = $1 and created_by = $2 and assigned_to is null
         and created_at >= now() - interval '10 minutes' and phone = any($3)`,
      [f.teamA, f.teacherA, phones],
    );
    expect(found).toHaveLength(2);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [found.map((l) => l.id), f.volA1]);
    expect(await q(f.db, f.volA1, `select id from public.leads where phone = any($1)`, [phones])).toHaveLength(2);

    await expect(
      q(f.db, f.teacherA, `select public.import_leads($1, $2)`, [f.teamB, JSON.stringify(rows)]),
    ).rejects.toThrow(/Not authorised/);
    await expect(
      q(f.db, f.volA1, `select public.import_leads($1, $2)`, [f.teamA, JSON.stringify(rows)]),
    ).rejects.toThrow(/Not authorised/);
  });

  it('merges a duplicate, keeping its history visible from the kept lead', async () => {
    const phone = nextPhone();
    const keep = await createLead(f.db, f.teamA, { phone });
    const dup = await createLead(f.db, f.teamA, { phone, email: 'dup@example.org' });
    await assign(f.teacherA, [dup], f.volA2);
    await q(f.db, f.volA2, `select public.log_call_attempt($1, 'busy')`, [dup]);
    await assign(f.teacherA, [keep], f.volA1);

    await q(f.db, f.teacherA, `select public.merge_leads($1, $2)`, [keep, dup]);

    const [d] = await sq<{ merged_into_id: string; archived_at: string; assigned_to: string | null }>(
      f.db, `select merged_into_id, archived_at, assigned_to from public.leads where id = $1`, [dup],
    );
    expect(d.merged_into_id).toBe(keep);
    expect(d.archived_at).toBeTruthy();
    expect(d.assigned_to).toBeNull();
    const [k] = await sq<{ email: string; call_attempt_count: number }>(f.db, `select email, call_attempt_count from public.leads where id = $1`, [keep]);
    expect(k).toEqual({ email: 'dup@example.org', call_attempt_count: 1 });

    // volA1 holds the kept lead and can see the duplicate's call history.
    expect((await q(f.db, f.volA1, `select * from public.call_attempts where lead_id = $1`, [dup])).length).toBe(1);
    expect(await q(f.db, f.volA2, `select * from public.call_attempts where lead_id = $1`, [dup])).toEqual([]);
  });

  it('archives leads without deleting history', async () => {
    const lead = await createLead(f.db, f.teamA);
    await assign(f.teacherA, [lead], f.volA1);
    await q(f.db, f.teacherA, `select public.archive_leads($1, 'spam')`, [[lead]]);
    const [l] = await sq<{ archived_at: string; assigned_to: string | null }>(f.db, `select archived_at, assigned_to from public.leads where id = $1`, [lead]);
    expect(l.archived_at).toBeTruthy();
    expect(l.assigned_to).toBeNull();
    expect((await sq(f.db, `select 1 from public.lead_assignments where lead_id = $1`, [lead])).length).toBe(1);
    await expect(assign(f.teacherA, [lead], f.volA1)).resolves.toMatchObject({ assigned_count: 0 });
  });
});
