import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, svc, type Fixture } from '../src/db';

// Bulk messages: pacing, sending hours, caps, safety lists, STOP.
let f: Fixture;

beforeEach(async () => {
  f = await createFixture();
  await sq(f.db, `update public.wa_account set enabled = true, status = 'connected' where id`);
  await sq(f.db, `update public.org_settings set default_timezone = 'UTC' where id`);
});

const people = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ phone: `+9198110${String(10000 + start + i)}`, name: `Person ${start + i} Kumar` }));
const settings = (o: Record<string, unknown> = {}) => ({ title: 'Diwali satsang', body: 'Namaste {{name}}, see you!', min_gap_s: 30, max_gap_s: 60, daily_cap: 100, ...o });
const create = (who: string, recipients: unknown[], o: Record<string, unknown> = {}, dry = false) =>
  q<{ r: Record<string, number | string> }>(f.db, who, `select public.dv_bulk_create($1, $2, $3) as r`, [JSON.stringify(settings(o)), JSON.stringify(recipients), dry]).then((x) => x[0]!.r);
const tick = () => svc<{ n: number }>(f.db, `select public.dv_bulk_tick() as n`).then((x) => x[0]!.n);
const queued = () => sq<{ body: string; send_after: string; typing_ms: number }>(f.db, `select body, send_after, typing_ms from public.wa_outbox where kind = 'bulk' order by send_after`);

