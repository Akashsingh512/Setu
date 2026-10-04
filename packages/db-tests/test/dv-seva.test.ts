import { beforeEach, describe, expect, it } from 'vitest';
import { ageOpenAssignment, createFixture, createLead, nextPhone, q, runReassignmentJob, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
let groupId: string;
const GROUP = '120363000000000001@g.us';
const PHONE: Record<string, string> = {};

beforeEach(async () => {
  f = await createFixture();
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'Seva group' }])]);
  groupId = (await sq<{ id: string }>(f.db, `select id from public.wa_groups`))[0]!.id;
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  // Volunteers have CRM phone numbers (this is how senders are recognised).
  for (const [i, id] of [f.volA1, f.volA2, f.volA3, f.volB1].entries()) {
    PHONE[id] = `+91980000010${i}`;
    await sq(f.db, `update public.profiles set phone = $1 where id = $2`, [PHONE[id], id]);
  }
  await group(`enabled = true, allow_read = true, allow_seva_requests = true, allow_lead_assignment = true, mode = 'automatic'`);
});

const group = (sql: string) => sq(f.db, `update public.wa_groups set ${sql} where id = $1`, [groupId]);
const grant = (who: string, perms: string[]) =>
  q(f.db, f.admin, `select public.dv_set_operator_permissions($1, $2::public.dv_permission[])`, [who, perms]);

async function makeLeads(n: number, team = f.teamA) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await createLead(f.db, team, { full_name: `Lead ${i + 1}` }));
  return ids;
}

let msgNo = 0;
type Result = { status?: string; seva?: { status?: string; assigned?: number; duplicate?: boolean; request_id?: string; verified?: boolean } };
async function ask(phone: string | null, text = 'Jai Gurudev, I want to do seva. Please share numbers', count: number | null = null, chat = GROUP, jid: string | null = null) {
  msgNo += 1;
  const [m] = await svc<{ id: string }>(
    f.db,
    `select public.dv_ingest_message($1, $2, 'in', $5, $3, 'Asker', $4, null, now()) as id`,
    [chat, `SEVA${msgNo}`, phone, text, jid],
  );
  const [r] = await svc<{ r: Result }>(f.db, `select public.dv_record_intent($1, 'seva_request', 'keywords', null, null, $2) as r`, [m!.id, count]);
  return { messageId: m!.id, ...r!.r };
}

const request = async (id?: string) =>
  (await sq<{ id: string; status: string; auto: boolean; assigned_count: number; requester_profile_id: string | null; reason: string | null }>(
    f.db, id ? `select * from public.dv_seva_requests where id = $1` : `select * from public.dv_seva_requests order by created_at desc limit 1`, id ? [id] : [],
  ))[0]!;
const held = async (who: string) =>
  (await sq<{ n: number }>(f.db, `select count(*)::int as n from public.leads where assigned_to = $1`, [who]))[0]!.n;
const outbox = () => sq<{ chat_jid: string; kind: string; body: string; status: string }>(f.db, `select chat_jid, kind, body, status from public.wa_outbox order by created_at`);

