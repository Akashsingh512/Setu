import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, svc, type Fixture } from '../src/db';

// Seva requests approved or declined by replying on WhatsApp.
let f: Fixture;
let groupId: string;
const GROUP = '120363000000000001@g.us';
const PHONE: Record<string, string> = {};
const jidOf = (phone: string) => `${phone.replace('+', '')}@s.whatsapp.net`;

beforeEach(async () => {
  f = await createFixture();
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'Seva group' }])]);
  groupId = (await sq<{ id: string }>(f.db, `select id from public.wa_groups`))[0]!.id;
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  await sq(f.db, `update public.wa_groups set enabled = true, allow_read = true, allow_seva_requests = true, allow_lead_assignment = true, mode = 'assisted' where id = $1`, [groupId]);
  for (const [i, id] of [f.volA1, f.volA2, f.teacherA, f.admin, f.teacherB].entries()) {
    PHONE[id] = `+91980000020${i}`;
    await sq(f.db, `update public.profiles set phone = $1 where id = $2`, [PHONE[id], id]);
  }
  // teacherA may assign seva and is a WhatsApp approver.
  await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{assign_seva}')`, [f.teacherA]);
  await q(f.db, f.admin, `select public.dv_set_whatsapp_approver($1, true)`, [f.teacherA]);
  for (let i = 0; i < 6; i++) await createLead(f.db, f.teamA);
});

let n = 0;
async function message(chat: string, phone: string | null, text: string) {
  n += 1;
  const [m] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', $3, $4, 'Someone', $5, null, now()) as id`, [
    chat, `M${n}`, phone ? jidOf(phone) : null, phone, text,
  ]);
  return m!.id;
}
async function askSeva(phone: string | null = PHONE[f.volA1]!) {
  const id = await message(GROUP, phone, 'I want to do seva, share numbers');
  await svc(f.db, `select public.dv_record_intent($1, 'seva_request', 'keywords')`, [id]);
  return (await sq<{ id: string; ref: number }>(f.db, `select id, ref from public.dv_seva_requests order by created_at desc limit 1`))[0]!;
}
async function reply(from: string, text: string, action: string, ref: number, count: number | null = null, reason: string | null = null) {
  const id = await message(jidOf(PHONE[from]!), PHONE[from]!, text);
  const [r] = await svc<{ r: { handled: boolean; reply?: string } }>(f.db, `select public.dv_seva_whatsapp_decision($1, $2, $3, $4, $5) as r`, [id, action, ref, count, reason]);
  return { messageId: id, ...r!.r };
}
const outboxTo = (phone: string) => sq<{ body: string; kind: string }>(f.db, `select body, kind from public.wa_outbox where chat_jid = $1 order by created_at`, [jidOf(phone)]);
const held = async (who: string) => (await sq<{ n: number }>(f.db, `select count(*)::int as n from public.leads where assigned_to = $1`, [who]))[0]!.n;
const status = async (id: string) => (await sq<{ status: string; reason: string | null; decided_by: string | null }>(f.db, `select status, reason, decided_by from public.dv_seva_requests where id = $1`, [id]))[0]!;

describe('asking approvers', () => {
  it('a waiting request sends a short private message to each approver', async () => {
    const req = await askSeva();
    const [msg] = await outboxTo(PHONE[f.teacherA]!);
    expect(msg!.kind).toBe('direct');
    expect(msg!.body).toContain(`Seva request #${req.ref}`);
    expect(msg!.body).toContain(`YES ${req.ref}`);
    expect(msg!.body).toContain(`NO ${req.ref}`);
    expect(msg!.body).toContain('Can receive up to 5 now · 6 free lead(s)');
    // Not to people who aren't approvers (even super admins), and lead numbers are never in it.
    expect(await outboxTo(PHONE[f.admin]!)).toEqual([]);
    // The volunteer only hears that the request is waiting.
    const toVolunteer = await outboxTo(PHONE[f.volA1]!);
    expect(toVolunteer).toHaveLength(1);
    expect(toVolunteer[0]!.body).toContain('has been received. A coordinator will approve it shortly');
    const phones = await sq<{ phone: string }>(f.db, `select phone from public.leads`);
    for (const p of phones) expect(msg!.body).not.toContain(p.phone);
  });

  it('a request assigned automatically does not ask anyone', async () => {
    await sq(f.db, `update public.wa_groups set mode = 'automatic' where id = $1`, [groupId]);
    await askSeva();
    expect(await outboxTo(PHONE[f.teacherA]!)).toEqual([]);
  });

  it('an unrecognised sender: approvers are told to confirm identity in Setu', async () => {
    const req = await askSeva('+919811122233');
    const [msg] = await outboxTo(PHONE[f.teacherA]!);
    expect(msg!.body).toContain('could not be matched to a volunteer');
    expect(msg!.body).not.toContain(`YES ${req.ref}`);
    const r = await reply(f.teacherA, `YES ${req.ref}`, 'approve', req.ref);
    expect(r.reply).toMatch(/confirm who this is in Setu first/);
    expect((await status(req.id)).status).toBe('pending');
  });

  it('an approver who has lost the permission is not asked', async () => {
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{}')`, [f.teacherA]);
    await askSeva();
    expect(await outboxTo(PHONE[f.teacherA]!)).toEqual([]);
  });
});

