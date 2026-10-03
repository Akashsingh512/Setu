import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, q, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
let g1: string;
let g2: string;
const J1 = '120363000000000001@g.us';
const J2 = '120363000000000002@g.us';

beforeEach(async () => {
  f = await createFixture();
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: J1, name: 'Satsang' }, { jid: J2, name: 'Sevaks' }])]);
  [g1, g2] = (await sq<{ id: string }>(f.db, `select id from public.wa_groups order by jid`)).map((r) => r.id) as [string, string];
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  await sq(f.db, `update public.wa_groups set enabled = true, allow_announcements = true`);
  await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{schedule_announcements}')`, [f.teacherA]);
  await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{schedule_announcements}')`, [f.teacherB]);
});

const create = (who: string, opts: { body?: string | null; poster?: string | null; at?: string; groups?: string[] } = {}) =>
  q<{ id: string }>(f.db, who, `select public.dv_create_announcement('Satsang notice', $1, $2, now() + $3::interval, $4) as id`, [
    opts.body === undefined ? 'Satsang this Sunday at 6 pm' : opts.body,
    opts.poster ?? null,
    opts.at ?? '1 hour',
    opts.groups ?? [g1, g2],
  ]).then((r) => r[0]!.id);
const status = (id: string) => sq<{ status: string }>(f.db, `select status from public.dv_announcements where id = $1`, [id]).then((r) => r[0]!.status);
const outbox = (id: string) =>
  sq<{ chat_jid: string; status: string; kind: string; media_path: string | null }>(
    f.db,
    `select chat_jid, status, kind, media_path from public.wa_outbox where announcement_id = $1 order by chat_jid`,
    [id],
  );
const claim = () => svc<{ id: string; chat_jid: string }>(f.db, `select id, chat_jid from public.dv_claim_outbox(10)`);
const complete = (id: string, ok = true) => svc(f.db, `select public.dv_complete_outbox($1, $2, 'P1', 'boom')`, [id, ok]);
const due = (id: string) => sq(f.db, `update public.wa_outbox set send_after = now() - interval '1 minute' where announcement_id = $1`, [id]);

describe('creating announcements', () => {
  it('needs the Announcements permission', async () => {
    await expect(create(f.volA1)).rejects.toThrow(/Not authorised/);
  });

  it('only groups that allow announcements; a poster also needs media allowed', async () => {
    await sq(f.db, `update public.wa_groups set allow_announcements = false where id = $1`, [g2]);
    await expect(create(f.teacherA)).rejects.toThrow(/do not allow announcements: Sevaks/);
    await expect(create(f.teacherA, { groups: [g1], poster: 'announcements/a.jpg' })).rejects.toThrow(/with a poster: Satsang/);
    await sq(f.db, `update public.wa_groups set allow_media = true where id = $1`, [g1]);
    expect(await create(f.teacherA, { groups: [g1], poster: 'announcements/a.jpg', body: null })).toBeTruthy();
  });

  it('rejects empty content, past times, odd poster paths and no groups', async () => {
    await expect(create(f.teacherA, { body: ' ' })).rejects.toThrow(/Write a message/);
    await expect(create(f.teacherA, { at: '-1 hour' })).rejects.toThrow(/future/);
    await expect(create(f.teacherA, { groups: [] })).rejects.toThrow(/at least one group/);
    await sq(f.db, `update public.wa_groups set allow_media = true`);
    await expect(create(f.teacherA, { poster: '../secrets.txt' })).rejects.toThrow();
  });

  it('nothing is queued until someone else approves; other approvers are told', async () => {
    const id = await create(f.teacherA);
    expect(await status(id)).toBe('pending_approval');
    expect(await outbox(id)).toEqual([]);
    expect(await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'announcement_pending'`, [f.teacherB])).toHaveLength(1);
    expect(await sq(f.db, `select 1 from public.notifications where recipient_id = $1 and type = 'announcement_pending'`, [f.teacherA])).toHaveLength(0);
    await expect(q(f.db, f.teacherA, `select public.dv_approve_announcement($1)`, [id])).rejects.toThrow(/Someone else must approve/);
  });
});

describe('approval and sending', () => {
  it('approval queues one message per group at the chosen time', async () => {
    const id = await create(f.teacherA);
    await q(f.db, f.teacherB, `select public.dv_approve_announcement($1)`, [id]);
    expect(await status(id)).toBe('scheduled');
    expect(await outbox(id)).toEqual([
      { chat_jid: J1, status: 'queued', kind: 'announcement', media_path: null },
      { chat_jid: J2, status: 'queued', kind: 'announcement', media_path: null },
    ]);
    expect(await claim()).toEqual([]); // not due yet
    await due(id);
    const rows = await claim();
    expect(rows).toHaveLength(2);
    expect(await status(id)).toBe('sending');
    await complete(rows[0]!.id);
    await complete(rows[1]!.id);
    expect(await status(id)).toBe('sent');
  });

  it('a super admin may approve their own', async () => {
    const id = await create(f.admin);
    await q(f.db, f.admin, `select public.dv_approve_announcement($1)`, [id]);
    expect(await status(id)).toBe('scheduled');
  });

  it('a group switched off before the send time is skipped', async () => {
    const id = await create(f.teacherA);
    await q(f.db, f.teacherB, `select public.dv_approve_announcement($1)`, [id]);
    await sq(f.db, `update public.wa_groups set allow_announcements = false where id = $1`, [g2]);
    await due(id);
    const rows = await claim();
    expect(rows.map((r) => r.chat_jid)).toEqual([J1]);
    await complete(rows[0]!.id);
    expect(await status(id)).toBe('partly_sent');
  });

  it('more than 6 hours late: not sent', async () => {
    const id = await create(f.teacherA);
    await q(f.db, f.teacherB, `select public.dv_approve_announcement($1)`, [id]);
    await sq(f.db, `update public.wa_outbox set send_after = now() - interval '7 hours' where announcement_id = $1`, [id]);
    expect(await claim()).toEqual([]);
    expect(await status(id)).toBe('failed');
  });

  it('nothing goes out while Digital Volunteer is switched off', async () => {
    const id = await create(f.teacherA);
    await q(f.db, f.teacherB, `select public.dv_approve_announcement($1)`, [id]);
    await due(id);
    await sq(f.db, `update public.wa_account set enabled = false where id`);
    expect(await claim()).toEqual([]);
  });

  it('reject and cancel', async () => {
    const a = await create(f.teacherA);
    await q(f.db, f.teacherB, `select public.dv_reject_announcement($1, 'Wrong date')`, [a]);
    expect(await status(a)).toBe('rejected');
    await expect(q(f.db, f.teacherB, `select public.dv_approve_announcement($1)`, [a])).rejects.toThrow(/already handled/);

    const b = await create(f.teacherA);
    await q(f.db, f.teacherB, `select public.dv_approve_announcement($1)`, [b]);
    expect((await q<{ n: number }>(f.db, f.teacherA, `select public.dv_cancel_announcement($1) as n`, [b]))[0]!.n).toBe(2);
    expect(await status(b)).toBe('cancelled');
    expect((await outbox(b)).map((o) => o.status)).toEqual(['cancelled', 'cancelled']);
    await due(b);
    expect(await claim()).toEqual([]);
  });

  it('volunteers without the permission cannot see announcements', async () => {
    await create(f.teacherA);
    expect(await q(f.db, f.volA1, `select * from public.dv_announcements`)).toEqual([]);
    expect(await q(f.db, f.teacherB, `select * from public.dv_announcements`)).toHaveLength(1);
  });
});