describe('automatic allocation', () => {
  it('a verified volunteer gets leads from their own team, privately', async () => {
    const mine = await makeLeads(8);
    const other = await makeLeads(3, f.teamB);
    const r = await ask(PHONE[f.volA1]!);

    expect(r.seva).toMatchObject({ status: 'fulfilled', assigned: 5 }); // default per-request limit
    expect(await held(f.volA1)).toBe(5);
    expect((await sq<{ n: number }>(f.db, `select count(*)::int as n from public.leads where id = any($1) and assigned_to is not null`, [other]))[0]!.n).toBe(0);
    expect((await request())).toMatchObject({ status: 'fulfilled', auto: true, assigned_count: 5, requester_profile_id: f.volA1 });

    // Normal assignment history, with the standard contact deadline.
    const rows = await sq<{ kind: string; assigned_by: string | null; hours: number }>(
      f.db, `select kind, assigned_by, round(extract(epoch from contact_deadline_at - now()) / 3600)::int as hours
               from public.lead_assignments where assignee_id = $1`, [f.volA1]);
    expect(rows).toHaveLength(5);
    expect(rows.every((x) => x.kind === 'seva_request' && x.assigned_by === null && x.hours === 24)).toBe(true);
    expect((await sq<{ status: string }>(f.db, `select status from public.leads where id = $1`, [mine[0]]))[0]!.status).toBe('assigned');
    expect((await sq<{ status: string }>(f.db, `select status from public.wa_messages where id = $1`, [r.messageId]))[0]!.status).toBe('processed');
  });

  it('numbers go by private message to the CRM number; the group only gets an acknowledgement', async () => {
    const mine = await makeLeads(2);
    const phones = await sq<{ phone: string }>(f.db, `select phone from public.leads where id = any($1)`, [mine]);
    await ask(PHONE[f.volA1]!);
    const out = await outbox();
    const dm = out.find((o) => o.kind === 'seva_numbers')!;
    const ack = out.find((o) => o.kind === 'reply')!;

    expect(dm.chat_jid).toBe(`${PHONE[f.volA1]!.replace('+', '')}@s.whatsapp.net`);
    expect(dm.status).toBe('queued');
    for (const p of phones) expect(dm.body).toContain(p.phone);
    expect(ack.chat_jid).toBe(GROUP);
    for (const p of phones) expect(ack.body).not.toContain(p.phone);
    expect(ack.body).not.toMatch(/Lead \d/);

    const n = await sq<{ title: string; data: { lead_ids: string[] } }>(f.db, `select title, data from public.notifications where recipient_id = $1 and type = 'lead_assigned'`, [f.volA1]);
    expect(n).toHaveLength(1);
    expect(n[0]!.data.lead_ids).toHaveLength(2);
    expect(await sq(f.db, `select * from public.audit_logs where action = 'dv.seva_assigned'`)).toHaveLength(1);
  });

  it('respects the number asked for', async () => {
    await makeLeads(8);
    expect((await ask(PHONE[f.volA1]!, 'share 3 numbers', 3)).seva).toMatchObject({ assigned: 3 });
  });

  it('only offers leads that are really free', async () => {
    const [free1, assigned, archived, closed, handedBack, free2] = await makeLeads(6);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[assigned], f.volA2]);
    await q(f.db, f.teacherA, `select public.archive_leads($1, 'spam')`, [[archived]]);
    await sq(f.db, `update public.leads set status = 'registered' where id = $1`, [closed]);
    // Handed back by a person: this volunteer may receive it again.
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[handedBack], f.volA1]);
    await q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[handedBack]]);

    await ask(PHONE[f.volA1]!);
    const got = (await sq<{ id: string }>(f.db, `select id from public.leads where assigned_to = $1`, [f.volA1])).map((l) => l.id).sort();
    expect(got).toEqual([free1, handedBack, free2].sort()); // not the assigned, archived or registered lead
    expect((await sq<{ assigned_to: string }>(f.db, `select assigned_to from public.leads where id = $1`, [assigned]))[0]!.assigned_to).toBe(f.volA2);
  });

  it('a lead the volunteer lost by missing the deadline is not given back to them, but others can have it', async () => {
    const [lead] = await makeLeads(1);
    await q(f.db, f.teacherA, `select public.assign_leads($1, $2)`, [[lead], f.volA1]);
    await ageOpenAssignment(f.db, lead!, 30);
    await runReassignmentJob(f.db); // moves it to another volunteer
    await q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[lead]]);
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ status: 'no_leads' });
    expect((await request()).reason).toMatch(/lost them earlier by missing the contact deadline/);
    expect((await ask(PHONE[f.volA2]!)).seva).toMatchObject({ status: 'fulfilled', assigned: 1 });
  });

  it('after an operator undoes an assignment, the volunteer can ask again and get leads', async () => {
    await makeLeads(2);
    await ask(PHONE[f.volA1]!);
    await q(f.db, f.admin, `select public.dv_seva_revoke($1)`, [(await request()).id]);
    expect(await held(f.volA1)).toBe(0);
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ status: 'fulfilled', assigned: 2 });
  });

  it('leads that need attention are handed out first', async () => {
    const ids = await makeLeads(3);
    await sq(f.db, `update public.leads set needs_attention = true where id = $1`, [ids[2]]);
    await ask(PHONE[f.volA1]!, 'one number please', 1);
    expect((await sq<{ id: string }>(f.db, `select id from public.leads where assigned_to = $1`, [f.volA1]))[0]!.id).toBe(ids[2]);
  });

  it('two volunteers asking never receive the same lead', async () => {
    await makeLeads(7);
    await ask(PHONE[f.volA1]!);
    await ask(PHONE[f.volA2]!);
    const all = await sq<{ lead_id: string }>(f.db, `select lead_id from public.dv_seva_request_leads`);
    expect(all).toHaveLength(7);
    expect(new Set(all.map((a) => a.lead_id)).size).toBe(7);
    expect(await held(f.volA2)).toBe(2);
  });

  it('with no free leads the request is closed and the volunteer is told', async () => {
    const r = await ask(PHONE[f.volA1]!);
    expect(r.seva).toMatchObject({ status: 'no_leads' });
    expect((await request()).status).toBe('no_leads');
    expect(await sq(f.db, `select * from public.notifications where recipient_id = $1 and type = 'seva_request_declined'`, [f.volA1])).toHaveLength(1);
    // Told on WhatsApp too (privately: the request came from a group), and the team's staff are told in Setu.
    const out = await outbox();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ chat_jid: `${PHONE[f.volA1]!.replace('+', '')}@s.whatsapp.net`, kind: 'direct' });
    expect(out[0]!.body).toContain('All leads are already assigned right now');
    expect(await sq(f.db, `select * from public.notifications where type = 'seva_no_leads'`)).not.toHaveLength(0);
  });
});