describe('bulk messages', () => {
  it('needs the Announcements permission; cleans the list (invalid, duplicate, opted-out, Do not contact)', async () => {
    await expect(create(f.volA1, people(2))).rejects.toThrow(/Not authorised/);
    const dnc = await createLead(f.db, f.teamA, { phone: '+919811099999' });
    await sq(f.db, `update public.leads set status = (select code from public.lead_statuses where blocks_contact limit 1) where id = $1`, [dnc]);
    await sq(f.db, `insert into public.dv_opt_outs (phone) values ('+919811010001')`);
    const list = [...people(3), { phone: '+919811010000', name: 'Dup' }, { phone: '12345', name: 'Bad' }, { phone: '+919811099999', name: 'DNC' }];
    expect(await create(f.admin, list, {}, true)).toEqual({ recipients: 2, invalid: 1, duplicates: 1, opted_out: 1, do_not_contact: 1 });
    expect(await sq(f.db, `select 1 from public.dv_bulk_campaigns`)).toHaveLength(0); // dry run saves nothing
    const r = await create(f.admin, list);
    expect(r.recipients).toBe(2);
  });

  it('queues only the next two minutes, with random gaps, typing time and the name filled in', async () => {
    await create(f.admin, people(10), { min_gap_s: 30, max_gap_s: 60, typing_min_s: 2, typing_max_s: 5 });
    const n = await tick();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(5); // 2 minutes at 30-60 s apart
    const rows = await queued();
    expect(rows[0]!.body).toBe('Namaste Person, see you!'); // reads like a person wrote it: no STOP line
    for (let i = 1; i < rows.length; i++) {
      const gap = (Date.parse(rows[i]!.send_after) - Date.parse(rows[i - 1]!.send_after)) / 1000;
      expect(gap).toBeGreaterThanOrEqual(30);
      expect(gap).toBeLessThanOrEqual(60);
    }
    expect(rows.every((x) => x.typing_ms >= 2000 && x.typing_ms <= 5000)).toBe(true);
  });

  it('respects the daily cap, sending hours and batch pauses', async () => {
    await create(f.admin, people(10), { min_gap_s: 5, max_gap_s: 5, daily_cap: 3 });
    await tick();
    expect(await queued()).toHaveLength(3);
    const [c] = await sq<{ next_send_at: string }>(f.db, `select next_send_at from public.dv_bulk_campaigns`);
    await tick();
    expect(await queued()).toHaveLength(3); // nothing more today
    expect(new Date(c!.next_send_at).getTime()).toBeGreaterThan(Date.now());

    await sq(f.db, `delete from public.dv_bulk_recipients`);
    await sq(f.db, `delete from public.wa_outbox where kind = 'bulk'`);
    await sq(f.db, `delete from public.dv_bulk_campaigns`);
    // Sending hours that are over for today: nothing until tomorrow.
    const past = new Date(Date.now() - 3 * 3600_000).toISOString().slice(11, 16);
    const pastEnd = new Date(Date.now() - 2 * 3600_000).toISOString().slice(11, 16);
    if (past < pastEnd) {
      await create(f.admin, people(3), { window_start: past, window_end: pastEnd });
      expect(await tick()).toBe(0);
    }
  });

  it('sends only on the chosen days', async () => {
    const today = ((new Date().getUTCDay() + 6) % 7) + 1; // 1 = Monday, in UTC like the test org
    const notToday = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today);
    await create(f.admin, people(3), { send_days: notToday });
    expect(await tick()).toBe(0);
    const [c] = await sq<{ next_send_at: string; send_days: number[] }>(f.db, `select next_send_at, send_days from public.dv_bulk_campaigns`);
    expect(c!.send_days).toEqual(notToday);
    expect(new Date(c!.next_send_at).getUTCDate()).not.toBe(new Date().getUTCDate());
  });

  it('nothing is queued while WhatsApp is not connected; pause, resume and cancel', async () => {
    const r = await create(f.admin, people(6), { min_gap_s: 5, max_gap_s: 5 });
    await sq(f.db, `update public.wa_account set status = 'disconnected' where id`);
    expect(await tick()).toBe(0);
    await sq(f.db, `update public.wa_account set status = 'connected' where id`);
    expect(await tick()).toBeGreaterThan(0);

    await q(f.db, f.admin, `select public.dv_bulk_control($1, 'pause')`, [r.id]);
    expect(await sq(f.db, `select 1 from public.wa_outbox where kind = 'bulk' and status = 'queued'`)).toHaveLength(0);
    expect(await tick()).toBe(0);
    await q(f.db, f.admin, `select public.dv_bulk_control($1, 'resume')`, [r.id]);
    expect(await tick()).toBeGreaterThan(0);
    await q(f.db, f.admin, `select public.dv_bulk_control($1, 'cancel')`, [r.id]);
    expect((await sq<{ status: string }>(f.db, `select status from public.dv_bulk_campaigns`))[0]!.status).toBe('cancelled');
    expect(await sq(f.db, `select 1 from public.dv_bulk_recipients where status in ('pending', 'queued')`)).toHaveLength(0);
  });

  it('five failures in a row pause it; results flow back from the outbox', async () => {
    await create(f.admin, people(8), { min_gap_s: 5, max_gap_s: 5 });
    await tick();
    await sq(f.db, `update public.wa_outbox set status = 'failed', last_error = 'Not on WhatsApp' where kind = 'bulk'`);
    await tick(); // records the failures (and queues more)
    await sq(f.db, `update public.wa_outbox set status = 'failed', last_error = 'Not on WhatsApp' where kind = 'bulk' and status = 'queued'`);
    await tick();
    const [c] = await sq<{ status: string; status_reason: string }>(f.db, `select status, status_reason from public.dv_bulk_campaigns`);
    expect(c).toMatchObject({ status: 'paused', status_reason: expect.stringMatching(/last 5 messages failed/) });
  });

  it('STOP: opted out for good, and never sent again', async () => {
    const [m] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message('919811010002@s.whatsapp.net', 'S1', 'in', '919811010002@s.whatsapp.net', '+919811010002', 'P', 'STOP', null, now()) as id`);
    expect((await svc<{ r: { handled: boolean } }>(f.db, `select public.dv_opt_out_by_message($1) as r`, [m!.id]))[0]!.r.handled).toBe(true);
    expect(await sq(f.db, `select 1 from public.dv_opt_outs where phone = '+919811010002'`)).toHaveLength(1);
    expect(await create(f.admin, people(3), {}, true)).toMatchObject({ recipients: 2, opted_out: 1 });
  });
});
