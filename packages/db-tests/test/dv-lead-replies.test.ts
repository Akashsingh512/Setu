import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, nextPhone, q, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
let leadId: string;
let phone: string;
const GROUP = '120363000000000001@g.us';

beforeEach(async () => {
  f = await createFixture();
  phone = nextPhone();
  leadId = await createLead(f.db, f.teamA, { phone });
  await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [leadId, f.volA1]);
  await sq(f.db, `update public.wa_account set enabled = true, dm_followup_sync = true where id`);
});

let n = 0;
async function fromLead(body = 'Yes I will come on Sunday', chat = `${phone.slice(1)}@s.whatsapp.net`) {
  n += 1;
  const [r] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', $1, $3, 'Lead', $4, null, now()) as id`, [
    chat,
    `M${n}`,
    phone,
    body,
  ]);
  return r!.id;
}
const timeline = () =>
  sq<{ type: string; actor_id: string | null; data: Record<string, unknown> }>(
    f.db,
    `select type, actor_id, data from public.lead_activities where lead_id = $1 and type = 'whatsapp_received' order by id`,
    [leadId],
  );
const notes = () => sq(f.db, `select * from public.notifications where recipient_id = $1 and type = 'lead_whatsapp_reply'`, [f.volA1]);

describe('lead replies on the timeline', () => {
  it('a private message from the lead is logged and the assignee is told, without counting as a call', async () => {
    const id = await fromLead();
    expect(await timeline()).toEqual([{ type: 'whatsapp_received', actor_id: null, data: { message_id: id, preview: 'Yes I will come on Sunday' } }]);
    const [lead] = await sq<{ call_attempt_count: number; last_contact_at: string | null }>(
      f.db,
      `select call_attempt_count, last_contact_at from public.leads where id = $1`,
      [leadId],
    );
    expect(lead).toEqual({ call_attempt_count: 0, last_contact_at: null });
    const [a] = await sq<{ first_contact_at: string | null }>(f.db, `select first_contact_at from public.lead_assignments where lead_id = $1 and ended_at is null`, [leadId]);
    expect(a!.first_contact_at).toBeNull();
    // Notification has no personal data, and links to the lead.
    const [note] = (await notes()) as { title: string; body: string; data: { lead_id: string } }[];
    expect(note!.title).not.toContain(phone);
    expect(note!.data.lead_id).toBe(leadId);
  });

  it('the assignee sees it on the timeline; notifications are not repeated within 30 minutes', async () => {
    await fromLead('one');
    await fromLead('two');
    expect(await q(f.db, f.volA1, `select type from public.lead_activities where lead_id = $1 and type = 'whatsapp_received'`, [leadId])).toHaveLength(2);
    expect(await notes()).toHaveLength(1);
  });

  it('nothing is logged when the setting is off, or for group messages', async () => {
    await sq(f.db, `update public.wa_account set dm_followup_sync = false where id`);
    await fromLead();
    await sq(f.db, `update public.wa_account set dm_followup_sync = true where id`);
    await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'G' }])]);
    await fromLead('in a group', GROUP);
    expect(await timeline()).toEqual([]);
    expect(await notes()).toEqual([]);
  });

  it('a number shared by two leads is not linked to either', async () => {
    await createLead(f.db, f.teamA, { phone });
    await fromLead();
    expect(await timeline()).toEqual([]);
  });
});

describe('confirming follow-ups from WhatsApp', () => {
  let followUp: string;
  beforeEach(async () => {
    [{ id: followUp }] = (await q<{ id: string }>(f.db, f.volA1, `select public.schedule_follow_up($1, now() + interval '1 day', 'Call back') as id`, [
      leadId,
    ])) as [{ id: string }];
  });

  it('needs the Update follow-ups permission', async () => {
    const msg = await fromLead();
    await expect(q(f.db, f.teacherB, `select public.dv_confirm_followup($1, $2)`, [msg, followUp])).rejects.toThrow(/Not authorised/);
    await expect(q(f.db, f.teacherB, `select * from public.dv_followup_candidates($1)`, [`${phone.slice(1)}@s.whatsapp.net`])).rejects.toThrow(/Not authorised/);
  });

  it('closes the follow-up and records it on the timeline, once', async () => {
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{update_followups}')`, [f.teacherB]);
    const msg = await fromLead();
    const cands = await q<{ follow_up_id: string }>(f.db, f.teacherB, `select * from public.dv_followup_candidates($1)`, [`${phone.slice(1)}@s.whatsapp.net`]);
    expect(cands.map((c) => c.follow_up_id)).toEqual([followUp]);

    await q(f.db, f.teacherB, `select public.dv_confirm_followup($1, $2)`, [msg, followUp]);
    const [fu] = await sq<{ status: string; completed_by: string }>(f.db, `select status, completed_by from public.follow_ups where id = $1`, [followUp]);
    expect(fu).toEqual({ status: 'done', completed_by: f.teacherB });
    const [act] = await sq<{ data: { via: string } }>(f.db, `select data from public.lead_activities where lead_id = $1 and type = 'follow_up_completed'`, [leadId]);
    expect(act!.data.via).toBe('whatsapp');
    await expect(q(f.db, f.teacherB, `select public.dv_confirm_followup($1, $2)`, [msg, followUp])).rejects.toThrow(/already closed/);
  });

  it('a message from someone else cannot close the lead\'s follow-up', async () => {
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{update_followups}')`, [f.teacherB]);
    const [other] = await svc<{ id: string }>(
      f.db,
      `select public.dv_ingest_message('919999999999@s.whatsapp.net', 'X1', 'in', null, '+919999999999', 'Other', 'hi', null, now()) as id`,
    );
    await expect(q(f.db, f.teacherB, `select public.dv_confirm_followup($1, $2)`, [other!.id, followUp])).rejects.toThrow(/does not belong/);
  });
});