describe('limits', () => {
  const setLimit = (sql: string) => sq(f.db, `insert into public.dv_seva_limits (profile_id, ${sql.split('|')[0]}) values ($1, ${sql.split('|')[1]}) on conflict (profile_id) do update set ${sql.split('|')[0]
    .split(',').map((c) => `${c.trim()} = excluded.${c.trim()}`).join(', ')}`, [f.volA1]);

  it('a person-specific limit replaces the default; a group limit can lower it further', async () => {
    await makeLeads(15);
    await setLimit('per_request|8');
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ assigned: 8 });
    await group(`max_leads_per_request = 2`);
    expect((await ask(PHONE[f.volA2]!)).seva).toMatchObject({ assigned: 2 });
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ assigned: 2 }); // group cap beats the personal 8
  });

  it('temporary exceptions raise the count, and stop applying when they expire', async () => {
    await makeLeads(20);
    await setLimit(`exception_per_request, exception_until|9, now() + interval '1 day'`);
    expect((await ask(PHONE[f.volA1]!, 'share 20 numbers', 20)).seva).toMatchObject({ assigned: 9 });
    await sq(f.db, `update public.dv_seva_limits set exception_until = now() - interval '1 minute' where profile_id = $1`, [f.volA1]);
    expect((await ask(PHONE[f.volA1]!, 'share 20 numbers', 20)).seva).toMatchObject({ assigned: 5 });
  });

  it('cannot exceed the maximum number of open leads', async () => {
    await makeLeads(10);
    await sq(f.db, `update public.dv_seva_settings set default_max_active = 7 where id`);
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ assigned: 5 });
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ assigned: 2 }); // 5 + 2 = 7
    const third = await ask(PHONE[f.volA1]!);
    expect(third.seva).toMatchObject({ status: 'rejected' });
    expect((await request()).reason).toMatch(/maximum number of open leads/);
  });

  it("the volunteer's normal workload cap also applies", async () => {
    await makeLeads(10);
    await sq(f.db, `update public.profiles set max_open_leads = 3 where id = $1`, [f.volA1]);
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ assigned: 3 });
  });

  it('daily limit', async () => {
    await makeLeads(12);
    await sq(f.db, `update public.dv_seva_settings set daily_limit = 6 where id`);
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ assigned: 5 });
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ assigned: 1 });
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ status: 'rejected' });
    expect((await request()).reason).toBe('Daily limit reached');
  });

  it('only integration managers change limits; exceptions are time-boxed', async () => {
    await grant(f.teacherA, ['assign_seva']);
    await expect(
      q(f.db, f.teacherA, `select public.dv_save_seva_limit($1, 9, null, null, null)`, [f.volA1]),
    ).rejects.toThrow(/Not authorised/);
    await expect(
      q(f.db, f.admin, `select public.dv_save_seva_limit($1, 5, null, null, null, 20, now() + interval '90 days')`, [f.volA1]),
    ).rejects.toThrow(/31 days/);
    await q(f.db, f.admin, `select public.dv_save_seva_limit($1, 9, 12, null, null)`, [f.volA1]);
    expect((await sq<{ per_request: number }>(f.db, `select per_request from public.dv_seva_limits`))[0]!.per_request).toBe(9);
    await q(f.db, f.admin, `select public.dv_save_seva_limit($1, null, null, null, null)`, [f.volA1]); // clearing removes the row
    expect(await sq(f.db, `select * from public.dv_seva_limits`)).toEqual([]);
  });
});

