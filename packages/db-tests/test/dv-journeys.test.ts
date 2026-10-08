import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, q, sq, svc, type Fixture } from '../src/db';

// Follow-up journeys: steps over days, replies to AI + volunteer, swipe-replies back.
let f: Fixture;
let lead: string;
const LEAD_PHONE = '+919811077001';
const VOL_PHONE = '+919800000777';
const jid = (phone: string) => `${phone.replace('+', '')}@s.whatsapp.net`;

beforeEach(async () => {
  f = await createFixture();
  await sq(f.db, `update public.wa_account set enabled = true, status = 'connected' where id`);
  await sq(f.db, `update public.org_settings set default_timezone = 'UTC' where id`);
  await sq(f.db, `update public.profiles set phone = $1, full_name = 'Srikesh Rao' where id = $2`, [VOL_PHONE, f.volA1]);
  lead = await createLead(f.db, f.teamA, { full_name: 'Priya Verma', phone: LEAD_PHONE });
  await q(f.db, f.admin, `select public.assign_leads(array[$1]::uuid[], $2)`, [lead, f.volA1]);
});

const save = (who: string, steps: unknown[], o: Record<string, unknown> = {}, id: string | null = null) =>
  q<{ id: string }>(f.db, who, `select public.dv_journey_save($1, $2, $3) as id`, [id, JSON.stringify({ name: 'After the Happiness Program', ...o }), JSON.stringify(steps)]).then((r) => r[0]!.id);
const start = (journey: string, leads = [lead], who = f.admin) =>
  q<{ r: Record<string, number> }>(f.db, who, `select public.dv_journey_start($1, $2) as r`, [journey, leads]).then((r) => r[0]!.r);
const tick = () => svc<{ n: number }>(f.db, `select public.dv_journey_tick() as n`).then((r) => r[0]!.n);
const dueNow = () => sq(f.db, `update public.dv_journey_enrollments set next_at = now() - interval '1 minute' where status = 'active'`);
const enrollment = () =>
  sq<{ status: string; next_position: number; status_reason: string | null; next_at: string | null }>(f.db, `select status, next_position, status_reason, next_at from public.dv_journey_enrollments`).then((r) => r[0]!);
const sentTo = (phone: string, kind?: string) =>
  sq<{ body: string; media_path: string | null; kind: string }>(
    f.db,
    `select body, media_path, kind from public.wa_outbox where chat_jid = $1 ${kind ? `and kind = '${kind}'` : ''} order by created_at, send_after`,
    [jid(phone)],
  );

let n = 0;
async function incoming(phone: string, text: string) {
  n += 1;
  const [m] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', $1, $3, 'x', $4, null, now()) as id`, [jid(phone), `J${n}`, phone, text]);
  return m!.id;
}

