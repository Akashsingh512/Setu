import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, createUser, q, sq, svc, type Fixture } from '../src/db';

// Lead allotters: "Allot 5 leads to Srikesh" on WhatsApp.
let f: Fixture;
const PHONE: Record<string, string> = {};
const jidOf = (phone: string) => `${phone.replace('+', '')}@s.whatsapp.net`;

beforeEach(async () => {
  f = await createFixture();
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  for (const [i, id] of [f.teacherA, f.volA1, f.volA2].entries()) {
    PHONE[id] = `+91980000040${i}`;
    await sq(f.db, `update public.profiles set phone = $1 where id = $2`, [PHONE[id], id]);
  }
  await sq(f.db, `update public.profiles set full_name = 'Srikesh Rao' where id = $1`, [f.volA1]);
  for (let i = 0; i < 6; i++) await createLead(f.db, f.teamA);
});

let n = 0;
async function write(from: string, text: string) {
  n += 1;
  const [m] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', $1, $3, 'X', $4, null, now()) as id`, [
    jidOf(PHONE[from]!), `A${n}`, PHONE[from]!, text,
  ]);
  return m!.id;
}
const allot = async (from: string, count: number | null, target: string) => {
  const id = await write(from, `allot leads to ${target}`);
  return (await svc<{ r: { handled: boolean; assigned?: number; reply?: string } }>(f.db, `select public.dv_allot_by_whatsapp($1, $2, $3) as r`, [id, count, target]))[0]!.r;
};
const held = async (who: string) => (await sq<{ n: number }>(f.db, `select count(*)::int as n from public.leads where assigned_to = $1`, [who]))[0]!.n;
const outboxTo = (who: string) => sq<{ body: string; kind: string }>(f.db, `select body, kind from public.wa_outbox where chat_jid = $1 order by created_at`, [jidOf(PHONE[who]!)]);

