import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, svc, type Fixture } from '../src/db';

// Follow-up comments: volunteers comment on their own leads in Setu, or by writing
// to the Setu number on WhatsApp.
let f: Fixture;
const PHONE: Record<string, string> = {};
const jidOf = (phone: string) => `${phone.replace('+', '')}@s.whatsapp.net`;
let vinodKumar: string;
let vinod: string;
let priya: string;
let others: string;

beforeEach(async () => {
  f = await createFixture();
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  for (const [i, id] of [f.volA1, f.volA2].entries()) {
    PHONE[id] = `+91980000030${i}`;
    await sq(f.db, `update public.profiles set phone = $1 where id = $2`, [PHONE[id], id]);
  }
  vinodKumar = await createLead(f.db, f.teamA, { full_name: 'Vinod Kumar' });
  vinod = await createLead(f.db, f.teamA, { full_name: 'Vinod' });
  priya = await createLead(f.db, f.teamA, { full_name: 'Priya Verma' });
  others = await createLead(f.db, f.teamA, { full_name: 'Neha Singh' });
  await q(f.db, f.admin, `select public.assign_leads(array[$1, $2, $3]::uuid[], $4)`, [vinodKumar, vinod, priya, f.volA1]);
  await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [others, f.volA2]);
});

let n = 0;
async function write(from: string, text: string, chat = jidOf(PHONE[from]!)) {
  n += 1;
  const [m] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', $3, $4, 'Vol', $5, null, now()) as id`, [
    chat, `N${n}`, jidOf(PHONE[from]!), PHONE[from]!, text,
  ]);
  const [r] = await svc<{ r: { handled: boolean; lead_id?: string; reply?: string } }>(f.db, `select public.dv_volunteer_lead_note($1) as r`, [m!.id]);
  return r!.r;
}
const comments = (lead: string) =>
  sq<{ body: string; author_id: string; source: string; follow_up_id: string | null }>(
    f.db,
    `select body, author_id, source, follow_up_id from public.follow_up_comments where lead_id = $1 order by created_at`,
    [lead],
  );
const codeOf = async (lead: string) => (await sq<{ c: string }>(f.db, `select lead_code as c from public.leads where id = $1`, [lead]))[0]!.c;

describe('follow-up comments from WhatsApp', () => {
  it('by lead code: saved as a comment, with a confirmation (no follow-up scheduled)', async () => {
    const code = await codeOf(priya);
    const r = await write(f.volA1, `${code} called, she will come on Sunday`);
    expect(r).toMatchObject({ handled: true, lead_id: priya });
    expect(r.reply).toBe(`✅ Comment added to Priya Verma (${code}). There is no follow-up scheduled for this lead.`);
    expect(await comments(priya)).toEqual([{ body: `${code} called, she will come on Sunday`, author_id: f.volA1, source: 'whatsapp', follow_up_id: null }]);
    expect(await sq(f.db, `select type from public.lead_activities where lead_id = $1 and type = 'follow_up_comment'`, [priya])).toHaveLength(1);
    expect(await sq(f.db, `select body from public.wa_outbox where chat_jid = $1`, [jidOf(PHONE[f.volA1]!)])).toEqual([{ body: r.reply }]);
  });

  it("goes under the lead's next open follow-up", async () => {
    await q(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '3 days', 'later')`, [priya]);
    const [sooner] = await q<{ id: string }>(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '1 day', 'sooner') as id`, [priya]);
    const r = await write(f.volA1, 'Priya Verma not picking up');
    expect(r.reply).toMatch(/^✅ Comment added to the follow-up of Priya Verma \(L-\d+\), due /);
    expect((await comments(priya))[0]!.follow_up_id).toBe(sooner!.id);
  });

  it('by full name; the longest name wins ("Vinod Kumar" over "Vinod")', async () => {
    expect(await write(f.volA1, 'vinod kumar not picking up, try tomorrow')).toMatchObject({ handled: true, lead_id: vinodKumar });
    expect(await write(f.volA1, 'Priya coming for the intro talk')).toMatchObject({ handled: true, lead_id: priya }); // first name
  });

  it('two leads with the same first name: asks for the code, saves nothing', async () => {
    const r = await write(f.volA1, 'Vinod said yes');
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('More than one of your leads matches');
    expect(await comments(vinod)).toEqual([]);
    expect(await comments(vinodKumar)).toEqual([]);
  });

  it("never reaches someone else's lead", async () => {
    const r = await write(f.volA1, `${await codeOf(others)} called`);
    expect(r.reply).toMatch(/is not one of your leads/);
    expect(await write(f.volA1, 'Neha Singh called')).toEqual({ handled: false }); // just an ordinary message
    expect(await comments(others)).toEqual([]);
  });

  it('ignores groups, messages about no lead, and a switched-off number', async () => {
    expect(await write(f.volA1, 'Priya called', '120363000000000001@g.us')).toEqual({ handled: false });
    expect(await write(f.volA1, 'I want to do seva, share numbers')).toEqual({ handled: false });
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    expect(await write(f.volA1, 'Priya called')).toEqual({ handled: false });
    expect(await comments(priya)).toEqual([]);
  });

  it('only the gateway may call it', async () => {
    await expect(q(f.db, f.volA1, `select public.dv_volunteer_lead_note(gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });
});

describe('follow-up comments in Setu', () => {
  it('added only by someone who may act on the lead, and read only by those who see it', async () => {
    await q(f.db, f.volA1, `select public.add_follow_up_comment($1, null, 'spoke to her mother')`, [priya]);
    expect(await comments(priya)).toEqual([expect.objectContaining({ body: 'spoke to her mother', author_id: f.volA1, source: 'app' })]);
    await expect(q(f.db, f.volA2, `select public.add_follow_up_comment($1, null, 'x')`, [priya])).rejects.toThrow(/no longer have access/);
    expect(await q(f.db, f.volA2, `select * from public.follow_up_comments`)).toEqual([]);
    await expect(q(f.db, f.volA1, `insert into public.follow_up_comments (lead_id, body) values ($1, 'x')`, [priya])).rejects.toThrow(/permission denied/);
  });
});