describe('journeys', () => {
  it('need the Announcements permission and at least one step', async () => {
    await expect(save(f.volA1, [{ kind: 'message', body: 'hi' }])).rejects.toThrow(/Not authorised/);
    await expect(save(f.admin, [])).rejects.toThrow(/at least one step/);
    await expect(save(f.admin, [{ kind: 'message', body: '' }])).rejects.toThrow(/Step 1: write the message/);
  });

  it('runs the steps in order: messages with the name, a call task, then completes', async () => {
    const j = await save(f.admin, [
      { kind: 'message', delay_days: 0, send_time: '00:00', body: 'Namaste {{name}} 🙏 {{volunteer}} here, how was the program?' },
      { kind: 'call_task', delay_days: 2, send_time: '10:00', body: 'Ask how the practice is going' },
      { kind: 'message', delay_days: 5, send_time: '10:00', body: 'Bye {{full_name}}' },
    ]);
    expect(await start(j)).toEqual({ started: 1, already: 0, skipped: 0 });
    expect(await start(j)).toEqual({ started: 0, already: 1, skipped: 0 });

    expect(await tick()).toBe(1);
    expect(await sentTo(LEAD_PHONE, 'journey')).toEqual([{ body: 'Namaste Priya 🙏 Srikesh here, how was the program?', media_path: null, kind: 'journey' }]);
    const e = await enrollment();
    expect(e.next_position).toBe(2);
    expect(new Date(e.next_at!).getUTCHours()).toBe(10); // two days later at 10:00
    expect(await tick()).toBe(0); // not due yet

    await dueNow();
    await tick();
    expect(await sq(f.db, `select owner_id, note from public.follow_ups where lead_id = $1`, [lead])).toEqual([
      { owner_id: f.volA1, note: 'Journey "After the Happiness Program": Ask how the practice is going' },
    ]);
    await dueNow();
    await tick();
    expect((await sentTo(LEAD_PHONE, 'journey')).map((r) => r.body)).toEqual([expect.any(String), 'Bye Priya Verma']);
    expect((await enrollment()).status).toBe('completed');
    expect(await sq(f.db, `select type from public.lead_activities where lead_id = $1 and type like 'journey%' order by created_at, id`, [lead])).toHaveLength(5);
  });

  it('invites to the next program, or skips the step when there is none', async () => {
    const [c] = await sq<{ id: string }>(f.db, `insert into public.courses (name, registration_url) values ('Sahaj Samadhi', 'https://x.org/r') returning id`);
    const j = await save(f.admin, [{ kind: 'program_invite', course_id: c!.id, send_time: '00:00' }, { kind: 'program_invite', course_id: c!.id, delay_days: 1 }]);
    await start(j);
    await tick();
    expect(await sentTo(LEAD_PHONE)).toEqual([]);
    expect(await sq(f.db, `select data->>'note' as note from public.lead_activities where type = 'journey_step'`)).toEqual([{ note: 'skipped: no upcoming program' }]);

    await sq(f.db, `insert into public.course_sessions (course_id, starts_at, ends_at, venue, city) values ($1, now() + interval '3 days', now() + interval '4 days', 'Gurukul', 'Bengaluru')`, [c!.id]);
    await dueNow();
    await tick();
    const [msg] = await sentTo(LEAD_PHONE);
    expect(msg!.body).toMatch(/^Namaste Priya 🙏\n\nThe next \*Sahaj Samadhi\* is on .+ at Gurukul, Bengaluru\.\nRegister: https:\/\/x\.org\/r/);
  });

  it('stops on chosen statuses, Do not contact and STOP', async () => {
    const j = await save(f.admin, [{ kind: 'message', body: 'hi', send_time: '00:00' }], { stop_statuses: ['registered'] });
    await start(j);
    await sq(f.db, `update public.leads set status = 'registered' where id = $1`, [lead]);
    await tick();
    expect(await enrollment()).toMatchObject({ status: 'stopped', status_reason: 'Status: Registered' });

    const other = await createLead(f.db, f.teamA, { full_name: 'Ravi', phone: '+919811077002' });
    await sq(f.db, `insert into public.dv_opt_outs (phone) values ('+919811077002')`);
    await start(j, [other]);
    await tick();
    expect((await sq<{ status_reason: string }>(f.db, `select status_reason from public.dv_journey_enrollments where lead_id = $1`, [other]))[0]!.status_reason).toMatch(/STOP/);
    expect(await sentTo('+919811077002')).toEqual([]);
  });

  it('a volunteer may start only their own leads; pause and resume', async () => {
    const j = await save(f.admin, [{ kind: 'message', body: 'hi', delay_days: 1 }]);
    await expect(start(j, [lead], f.volA1)).rejects.toThrow(/Not authorised/); // no Announcements permission
    await start(j);
    const [{ id }] = await sq<{ id: string }>(f.db, `select id from public.dv_journey_enrollments`);
    await q(f.db, f.admin, `select public.dv_journey_control($1, 'pause')`, [id]);
    expect((await enrollment()).status).toBe('paused');
    await q(f.db, f.admin, `select public.dv_journey_control($1, 'resume')`, [id]);
    expect((await enrollment()).status).toBe('active');
  });
});