describe('approval and identity', () => {
  it('assisted mode: a request waits and nothing is assigned until a person approves', async () => {
    await group(`mode = 'assisted'`);
    await makeLeads(6);
    const r = await ask(PHONE[f.volA1]!);
    expect(r.seva).toMatchObject({ status: 'pending', verified: true });
    expect(await held(f.volA1)).toBe(0);
    expect((await outbox()).map((o) => o.body)).toEqual([expect.stringContaining('has been received')]);
    expect((await sq(f.db, `select * from public.notifications where type = 'seva_request_pending'`)).length).toBeGreaterThan(0);

    const id = (await request()).id;
    const [preview] = await q<{ p: { allowed: number; available: number } }>(f.db, f.admin, `select public.dv_seva_preview($1) as p`, [id]);
    expect(preview!.p).toMatchObject({ allowed: 5, available: 6 });

    const [done] = await q<{ r: { assigned: number } }>(f.db, f.admin, `select public.dv_seva_approve($1, 3) as r`, [id]); // approve fewer
    expect(done!.r.assigned).toBe(3);
    expect(await held(f.volA1)).toBe(3);
    expect(await request()).toMatchObject({ status: 'fulfilled', auto: false });
    const rows = await sq<{ assigned_by: string }>(f.db, `select assigned_by from public.lead_assignments where assignee_id = $1`, [f.volA1]);
    expect(rows.every((x) => x.assigned_by === f.admin)).toBe(true);
    await expect(q(f.db, f.admin, `select public.dv_seva_approve($1)`, [id])).rejects.toThrow(/already handled/);
  });

  it('automatic mode still waits if the group has not allowed lead assignment, or auto replies are paused', async () => {
    await makeLeads(6);
    await group(`allow_lead_assignment = false`);
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ status: 'pending' });
    await group(`allow_lead_assignment = true`);
    await sq(f.db, `update public.wa_account set auto_paused = true where id`);
    expect((await ask(PHONE[f.volA2]!)).seva).toMatchObject({ status: 'pending' });
    expect(await held(f.volA1)).toBe(0);
  });

  it('an unknown number gets nothing until an operator identifies them', async () => {
    await makeLeads(6);
    const r = await ask('+919811122233');
    expect(r.seva).toMatchObject({ status: 'pending', verified: false });
    const id = (await request()).id;
    await expect(q(f.db, f.admin, `select public.dv_seva_approve($1)`, [id])).rejects.toThrow(/Identify/);
    // Unknown, so the acknowledgement goes to the group it came from, with no lead data.
    expect(await outbox()).toEqual([expect.objectContaining({ chat_jid: GROUP, kind: 'reply' })]);

    await q(f.db, f.admin, `select public.dv_seva_set_requester($1, $2)`, [id, f.volA2]);
    await q(f.db, f.admin, `select public.dv_seva_approve($1)`, [id]);
    expect(await held(f.volA2)).toBe(5);
    // Numbers are sent to the identified volunteer's CRM number, not the number that wrote.
    expect((await outbox()).find((o) => o.kind === 'seva_numbers')!.chat_jid).toBe(`${PHONE[f.volA2]!.replace('+', '')}@s.whatsapp.net`);
    expect(await sq(f.db, `select * from public.audit_logs where action = 'dv.seva_identified'`)).toHaveLength(1);
  });

  it('only permitted operators decide, and nobody approves their own request', async () => {
    await group(`mode = 'assisted'`);
    await makeLeads(6);
    await ask(PHONE[f.volA1]!);
    const id = (await request()).id;

    await expect(q(f.db, f.volA2, `select public.dv_seva_approve($1)`, [id])).rejects.toThrow(/Not authorised/);
    await expect(q(f.db, f.teacherA, `select public.dv_seva_approve($1)`, [id])).rejects.toThrow(/Not authorised/);
    await grant(f.volA1, ['assign_seva']);
    await expect(q(f.db, f.volA1, `select public.dv_seva_approve($1)`, [id])).rejects.toThrow(/your own request/);
    await grant(f.teacherA, ['assign_seva']);
    await q(f.db, f.teacherA, `select public.dv_seva_approve($1)`, [id]);
    expect(await held(f.volA1)).toBe(5);
  });

  it('rejecting records the reason and tells the volunteer', async () => {
    await group(`mode = 'assisted'`);
    await ask(PHONE[f.volA1]!);
    const id = (await request()).id;
    await q(f.db, f.admin, `select public.dv_seva_reject($1, 'Please finish your current leads first')`, [id]);
    expect(await request()).toMatchObject({ status: 'rejected', reason: 'Please finish your current leads first' });
    const [n] = await sq<{ body: string }>(f.db, `select body from public.notifications where type = 'seva_request_declined'`);
    expect(n!.body).toContain('finish your current leads');
    await expect(q(f.db, f.admin, `select public.dv_seva_reject($1)`, [id])).rejects.toThrow(/already handled/);
  });

  it('repeated asking does not pile up requests', async () => {
    await group(`mode = 'assisted'`);
    await ask(PHONE[f.volA1]!);
    const again = await ask(PHONE[f.volA1]!);
    expect(again.seva).toMatchObject({ duplicate: true });
    expect(again.status).toBe('ignored');
    expect(await sq(f.db, `select * from public.dv_seva_requests`)).toHaveLength(1);
    // Redelivering the same message through the recorder does nothing either.
    const [dup] = await svc<{ r: { skipped?: boolean } }>(f.db, `select public.dv_record_intent($1, 'seva_request', 'keywords') as r`, [again.messageId]);
    expect(dup!.r.skipped).toBe(true);
  });
});