describe('deciding by reply', () => {
  it('YES approves: leads are assigned by the approver and sent to the volunteer', async () => {
    const req = await askSeva();
    const r = await reply(f.teacherA, `YES ${req.ref}`, 'approve', req.ref);
    expect(r).toMatchObject({ handled: true });
    expect(r.reply).toMatch(/approved: 5 lead\(s\) assigned/);
    expect(await status(req.id)).toMatchObject({ status: 'fulfilled', decided_by: f.teacherA });
    expect(await held(f.volA1)).toBe(5);
    const by = await sq<{ assigned_by: string }>(f.db, `select distinct assigned_by from public.lead_assignments where assignee_id = $1`, [f.volA1]);
    expect(by).toEqual([{ assigned_by: f.teacherA }]);
    // Confirmation back to the approver, numbers to the volunteer.
    expect((await outboxTo(PHONE[f.teacherA]!)).map((o) => o.body).some((b) => b.startsWith('✅'))).toBe(true);
    expect((await outboxTo(PHONE[f.volA1]!)).map((o) => o.kind)).toEqual(['direct', 'seva_numbers']); // "received", then the numbers
  });

  it('YES with a number approves only that many', async () => {
    const req = await askSeva();
    await reply(f.teacherA, `YES ${req.ref} 2`, 'approve', req.ref, 2);
    expect(await held(f.volA1)).toBe(2);
  });

  it('NO declines with the reason, and the volunteer is told', async () => {
    const req = await askSeva();
    const r = await reply(f.teacherA, `NO ${req.ref} finish current leads first`, 'decline', req.ref, null, 'finish current leads first');
    expect(r.reply).toMatch(/declined/);
    expect(await status(req.id)).toMatchObject({ status: 'rejected', reason: 'finish current leads first', decided_by: f.teacherA });
    const [note] = await sq<{ body: string }>(f.db, `select body from public.notifications where recipient_id = $1 and type = 'seva_request_declined'`, [f.volA1]);
    expect(note!.body).toBe('finish current leads first');
    expect(await held(f.volA1)).toBe(0);
    // And on WhatsApp, privately, with the reason.
    expect((await outboxTo(PHONE[f.volA1]!)).at(-1)!.body).toContain('could not be fulfilled this time.\nReason: finish current leads first');
  });

  it('with Digital Volunteer switched off, nobody is messaged', async () => {
    const req = await askSeva();
    await sq(f.db, `delete from public.wa_outbox`);
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    await q(f.db, f.admin, `select public.dv_seva_reject($1, 'no')`, [req.id]);
    expect(await sq(f.db, `select * from public.wa_outbox`)).toEqual([]);
  });

  it('a request is decided only once, however many replies arrive', async () => {
    const req = await askSeva();
    await reply(f.teacherA, `YES ${req.ref}`, 'approve', req.ref);
    const second = await reply(f.teacherA, `YES ${req.ref}`, 'approve', req.ref);
    expect(second.reply).toMatch(/already handled \(leads assigned\)/);
    const viaWeb = await askSeva(PHONE[f.volA2]!);
    await q(f.db, f.admin, `select public.dv_seva_reject($1)`, [viaWeb.id]);
    expect((await reply(f.teacherA, `YES ${viaWeb.ref}`, 'approve', viaWeb.ref)).reply).toMatch(/already handled \(declined\)/);
    expect(await held(f.volA1)).toBe(5);
  });

  it('the same WhatsApp message delivered twice is acted on once', async () => {
    const req = await askSeva();
    const { messageId } = await reply(f.teacherA, `YES ${req.ref}`, 'approve', req.ref);
    const [again] = await svc<{ r: { handled: boolean } }>(f.db, `select public.dv_seva_whatsapp_decision($1, 'approve', $2) as r`, [messageId, req.ref]);
    expect(again!.r.handled).toBe(false);
    expect((await outboxTo(PHONE[f.teacherA]!)).filter((o) => o.body.startsWith('✅'))).toHaveLength(1);
  });
});