describe('replies on a journey', () => {
  let j: string;
  beforeEach(async () => {
    j = await save(f.admin, [{ kind: 'message', body: 'hi', send_time: '00:00' }, { kind: 'message', body: 'again', delay_days: 3 }], { pause_on_reply: true });
    await start(j);
    await tick();
  });

  it('Setu answers by itself, the volunteer gets it, and the journey waits', async () => {
    const m = await incoming(LEAD_PHONE, 'I have back pain during the practice, what to do?');
    expect((await svc<{ r: Record<string, unknown> }>(f.db, `select public.dv_journey_participant($1) as r`, [m]))[0]!.r).toMatchObject({
      journey: true, ai_auto: true, volunteer: 'Srikesh',
    });
    const [{ r }] = await svc<{ r: Record<string, unknown> }>(f.db, `select public.dv_journey_on_reply($1, $2, null, 'course_info', 'ai', 'ai_draft') as r`, [
      m, 'Please go gently, Srikesh will call you.',
    ]);
    expect(r).toEqual({ handled: true, replied: true, forwarded: true });
    expect((await sentTo(LEAD_PHONE, 'reply'))[0]!.body).toBe('Please go gently, Srikesh will call you.');
    const [fwd] = await sentTo(VOL_PHONE);
    expect(fwd!.body).toContain('💬 *Priya Verma* (L-');
    expect(fwd!.body).toContain('🤖 Setu replied:\nPlease go gently');
    expect(fwd!.body).toContain('swipe right on this message');
    expect(await enrollment()).toMatchObject({ status: 'paused', status_reason: 'They replied: waiting for the volunteer' });
  });

  it("the volunteer's swipe-reply goes to the person, signed, and the journey carries on", async () => {
    const m = await incoming(LEAD_PHONE, 'thank you!');
    await svc(f.db, `select public.dv_journey_on_reply($1)`, [m]);
    // The gateway sent the forward and stored it with WhatsApp's id.
    const [{ id: fwdOut }] = await sq<{ id: string }>(f.db, `select id from public.wa_outbox where chat_jid = $1`, [jid(VOL_PHONE)]);
    await svc(f.db, `select public.dv_ingest_message($1, 'WA-FWD-1', 'out', null, null, null, 'fwd', null, now(), $2)`, [jid(VOL_PHONE), fwdOut]);

    const v = await incoming(VOL_PHONE, 'So happy to hear, see you Sunday!');
    const [{ r }] = await svc<{ r: { handled: boolean; reply: string } }>(f.db, `select public.dv_journey_volunteer_reply($1, 'WA-FWD-1') as r`, [v]);
    expect(r.reply).toMatch(/^✅ Sent to Priya Verma \(L-\d+\) from the Setu number\.$/);
    expect((await sentTo(LEAD_PHONE, 'direct')).map((x) => x.body)).toEqual(['So happy to hear, see you Sunday!\n\n– Srikesh']);
    expect((await enrollment()).status).toBe('active');

    // A reply to some other message is not for this.
    const v2 = await incoming(VOL_PHONE, 'ok');
    expect((await svc<{ r: { handled: boolean } }>(f.db, `select public.dv_journey_volunteer_reply($1, 'OTHER') as r`, [v2]))[0]!.r).toEqual({ handled: false });
  });

  it('"Reply L-…" works only for their own leads', async () => {
    const [{ code }] = await sq<{ code: string }>(f.db, `select lead_code as code from public.leads where id = $1`, [lead]);
    await sq(f.db, `update public.profiles set phone = '+919800000778' where id = $1`, [f.volA2]);
    const v = await incoming('+919800000778', `Reply ${code} hello`);
    const [{ r }] = await svc<{ r: { reply: string } }>(f.db, `select public.dv_journey_volunteer_reply($1, null, $2, 'hello') as r`, [v, code]);
    expect(r.reply).toMatch(/is not one of your leads/);
    expect(await sentTo(LEAD_PHONE, 'direct')).toEqual([]);
  });

  it('the gateway alone may call the WhatsApp parts', async () => {
    await expect(q(f.db, f.admin, `select public.dv_journey_tick()`)).rejects.toThrow(/permission denied/);
    await expect(q(f.db, f.admin, `select public.dv_journey_on_reply(gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });
});