describe('where requests are accepted', () => {
  it.each([
    ['group not enabled', `enabled = false`],
    ['seva requests not allowed in the group', `allow_seva_requests = false`],
    ['reading not allowed', `allow_read = false`],
  ])('%s: no request is created', async (_n, sql) => {
    await makeLeads(3);
    await group(sql);
    const r = await ask(PHONE[f.volA1]!);
    expect(r.seva).toBeUndefined();
    expect(await sq(f.db, `select * from public.dv_seva_requests`)).toEqual([]);
    expect(await held(f.volA1)).toBe(0);
  });

  it('emergency switch off: no request, no assignment', async () => {
    await makeLeads(3);
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    await ask(PHONE[f.volA1]!);
    expect(await sq(f.db, `select * from public.dv_seva_requests`)).toEqual([]);
  });

  it('direct chats follow their own switch', async () => {
    await makeLeads(3);
    const dm = `${PHONE[f.volA1]!.replace('+', '')}@s.whatsapp.net`;
    expect((await ask(PHONE[f.volA1]!, undefined, null, dm)).seva).toBeUndefined();
    await sq(f.db, `update public.wa_account set dm_seva_requests = true, dm_mode = 'automatic' where id`);
    expect((await ask(PHONE[f.volA1]!, undefined, null, dm)).seva).toMatchObject({ status: 'fulfilled', assigned: 3 });
    // Direct request: the numbers message is the answer, so there is no group acknowledgement.
    expect((await outbox()).map((o) => o.kind)).toEqual(['seva_numbers']);
  });
});

