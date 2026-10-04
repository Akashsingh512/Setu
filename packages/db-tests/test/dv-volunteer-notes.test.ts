import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, svc, type Fixture } from '../src/db';

// Volunteers comment on their own leads by writing to the Setu number.
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
const notes = (lead: string) => sq<{ body: string; author_id: string }>(f.db, `select body, author_id from public.lead_notes where lead_id = $1`, [lead]);
const codeOf = async (lead: string) => (await sq<{ c: string }>(f.db, `select lead_code as c from public.leads where id = $1`, [lead]))[0]!.c;

describe('comments on leads from WhatsApp', () => {
  it('by lead code: saved as the volunteer\'s note, with a confirmation', async () => {
    const code = await codeOf(priya);
    const r = await write(f.volA1, `${code} called, she will come on Sunday`);
    expect(r).toMatchObject({ handled: true, lead_id: priya });
    expect(r.reply).toBe(`✅ Note added to Priya Verma (${code}).`);
    expect(await notes(priya)).toEqual([{ body: `WhatsApp: ${code} called, she will come on Sunday`, author_id: f.volA1 }]);
    expect(await sq(f.db, `select type from public.lead_activities where lead_id = $1 and type = 'note_added'`, [priya])).toHaveLength(1);
    expect(await sq(f.db, `select body from public.wa_outbox where chat_jid = $1`, [jidOf(PHONE[f.volA1]!)])).toEqual([{ body: r.reply }]);
  });

  it('by full name; the longest name wins ("Vinod Kumar" over "Vinod")', async () => {
    expect(await write(f.volA1, 'vinod kumar not picking up, try tomorrow')).toMatchObject({ handled: true, lead_id: vinodKumar });
    expect(await write(f.volA1, 'Priya coming for the intro talk')).toMatchObject({ handled: true, lead_id: priya }); // first name
  });

  it('two leads with the same first name: asks for the code, saves nothing', async () => {
    const r = await write(f.volA1, 'Vinod said yes');
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('More than one of your leads matches');
    expect(await notes(vinod)).toEqual([]);
    expect(await notes(vinodKumar)).toEqual([]);
  });

  it("never reaches someone else's lead", async () => {
    const r = await write(f.volA1, `${await codeOf(others)} called`);
    expect(r.reply).toMatch(/is not one of your leads/);
    expect(await write(f.volA1, 'Neha Singh called')).toEqual({ handled: false }); // just an ordinary message
    expect(await notes(others)).toEqual([]);
  });

  it('ignores groups, unknown senders, messages about no lead, and a switched-off number', async () => {
    expect(await write(f.volA1, 'Priya called', '120363000000000001@g.us')).toEqual({ handled: false });
    expect(await write(f.volA1, 'I want to do seva, share numbers')).toEqual({ handled: false });
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    expect(await write(f.volA1, 'Priya called')).toEqual({ handled: false });
    expect(await notes(priya)).toEqual([]);
  });

  it('only the gateway may call it', async () => {
    await expect(q(f.db, f.volA1, `select public.dv_volunteer_lead_note(gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });
});
