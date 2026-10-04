import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, nextPhone, q, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
let groupId: string;
let sessionId: string;
let leadId: string;
let phone: string;
const GROUP = '120363000000000001@g.us';
const DM = '919845000001@s.whatsapp.net';

beforeEach(async () => {
  f = await createFixture();
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'Satsang' }])]);
  groupId = (await sq<{ id: string }>(f.db, `select id from public.wa_groups`))[0]!.id;
  await sq(f.db, `update public.wa_account set enabled = true, dm_course_info = true where id`);
  await sq(f.db, `update public.wa_groups set enabled = true, allow_read = true, allow_course_info = true where id = $1`, [groupId]);
  const [c] = await sq<{ id: string }>(f.db, `insert into public.courses (name) values ('Happiness Program') returning id`);
  const [s] = await sq<{ id: string }>(
    f.db,
    `insert into public.course_sessions (course_id, starts_at, ends_at, venue) values ($1, now() + interval '2 days', now() + interval '5 days', 'Gurukul') returning id`,
    [c!.id],
  );
  sessionId = s!.id;
  phone = nextPhone();
  leadId = await createLead(f.db, f.teamA, { phone });
  await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [leadId, f.volA1]);
});

let n = 0;
async function incoming(chat: string) {
  n += 1;
  const [r] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', null, null, 'Asha', 'Happiness program?', null, now()) as id`, [
    chat,
    `P${n}`,
  ]);
  return r!.id;
}
const record = (id: string, media: string | null) =>
  svc(f.db, `select public.dv_record_intent($1, 'course_info', 'keywords', 'Course: Happiness', 'course_details', null, null, $2)`, [id, media]);
const media = () => sq<{ chat_jid: string; media_path: string | null }>(f.db, `select chat_jid, media_path from public.wa_outbox order by created_at`);

describe('posters with course replies', () => {
  it('a private chat gets the poster; a group only when it allows media', async () => {
    await record(await incoming(DM), 'programs/a.jpg');
    await record(await incoming(GROUP), 'programs/a.jpg');
    await sq(f.db, `update public.wa_groups set allow_media = true where id = $1`, [groupId]);
    await record(await incoming(GROUP), 'programs/a.jpg');
    expect((await media()).map((r) => r.media_path)).toEqual(['programs/a.jpg', null, 'programs/a.jpg']);
  });

  it('ignores a path outside the poster folders', async () => {
    await record(await incoming(DM), 'announcements/../secret.jpg');
    expect((await media())[0]!.media_path).toBeNull();
  });

  it('a course response poster can be set and removed without touching its text', async () => {
    await q(f.db, f.admin, `select public.dv_set_template_poster('course_details', 'templates/t.png')`);
    expect(await sq(f.db, `select body, poster_path from public.dv_response_templates`)).toEqual([{ body: null, poster_path: 'templates/t.png' }]);
    await q(f.db, f.admin, `select public.dv_save_template('course_details', 'Hello {{course_name}}')`);
    await q(f.db, f.admin, `select public.dv_save_template('course_details', null)`);
    expect(await sq(f.db, `select body, poster_path from public.dv_response_templates`)).toEqual([{ body: null, poster_path: 'templates/t.png' }]);
    await q(f.db, f.admin, `select public.dv_set_template_poster('course_details', null)`);
    expect(await sq(f.db, `select * from public.dv_response_templates`)).toEqual([]);
    await expect(q(f.db, f.admin, `select public.dv_set_template_poster('fallback', 'templates/t.png')`)).rejects.toThrow(/cannot have a poster/);
    await expect(q(f.db, f.volA1, `select public.dv_set_template_poster('course_details', 'templates/t.png')`)).rejects.toThrow(/Not authorised/);
  });
});

describe('send to a lead from the Setu number', () => {
  const send = (user: string, session: string | null = sessionId) =>
    q<{ r: { poster: boolean } }>(f.db, user, `select public.dv_send_lead_message($1, 'Namaste', $2) as r`, [leadId, session]).then((x) => x[0]!.r);

  it("the lead's volunteer sends it with the program's poster, else the response poster", async () => {
    await sq(f.db, `update public.course_sessions set poster_path = 'programs/p.jpg' where id = $1`, [sessionId]);
    expect(await send(f.volA1)).toEqual({ outbox_id: expect.any(String), poster: true });
    expect(await media()).toEqual([{ chat_jid: `${phone.slice(1)}@s.whatsapp.net`, media_path: 'programs/p.jpg' }]);
    expect(await sq(f.db, `select type, data ->> 'preview' as preview from public.lead_activities where lead_id = $1 and type = 'whatsapp_sent'`, [leadId])).toEqual([
      { type: 'whatsapp_sent', preview: 'Namaste' },
    ]);
  });

  it('falls back to the One program poster, and sends text only without a program', async () => {
    await q(f.db, f.admin, `select public.dv_set_template_poster('course_details', 'templates/t.png')`);
    expect(await send(f.volA1)).toMatchObject({ poster: true });
    await sq(f.db, `update public.wa_outbox set created_at = now() - interval '2 minutes'`);
    expect(await send(f.volA1, null)).toMatchObject({ poster: false });
    expect((await media()).map((r) => r.media_path)).toEqual(['templates/t.png', null]);
  });

  it('refuses other volunteers, a second send within a minute, and a switched-off number', async () => {
    await expect(send(f.volA2)).rejects.toThrow(/no longer have access/);
    await send(f.volA1);
    await expect(send(f.volA1)).rejects.toThrow(/just sent/);
    await sq(f.db, `update public.wa_outbox set created_at = now() - interval '2 minutes'`);
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    await expect(send(f.volA1)).rejects.toThrow(/switched off/);
  });
});