describe('correcting and the 24-hour rule', () => {
  it('revoking takes back leads nobody has called yet, and keeps the rest', async () => {
    await makeLeads(4);
    await ask(PHONE[f.volA1]!);
    const id = (await request()).id;
    const mine = await sq<{ id: string }>(f.db, `select id from public.leads where assigned_to = $1 order by created_at`, [f.volA1]);
    await q(f.db, f.volA1, `select public.log_call_attempt($1, 'no_answer')`, [mine[0]!.id]);

    await expect(q(f.db, f.teacherA, `select public.dv_seva_revoke($1)`, [id])).rejects.toThrow(/Not authorised/);
    const [res] = await q<{ r: { revoked: number; kept: number } }>(f.db, f.admin, `select public.dv_seva_revoke($1) as r`, [id]);
    expect(res!.r).toEqual({ revoked: 3, kept: 1 });
    expect(await held(f.volA1)).toBe(1);
    const history = await sq<{ end_reason: string | null }>(f.db, `select end_reason from public.lead_assignments where lead_id = $1`, [mine[1]!.id]);
    expect(history.map((h) => h.end_reason)).toEqual(['unassigned_manual']); // history kept, not deleted
    expect((await q<{ r: { revoked: number } }>(f.db, f.admin, `select public.dv_seva_revoke($1) as r`, [id]))[0]!.r.revoked).toBe(0); // safe to repeat
  });

  it('seva-assigned leads follow the normal 24-hour reassignment', async () => {
    const [lead] = await makeLeads(1);
    await ask(PHONE[f.volA1]!);
    await ageOpenAssignment(f.db, lead!, 30);
    const job = await runReassignmentJob(f.db);
    expect(job.reassigned).toBe(1);
    const [l] = await sq<{ assigned_to: string }>(f.db, `select assigned_to from public.leads where id = $1`, [lead]);
    expect(l!.assigned_to).not.toBe(f.volA1);
    // ...and the volunteer who lost it cannot take it straight back through a new request.
    await q(f.db, f.teacherA, `select public.unassign_leads($1)`, [[lead]]);
    expect((await ask(PHONE[f.volA1]!)).seva).toMatchObject({ status: 'no_leads' });
  });

  it('seva records are not visible to ordinary users', async () => {
    await makeLeads(2);
    await ask(PHONE[f.volA1]!);
    expect(await q(f.db, f.volA1, `select * from public.dv_seva_requests`)).toEqual([]);
    expect(await q(f.db, f.teacherA, `select * from public.dv_seva_requests`)).toEqual([]);
    await expect(q(f.db, f.volA1, `select public.dv_record_intent(gen_random_uuid(), 'none', 'keywords')`)).rejects.toThrow(/permission denied/);
    expect(nextPhone()).toBeTruthy();
  });
});

describe('remembering senders whose number WhatsApp hides', () => {
  const LID = '21024435367979@lid';

  it('confirming identity once makes the next request automatic', async () => {
    await makeLeads(12);
    const first = await ask(null, undefined, null, GROUP, LID); // no phone, hidden id only
    expect(first.seva).toMatchObject({ status: 'pending', verified: false });
    const id = (await request()).id;

    await q(f.db, f.admin, `select public.dv_seva_set_requester($1, $2)`, [id, f.volA1]);
    expect(await sq(f.db, `select sender_jid, profile_id from public.dv_sender_links`)).toEqual([{ sender_jid: LID, profile_id: f.volA1 }]);
    await q(f.db, f.admin, `select public.dv_seva_approve($1)`, [id]);
    expect(await held(f.volA1)).toBe(5);

    const again = await ask(null, undefined, null, GROUP, LID);
    expect(again.seva).toMatchObject({ status: 'fulfilled', assigned: 5 });
    expect((await request()).requester_profile_id).toBe(f.volA1);
    expect(await held(f.volA1)).toBe(10);
  });

  it('a remembered sender can be forgotten, after which they are unrecognised again', async () => {
    await makeLeads(4);
    await ask(null, undefined, null, GROUP, LID);
    await q(f.db, f.admin, `select public.dv_seva_set_requester($1, $2)`, [(await request()).id, f.volA1]);
    await q(f.db, f.admin, `select public.dv_seva_reject($1)`, [(await request()).id]);

    await expect(q(f.db, f.teacherA, `select public.dv_seva_unlink_sender($1)`, [LID])).rejects.toThrow(/Not authorised/);
    await q(f.db, f.admin, `select public.dv_seva_unlink_sender($1)`, [LID]);
    expect(await sq(f.db, `select * from public.dv_sender_links`)).toEqual([]);
    expect((await ask(null, undefined, null, GROUP, LID)).seva).toMatchObject({ status: 'pending', verified: false });
  });

  it('a link to a volunteer who has been deactivated is ignored', async () => {
    await makeLeads(4);
    await sq(f.db, `insert into public.dv_sender_links (sender_jid, profile_id) values ($1, $2)`, [LID, f.volA2]);
    await sq(f.db, `update public.profiles set status = 'inactive' where id = $1`, [f.volA2]);
    expect((await ask(null, undefined, null, GROUP, LID)).seva).toMatchObject({ status: 'pending', verified: false });
  });

  it('repeated asks from the same hidden-number sender do not pile up', async () => {
    await group(`mode = 'assisted'`);
    await ask(null, undefined, null, GROUP, LID);
    expect((await ask(null, undefined, null, GROUP, LID)).seva).toMatchObject({ duplicate: true });
    expect(await sq(f.db, `select * from public.dv_seva_requests`)).toHaveLength(1);
  });

  it('only people who may assign seva can see or change the links', async () => {
    await sq(f.db, `insert into public.dv_sender_links (sender_jid, profile_id) values ($1, $2)`, [LID, f.volA1]);
    expect(await q(f.db, f.volA1, `select * from public.dv_sender_links`)).toEqual([]);
    expect(await q(f.db, f.teacherA, `select * from public.dv_sender_links`)).toEqual([]);
    expect(await q(f.db, f.admin, `select * from public.dv_sender_links`)).toHaveLength(1);
  });
});

