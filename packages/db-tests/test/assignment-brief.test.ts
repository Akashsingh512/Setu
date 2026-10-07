import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, type Fixture } from '../src/db';

// Assigning in Setu can also send the leads, meeting notes and history on WhatsApp.
let f: Fixture;
let lead: string;

beforeEach(async () => {
  f = await createFixture();
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  await sq(f.db, `update public.profiles set phone = '+919800005555', full_name = 'Srikesh Rao' where id = $1`, [f.volA1]);
  lead = await createLead(f.db, f.teamA, { full_name: 'Ashish', meeting_notes: 'Student near Abhyassa', met_by_name: 'Tanisha', met_on: '2026-10-03' });
  await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [lead, f.volA2]);
  await q(f.db, f.volA2, `select public.log_call_attempt($1, 'no_answer', 'rang twice')`, [lead]);
  await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [lead, f.volA1]);
});

const brief = (who: string, notes: boolean, history: boolean) =>
  q<{ r: { sent: boolean; reason?: string; leads?: number } }>(f.db, who, `select public.dv_send_assignment_brief(array[$1]::uuid[], $2, $3, $4) as r`, [lead, f.volA1, notes, history]).then((x) => x[0]!.r);
const sent = () => sq<{ body: string }>(f.db, `select body from public.wa_outbox where chat_jid = '919800005555@s.whatsapp.net'`);

describe('assignment brief on WhatsApp', () => {
  it('sends the lead with meeting notes and history', async () => {
    expect(await brief(f.admin, true, true)).toMatchObject({ sent: true, leads: 1 });
    const [m] = await sent();
    expect(m!.body).toContain('assigned you 1 lead(s)');
    expect(m!.body).toContain('*Ashish*');
    expect(m!.body).toContain('Notes: Student near Abhyassa');
    expect(m!.body).toContain('Met: 03 Oct · Tanisha');
    expect(m!.body).toMatch(/History:\n {2}- \d{2} \w{3} Call \(no answer\): rang twice/);
  });

  it('only what is ticked; only leads now held by that volunteer; needs the permission and WhatsApp on', async () => {
    await brief(f.admin, false, false);
    const [m] = await sent();
    expect(m!.body).not.toContain('Notes:');
    expect(m!.body).not.toContain('History:');
    await expect(brief(f.volA2, true, true)).rejects.toThrow(/Not authorised/);
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    expect(await brief(f.admin, true, true)).toMatchObject({ sent: false, reason: expect.stringMatching(/switched off/) });
  });
});