describe('allotting leads on WhatsApp', () => {
  it('only chosen allotters; the super admin chooses them', async () => {
    expect(await allot(f.teacherA, 3, 'Srikesh')).toEqual({ handled: false });
    await expect(q(f.db, f.teacherA, `select public.dv_set_lead_allotter($1, true)`, [f.teacherA])).rejects.toThrow(/Only super admins/);
    await q(f.db, f.admin, `select public.dv_set_lead_allotter($1, true)`, [f.teacherA]);
    expect(await allot(f.teacherA, 3, 'Srikesh')).toMatchObject({ handled: true, assigned: 3 });
  });

  it('assigns, sends the leads to the person saying who allotted them, and confirms to the allotter', async () => {
    await sq(f.db, `update public.profiles set full_name = 'Aakash' where id = $1`, [f.teacherA]);
    await q(f.db, f.admin, `select public.dv_set_lead_allotter($1, true)`, [f.teacherA]);
    const r = await allot(f.teacherA, 2, 'srikesh');
    expect(r.reply).toMatch(/^✅ 2 lead\(s\) allotted to Srikesh Rao/);
    expect(await held(f.volA1)).toBe(2);
    const [sent] = await outboxTo(f.volA1);
    expect(sent!.kind).toBe('seva_numbers');
    expect(sent!.body).toContain('Aakash has allotted you 2 lead(s)');
    expect(sent!.body).toContain("saved on the lead's follow-up");
    const by = await sq<{ assigned_by: string; kind: string }>(f.db, `select assigned_by, kind from public.lead_assignments where assignee_id = $1`, [f.volA1]);
    expect(by.every((a) => a.assigned_by === f.teacherA && a.kind === 'manual')).toBe(true);

    // Their reply about one of those leads becomes a follow-up comment.
    const code = (await sq<{ c: string }>(f.db, `select lead_code as c from public.leads where assigned_to = $1 limit 1`, [f.volA1]))[0]!.c;
    const msg = await write(f.volA1, `${code} called, coming on Sunday`);
    const [note] = await svc<{ r: { handled: boolean } }>(f.db, `select public.dv_volunteer_lead_note($1) as r`, [msg]);
    expect(note!.r.handled).toBe(true);
    expect(await sq(f.db, `select 1 from public.follow_up_comments where body like $1`, [`${code} called%`])).toHaveLength(1);
  });

  it('by phone number, and clear answers when it cannot', async () => {
    await q(f.db, f.admin, `select public.dv_set_lead_allotter($1, true)`, [f.teacherA]);
    expect(await allot(f.teacherA, 1, PHONE[f.volA2]!.replace('+91', '+91 '))).toMatchObject({ assigned: 1 });
    expect((await allot(f.teacherA, 1, 'Nobody Here')).reply).toMatch(/Nobody Here is not in Setu yet\. What is Nobody's WhatsApp number\?/);
    await sq(f.db, `update public.profiles set max_open_leads = 1 where id = $1`, [f.volA2]);
    expect((await allot(f.teacherA, 3, PHONE[f.volA2]!)).reply).toMatch(/already holds 1 open lead/);
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    expect(await allot(f.teacherA, 1, 'Srikesh')).toEqual({ handled: false });
  });
});

describe('adding the person when they are not in Setu', () => {
  beforeEach(async () => {
    await q(f.db, f.admin, `select public.dv_set_lead_allotter($1, true)`, [f.teacherA]);
  });
  const answer = async (text: string) => {
    const id = await write(f.teacherA, text);
    return { id, r: (await svc<{ r: { handled: boolean; create?: { name: string; phone: string; team_id: string } } }>(f.db, `select public.dv_allot_continue($1) as r`, [id]))[0]!.r };
  };
  const lastReply = async () => (await outboxTo(f.teacherA)).at(-1)!.body;

  it('a name only: asks for the number, then the account is made and the leads go out with sign-in details', async () => {
    await allot(f.teacherA, 2, 'Akash Verma');
    expect(await lastReply()).toMatch(/Akash Verma is not in Setu yet\. What is Akash's WhatsApp number\?/);
    expect((await answer('not a number')).r.handled).toBe(true);
    expect(await lastReply()).toMatch(/Please send Akash Verma's WhatsApp number/);
    const { id, r } = await answer('98450 77777');
    expect(r.create).toMatchObject({ name: 'Akash Verma', phone: '+919845077777' });

    // What the gateway does: create the sign-in, then report back.
    const user = await createUser(f.db, { email: '919845077777@phone.setu.invalid', role: 'volunteer', teamId: r.create!.team_id, fullName: 'Akash Verma' });
    const [done] = await svc<{ r: { reply: string } }>(f.db, `select public.dv_allot_created($1, $2, 'akashjaigurudev', null, 'https://setu.example') as r`, [id, user]);
    expect(done!.r.reply).toMatch(/^Added Akash Verma \(\+919845077777\) to Setu as a volunteer in Team A/);
    expect(done!.r.reply).toMatch(/✅ 2 lead\(s\) allotted to Akash Verma/);
    const [p] = await sq<{ phone: string; team_id: string; must_change_password: boolean }>(f.db, `select phone, team_id, must_change_password from public.profiles where id = $1`, [user]);
    expect(p).toEqual({ phone: '+919845077777', team_id: f.teamA, must_change_password: true });
    const [toNew] = await sq<{ body: string }>(f.db, `select body from public.wa_outbox where chat_jid = '919845077777@s.whatsapp.net'`);
    expect(toNew!.body).toContain('Sign in at https://setu.example');
    expect(toNew!.body).toContain('Password: akashjaigurudev');
    expect(toNew!.body).toContain('allotted you 2 lead(s)');
  });

  it('a number only: asks for the name; CANCEL stops it', async () => {
    await allot(f.teacherA, 2, '+91 99887 66554');
    expect(await lastReply()).toMatch(/\+919988766554 is not in Setu yet\. What is their name\?/);
    const { r } = await answer('ravi kumar');
    expect(r.create).toMatchObject({ name: 'Ravi Kumar', phone: '+919988766554' });

    await allot(f.teacherA, 2, 'Someone New');
    await answer('cancel');
    expect(await lastReply()).toBe('Okay, cancelled. Nothing was allotted.');
    expect((await answer('98450 11111')).r.handled).toBe(false); // nothing pending any more
  });

  it('names match strictly: part of a name is not enough', async () => {
    await sq(f.db, `update public.profiles set full_name = 'Aakash' where id = $1`, [f.volA2]);
    await allot(f.teacherA, 1, 'akash');
    expect(await lastReply()).toMatch(/Akash is not in Setu yet/);
    expect(await held(f.volA2)).toBe(0);
  });
});


describe('editable allot messages', () => {
  it('a custom message is used, placeholders filled; the welcome must keep the sign-in details', async () => {
    await q(f.db, f.admin, `select public.dv_set_lead_allotter($1, true)`, [f.teacherA]);
    await expect(q(f.db, f.admin, `select public.dv_save_allot_messages('Hi {{name}}', null)`)).rejects.toThrow(/must contain \{\{leads\}\}/);
    await expect(q(f.db, f.admin, `select public.dv_save_allot_messages(null, 'Hi {{name}} {{leads}}')`)).rejects.toThrow(/cannot sign in/);
    await expect(q(f.db, f.volA1, `select public.dv_save_allot_messages('x {{leads}}', null)`)).rejects.toThrow(/Not authorised/);
    await q(f.db, f.admin, `select public.dv_save_allot_messages($1, null)`, ['Hari Om {{name}}! {{allotter}} sent {{count}}:\n{{leads}}Call in {{hours}}h.']);
    await allot(f.teacherA, 1, 'Srikesh');
    const [sent] = await outboxTo(f.volA1);
    expect(sent!.body).toMatch(/^Hari Om Srikesh! .+ sent 1:\n• .+\(L-\d+\)\nCall in \d+h\.$/);
  });
});
