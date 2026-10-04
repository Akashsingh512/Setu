import { beforeEach, describe, expect, it } from 'vitest';
import { asUser, createFixture, q, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
let groupId: string;
const GROUP = '120363000000000001@g.us';
const APPROVER_PHONE = '+919800000001';

beforeEach(async () => {
  f = await createFixture();
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'Satsang' }])]);
  groupId = (await sq<{ id: string }>(f.db, `select id from public.wa_groups`))[0]!.id;
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  await sq(f.db, `update public.wa_groups set enabled = true, allow_read = true, allow_course_info = true where id = $1`, [groupId]);
});

let n = 0;
async function incoming(body = 'what time is satsang', chat = GROUP, phone: string | null = null) {
  n += 1;
  const [r] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', null, $3, 'Asha', $4, null, now()) as id`, [
    chat,
    `M${n}`,
    phone,
    body,
  ]);
  return r!.id;
}
const record = (id: string, intent: string, reply: string | null, kind: string | null, ruleId: string | null = null) =>
  svc<{ r: Record<string, string> }>(f.db, `select public.dv_record_intent($1, $2, 'rule', $3, $4, null, $5) as r`, [id, intent, reply, kind, ruleId]).then(
    (x) => x[0]!.r,
  );

describe('reply rules', () => {
  it('people with Course responses manage rules; keywords are cleaned', async () => {
    await expect(
      q(f.db, f.volA1, `insert into public.dv_rules (name, keywords, action, reply_body) values ('x', '{a}', 'reply', 'hi')`),
    ).rejects.toThrow();
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{manage_content}')`, [f.teacherA]);
    const [rule] = await q<{ keywords: string[] }>(
      f.db,
      f.teacherA,
      `insert into public.dv_rules (name, keywords, action, reply_body) values ('Satsang', $1, 'reply', 'Every Thursday 7 pm') returning keywords`,
      [['  Satsang Timing ', 'satsang timing', 'kab hai satsang']],
    );
    expect(rule!.keywords).toEqual(['kab hai satsang', 'satsang timing']);
    await expect(
      q(f.db, f.teacherA, `insert into public.dv_rules (name, keywords, action) values ('Bad', '{x}', 'course')`),
    ).rejects.toThrow(); // a course rule needs a course
  });

  it('a rule reply is sent automatically in Automatic mode and remembers the rule', async () => {
    const [{ id: ruleId }] = (await sq<{ id: string }>(
      f.db,
      `insert into public.dv_rules (name, keywords, action, reply_body) values ('Satsang', '{satsang}', 'reply', 'Thursday 7 pm') returning id`,
    )) as [{ id: string }];
    await sq(f.db, `update public.wa_groups set mode = 'automatic' where id = $1`, [groupId]);
    const msg = await incoming();
    expect(await record(msg, 'course_info', 'Thursday 7 pm', 'rule', ruleId)).toMatchObject({ send: 'queued' });
    expect((await sq<{ rule_id: string }>(f.db, `select rule_id from public.wa_messages where id = $1`, [msg]))[0]!.rule_id).toBe(ruleId);
  });

  it('a hand-over rule flags the message for a person, with no reply', async () => {
    const msg = await incoming('I want to complain');
    expect(await record(msg, 'handover', null, null)).toEqual({ status: 'needs_review' });
    expect(await sq(f.db, `select 1 from public.wa_outbox`)).toHaveLength(0);
  });
});

describe('AI drafts', () => {
  it('are never sent automatically, even in Automatic mode', async () => {
    await sq(f.db, `update public.wa_groups set mode = 'automatic' where id = $1`, [groupId]);
    const msg = await incoming('is there parking at the ashram?');
    expect(await record(msg, 'course_info', 'Yes, there is parking.', 'ai_draft')).toMatchObject({ send: 'pending_approval' });
    const [o] = await sq<{ ai_draft: boolean; approval_ref: number }>(f.db, `select ai_draft, approval_ref from public.wa_outbox`);
    expect(o!.ai_draft).toBe(true);
    expect(o!.approval_ref).toBeGreaterThan(0);
  });
});

