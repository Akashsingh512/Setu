import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, q, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
let groupId: string;
const GROUP = '120363000000000001@g.us';
const DM = '919845000001@s.whatsapp.net';

beforeEach(async () => {
  f = await createFixture();
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'Satsang' }])]);
  groupId = (await sq<{ id: string }>(f.db, `select id from public.wa_groups`))[0]!.id;
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  await sq(f.db, `update public.wa_groups set enabled = true, allow_read = true, allow_course_info = true where id = $1`, [groupId]);
});

let n = 0;
async function incoming(chat = GROUP, body = 'When is the next Happiness Program?') {
  n += 1;
  const [r] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', null, null, 'Asha', $3, null, now()) as id`, [chat, `MSG${n}`, body]);
  return r!.id;
}
const record = (id: string, intent = 'course_info', reply: string | null = 'Course: Happiness Program', kind: string | null = 'course_details') =>
  svc<{ r: { status: string; send?: string; skipped?: boolean } }>(f.db, `select public.dv_record_intent($1, $2, 'keywords', $3, $4) as r`, [id, intent, reply, kind]).then((x) => x[0]!.r);
const outbox = () => sq<{ status: string; body: string; auto: boolean }>(f.db, `select status, body, auto from public.wa_outbox`);
const setGroup = (sql: string) => sq(f.db, `update public.wa_groups set ${sql} where id = $1`, [groupId]);

describe('course answers: what may be sent', () => {
  it('assisted (default): the answer waits for a person', async () => {
    expect(await record(await incoming())).toMatchObject({ status: 'needs_review', send: 'pending_approval' });
    expect(await outbox()).toEqual([{ status: 'pending_approval', body: 'Course: Happiness Program', auto: true }]);
  });

  it('automatic: queued to send; pausing turns it back into a suggestion', async () => {
    await setGroup(`mode = 'automatic'`);
    expect(await record(await incoming())).toMatchObject({ status: 'processed', send: 'queued' });
    await sq(f.db, `update public.wa_account set auto_paused = true where id`);
    expect(await record(await incoming())).toMatchObject({ send: 'pending_approval' });
  });

  it('automatic never sends a hand-over reply by itself', async () => {
    await setGroup(`mode = 'automatic'`);
    expect(await record(await incoming(), 'course_info', 'A volunteer will get back to you', 'fallback')).toMatchObject({ send: 'pending_approval' });
  });

  it('manual: flagged for a person, no draft', async () => {
    await setGroup(`mode = 'manual'`);
    expect(await record(await incoming())).toEqual({ status: 'needs_review' });
    expect(await outbox()).toEqual([]);
  });

  it('course answers switched off for the group: nothing at all', async () => {
    await setGroup(`allow_course_info = false, mode = 'automatic'`);
    expect(await record(await incoming())).toEqual({ status: 'ignored' });
    expect(await outbox()).toEqual([]);
  });

  it('emergency switch off: no reply is prepared', async () => {
    await setGroup(`mode = 'automatic'`);
    const id = await incoming();
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    await record(id);
    expect(await outbox()).toEqual([]);
  });

  it('direct chats follow the direct-chat settings', async () => {
    expect(await record(await incoming(DM))).toEqual({ status: 'ignored' }); // dm_course_info off by default
    await sq(f.db, `update public.wa_account set dm_course_info = true, dm_mode = 'automatic' where id`);
    expect(await record(await incoming(DM))).toMatchObject({ send: 'queued' });
  });

  it('a message is answered at most once, even if processed twice', async () => {
    await setGroup(`mode = 'automatic'`);
    const id = await incoming();
    await record(id);
    expect(await record(id)).toMatchObject({ skipped: true });
    expect(await outbox()).toHaveLength(1);
  });

  it('messages with no recognised question are just logged', async () => {
    expect(await record(await incoming(GROUP, 'Jai Gurudev'), 'none', null, null)).toEqual({ status: 'ignored' });
  });
});

describe('approving suggestions', () => {
  it('a replier approves (optionally editing); it is queued once', async () => {
    const msg = await incoming();
    await record(msg);
    const [{ id }] = await sq<{ id: string }>(f.db, `select id from public.wa_outbox`);
    await expect(q(f.db, f.volA1, `select public.dv_approve_outbox($1)`, [id])).rejects.toThrow(/Not authorised/);

    await q(f.db, f.admin, `select public.dv_approve_outbox($1, 'Edited answer')`, [id]);
    expect(await outbox()).toEqual([{ status: 'queued', body: 'Edited answer', auto: true }]);
    expect((await sq<{ status: string }>(f.db, `select status from public.wa_messages where id = $1`, [msg]))[0]!.status).toBe('processed');
    await expect(q(f.db, f.admin, `select public.dv_approve_outbox($1)`, [id])).rejects.toThrow(/already handled/);
  });

  it('dismissing cancels the suggestion', async () => {
    const msg = await incoming();
    await record(msg);
    await q(f.db, f.admin, `select public.dv_dismiss_message($1)`, [msg]);
    expect((await outbox())[0]!.status).toBe('cancelled');
  });
});

describe('response templates', () => {
  it('only content managers edit; blank resets to the default', async () => {
    await expect(q(f.db, f.teacherA, `select public.dv_save_template('fallback', 'x')`)).rejects.toThrow(/Not authorised/);
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{manage_content}')`, [f.teacherA]);
    await q(f.db, f.teacherA, `select public.dv_save_template('fallback', 'Custom')`);
    expect(await q(f.db, f.teacherA, `select kind, body from public.dv_response_templates`)).toEqual([{ kind: 'fallback', body: 'Custom' }]);
    await q(f.db, f.teacherA, `select public.dv_save_template('fallback', null)`);
    expect(await sq(f.db, `select * from public.dv_response_templates`)).toEqual([]);
    await expect(q(f.db, f.admin, `select public.dv_record_intent(gen_random_uuid(), 'none', 'keywords')`)).rejects.toThrow(/permission denied/);
  });
});