describe('delivery and repeats', () => {
  const LID = '21024435367979@lid';

  it('a private chat gets its numbers in that chat, even if the volunteer has no phone saved in Setu', async () => {
    await sq(f.db, `update public.profiles set phone = null where id = $1`, [f.volA1]);
    await sq(f.db, `insert into public.dv_sender_links (sender_jid, profile_id) values ($1, $2)`, [LID, f.volA1]);
    await sq(f.db, `update public.wa_account set dm_seva_requests = true, dm_mode = 'automatic' where id`);
    const [a] = await makeLeads(1);
    const [row] = await sq<{ full_name: string; phone: string }>(f.db, `select full_name, phone from public.leads where id = $1`, [a]);

    const r = await ask(null, undefined, null, LID, LID);
    expect(r.seva).toMatchObject({ status: 'fulfilled', assigned: 1 });
    const out = await outbox();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ chat_jid: LID, kind: 'seva_numbers', status: 'queued' });
    expect(out[0]!.body).toContain(row!.full_name);
    expect(out[0]!.body).toContain(row!.phone);
  });

  it('a group request with no phone saved: nothing is posted in the group except an acknowledgement without details', async () => {
    await sq(f.db, `update public.profiles set phone = null where id = $1`, [f.volA1]);
    await sq(f.db, `insert into public.dv_sender_links (sender_jid, profile_id) values ($1, $2)`, [LID, f.volA1]);
    const [a] = await makeLeads(1);
    const [row] = await sq<{ phone: string }>(f.db, `select phone from public.leads where id = $1`, [a]);
    expect((await ask(null, undefined, null, GROUP, LID)).seva).toMatchObject({ status: 'fulfilled' });
    const out = await outbox();
    expect(out.map((o) => o.kind)).toEqual(['reply']);
    expect(out[0]!.chat_jid).toBe(GROUP);
    expect(out[0]!.body).not.toContain(row!.phone);
    expect(out[0]!.body).toContain('My Leads');
  });

  it('a second message from the same phone while one is waiting is a repeat, even after the first was identified', async () => {
    await group(`mode = 'assisted'`);
    await makeLeads(3);
    const stranger = '+919811122233';
    await ask(stranger);
    await q(f.db, f.admin, `select public.dv_seva_set_requester($1, $2)`, [(await request()).id, f.volA1]);
    expect((await ask(stranger)).seva).toMatchObject({ duplicate: true });
    expect(await sq(f.db, `select * from public.dv_seva_requests`)).toHaveLength(1);
  });

  it('the operator is told why nobody can be given leads', async () => {
    await group(`mode = 'assisted'`);
    const [only] = await makeLeads(1);
    await sq(f.db, `update public.leads set status = 'registered' where id = $1`, [only]);
    await ask(PHONE[f.volA1]!);
    const [p] = await q<{ p: { allowed: number; available: number; unassigned_total: number; reason: string } }>(
      f.db, f.admin, `select public.dv_seva_preview($1) as p`, [(await request()).id]);
    expect(p!.p).toMatchObject({ allowed: 5, available: 0, unassigned_total: 1 });
    expect(p!.p.reason).toMatch(/1 unassigned lead\(s\) exist, but they are closed/);
  });
});