describe('who may decide', () => {
  it('someone who is not an approver: treated as an ordinary message, nothing decided', async () => {
    const req = await askSeva();
    const r = await reply(f.volA2, `YES ${req.ref}`, 'approve', req.ref);
    expect(r).toEqual({ handled: false, messageId: r.messageId });
    expect((await sq<{ intent: string | null }>(f.db, `select intent from public.wa_messages where id = $1`, [r.messageId]))[0]!.intent).toBeNull();
    // A super admin who is not set up as an approver can't decide by WhatsApp either.
    expect((await reply(f.admin, `YES ${req.ref}`, 'approve', req.ref)).handled).toBe(false);
    expect((await status(req.id)).status).toBe('pending');
  });

  it('an approver whose permission was removed is refused', async () => {
    const req = await askSeva();
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{}')`, [f.teacherA]);
    const r = await reply(f.teacherA, `YES ${req.ref}`, 'approve', req.ref);
    expect(r.reply).toMatch(/no longer have permission/);
    expect((await status(req.id)).status).toBe('pending');
  });

  it('a deactivated approver is not recognised at all', async () => {
    const req = await askSeva();
    await sq(f.db, `update public.profiles set status = 'inactive' where id = $1`, [f.teacherA]);
    expect((await reply(f.teacherA, `YES ${req.ref}`, 'approve', req.ref)).handled).toBe(false);
  });

  it('nobody approves their own request, and they are not asked to', async () => {
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{assign_seva}')`, [f.volA1]);
    await q(f.db, f.admin, `select public.dv_set_whatsapp_approver($1, true)`, [f.volA1]);
    const req = await askSeva(PHONE[f.volA1]!);
    // Only the "received" acknowledgement, never an approval request.
    expect((await outboxTo(PHONE[f.volA1]!)).map((o) => o.body).some((b) => b.includes('YES'))).toBe(false);
    expect((await reply(f.volA1, `YES ${req.ref}`, 'approve', req.ref)).reply).toBe('You cannot approve your own request.');
    expect(await held(f.volA1)).toBe(0);
  });

  it('replies from a group never count', async () => {
    const req = await askSeva();
    const id = await message(GROUP, PHONE[f.teacherA]!, `YES ${req.ref}`);
    const [r] = await svc<{ r: { handled: boolean } }>(f.db, `select public.dv_seva_whatsapp_decision($1, 'approve', $2) as r`, [id, req.ref]);
    expect(r!.r.handled).toBe(false);
    expect((await status(req.id)).status).toBe('pending');
  });

  it('only integration managers choose approvers, who need the permission and a phone', async () => {
    await expect(q(f.db, f.teacherA, `select public.dv_set_whatsapp_approver($1, true)`, [f.teacherB])).rejects.toThrow(/Not authorised/);
    await expect(q(f.db, f.admin, `select public.dv_set_whatsapp_approver($1, true)`, [f.teacherB])).rejects.toThrow(/Assign seva leads/);
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{assign_seva}')`, [f.teacherB]);
    await sq(f.db, `update public.profiles set phone = null where id = $1`, [f.teacherB]);
    await expect(q(f.db, f.admin, `select public.dv_set_whatsapp_approver($1, true)`, [f.teacherB])).rejects.toThrow(/phone number/);
    await expect(q(f.db, f.admin, `select public.dv_seva_whatsapp_decision(gen_random_uuid(), 'approve', 1)`)).rejects.toThrow(/permission denied/);
  });
});