describe('AI settings', () => {
  it('only super admins see or change them, and keys are never readable', async () => {
    await expect(q(f.db, f.teacherA, `select public.dv_ai_settings_get()`)).rejects.toThrow(/super admin/);
    await expect(q(f.db, f.teacherA, `select * from public.dv_ai_settings`)).rejects.toThrow(); // no grant at all
    await q(f.db, f.admin, `select public.dv_ai_settings_save('anthropic', null, null, null, true, true, 'ai', 'sk-ant-secret-1234', null, null)`);
    const [{ s }] = (await q<{ s: Record<string, unknown> }>(f.db, f.admin, `select public.dv_ai_settings_get() as s`)) as [
      { s: Record<string, unknown> },
    ];
    expect(s).toMatchObject({ provider: 'anthropic', anthropic_model: 'claude-opus-5-5', anthropic_key_hint: '1234', draft_enabled: true });
    expect(JSON.stringify(s)).not.toContain('sk-ant'); // only the last 4 characters, never the key
    // Audit never holds the key.
    expect(JSON.stringify(await sq(f.db, `select data from public.audit_logs where action = 'dv.ai_settings_changed'`))).not.toContain('sk-ant');
    // null keeps the key; '' removes it.
    await q(f.db, f.admin, `select public.dv_ai_settings_save('anthropic', 'claude-haiku-4-5', null, null, true, true, 'ai')`);
    expect((await sq<{ k: string }>(f.db, `select anthropic_api_key as k from public.dv_ai_settings`))[0]!.k).toBe('sk-ant-secret-1234');
    await expect(
      q(f.db, f.admin, `select public.dv_ai_settings_save('anthropic', null, null, null, true, true, 'ai', '', null, null)`),
    ).rejects.toThrow(/Add the Anthropic API key/);
  });

  it('only super admins can ask the gateway to test AI', async () => {
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{manage_integration}')`, [f.teacherA]);
    await expect(q(f.db, f.teacherA, `select public.dv_request_command('test_ai')`)).rejects.toThrow(/Not authorised/);
    await q(f.db, f.admin, `select public.dv_request_command('test_ai')`);
  });
});

describe('approving suggested replies on WhatsApp', () => {
  async function setup() {
    await sq(f.db, `update public.profiles set phone = $2 where id = $1`, [f.teacherA, APPROVER_PHONE]);
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{reply_messages}')`, [f.teacherA]);
    await q(f.db, f.admin, `select public.dv_set_reply_approver($1, true)`, [f.teacherA]);
    const msg = await incoming('is there parking?');
    await record(msg, 'course_info', 'Yes, there is parking.', 'ai_draft');
    const [o] = await sq<{ id: string; approval_ref: number }>(f.db, `select id, approval_ref from public.wa_outbox where kind = 'reply'`);
    return o!;
  }
  const decide = async (from: string, action: string, ref: number, text: string | null = null) => {
    const msg = await incoming(`${action} ${ref}`, `${from.slice(1)}@s.whatsapp.net`, from);
    return (await svc<{ r: { handled: boolean } }>(f.db, `select public.dv_reply_whatsapp_decision($1, $2, $3, $4) as r`, [msg, action, ref, text]))[0]!.r;
  };

  it('the approver is asked on WhatsApp and SEND queues the reply', async () => {
    const o = await setup();
    const asks = await sq<{ chat_jid: string; body: string }>(f.db, `select chat_jid, body from public.wa_outbox where idempotency_key like 'reply-ask:%'`);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.chat_jid).toBe('919800000001@s.whatsapp.net');
    expect(asks[0]!.body).toContain(`SEND ${o.approval_ref}`);
    expect(await decide(APPROVER_PHONE, 'send', o.approval_ref)).toMatchObject({ handled: true });
    expect((await sq<{ status: string; approved_by: string }>(f.db, `select status, approved_by from public.wa_outbox where id = $1`, [o.id]))[0]).toEqual({
      status: 'queued',
      approved_by: f.teacherA,
    });
  });

  it('EDIT sends the approver\'s text; SKIP sends nothing; done once only', async () => {
    const o = await setup();
    await decide(APPROVER_PHONE, 'edit', o.approval_ref, 'Yes, parking is free.');
    expect((await sq<{ body: string }>(f.db, `select body from public.wa_outbox where id = $1`, [o.id]))[0]!.body).toBe('Yes, parking is free.');
    await decide(APPROVER_PHONE, 'skip', o.approval_ref);
    expect((await sq<{ status: string }>(f.db, `select status from public.wa_outbox where id = $1`, [o.id]))[0]!.status).toBe('queued');
  });

  it('anyone else sending SEND 12 is an ordinary message', async () => {
    const o = await setup();
    expect(await decide('+919811111111', 'send', o.approval_ref)).toEqual({ handled: false });
    expect((await sq<{ status: string }>(f.db, `select status from public.wa_outbox where id = $1`, [o.id]))[0]!.status).toBe('pending_approval');
  });

  it('ordinary (non-AI) suggestions are only sent to approvers when chosen', async () => {
    await sq(f.db, `update public.profiles set phone = $2 where id = $1`, [f.teacherA, APPROVER_PHONE]);
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{reply_messages}')`, [f.teacherA]);
    await q(f.db, f.admin, `select public.dv_set_reply_approver($1, true)`, [f.teacherA]);
    await record(await incoming('when is the next course?'), 'course_info', 'Course: Happiness', 'course_details');
    expect(await sq(f.db, `select 1 from public.wa_outbox where idempotency_key like 'reply-ask:%'`)).toHaveLength(0);
    await sq(f.db, `update public.dv_ai_settings set ask_on_whatsapp = 'all' where id`);
    await record(await incoming('when is the next course again?'), 'course_info', 'Course: Happiness', 'course_details');
    expect(await sq(f.db, `select 1 from public.wa_outbox where idempotency_key like 'reply-ask:%'`)).toHaveLength(1);
  });

  it('approvers need the Reply permission and a phone', async () => {
    await expect(q(f.db, f.admin, `select public.dv_set_reply_approver($1, true)`, [f.teacherA])).rejects.toThrow(/Reply/);
    void asUser;
  });
});
