import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, createLead, nextPhone, q, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});

const GROUP = '120363000000000001@g.us';
const grant = (who: string, perms: string[]) =>
  q(f.db, f.admin, `select public.dv_set_operator_permissions($1, $2::public.dv_permission[])`, [who, perms]);
const enable = () => sq(f.db, `update public.wa_account set enabled = true where id`);

async function addGroup(jid = GROUP) {
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid, name: 'Satsang Group', participant_count: 40 }])]);
  return (await sq<{ id: string }>(f.db, `select id from public.wa_groups where jid = $1`, [jid]))[0]!.id;
}

function ingest(chat: string, id: string, phone: string | null, body = 'hello') {
  return svc<{ id: string | null }>(
    f.db,
    `select public.dv_ingest_message($1, $2, 'in', $3, $4, 'Someone', $5, null, now()) as id`,
    [chat, id, phone ? `${phone.slice(1)}@s.whatsapp.net` : null, phone, body],
  );
}

describe('Digital Volunteer access', () => {
  it('only super admins grant permissions; operators cannot grant themselves more', async () => {
    await grant(f.teacherA, ['view_messages']);
    await expect(
      q(f.db, f.teacherA, `select public.dv_set_operator_permissions($1, '{manage_integration}')`, [f.teacherA]),
    ).rejects.toThrow(/Only a super admin/);
    const rows = await q<{ permission: string }>(f.db, f.teacherA, `select permission from public.dv_operator_permissions`);
    expect(rows.map((r) => r.permission)).toEqual(['view_messages']);
    // Others' grants are not visible.
    expect(await q(f.db, f.volA1, `select * from public.dv_operator_permissions`)).toEqual([]);
  });

  it('non-operators see nothing; permissions are checked per feature', async () => {
    await addGroup();
    expect(await q(f.db, f.volA1, `select * from public.wa_account`)).toEqual([]);
    expect(await q(f.db, f.volA1, `select * from public.wa_groups`)).toEqual([]);

    await grant(f.volA1, ['view_messages']);
    expect(await q(f.db, f.volA1, `select * from public.wa_groups`)).toHaveLength(1);
    // view_messages does not allow changing groups, linking, or seeing the QR.
    await q(f.db, f.volA1, `update public.wa_groups set enabled = true`);
    expect((await sq<{ enabled: boolean }>(f.db, `select enabled from public.wa_groups`))[0]!.enabled).toBe(false);
    await expect(q(f.db, f.volA1, `select public.dv_request_command('link')`)).rejects.toThrow(/Not authorised/);
    expect(await q(f.db, f.volA1, `select * from public.wa_pairing`)).toEqual([]);
    await expect(q(f.db, f.volA1, `select public.dv_set_switches(true)`)).rejects.toThrow(/Not authorised/);
  });

  it('revoking or deactivating a user removes access immediately', async () => {
    await grant(f.volA1, ['view_messages']);
    await grant(f.volA1, []);
    expect(await q(f.db, f.volA1, `select * from public.wa_account`)).toEqual([]);
    await grant(f.volA2, ['view_messages']);
    await sq(f.db, `update public.profiles set status = 'inactive' where id = $1`, [f.volA2]);
    expect(await q(f.db, f.volA2, `select * from public.wa_account`)).toEqual([]);
  });

  it('session keys and gateway functions are off-limits to every app user, even super admins', async () => {
    await svc(f.db, `insert into public.wa_auth_state (key, value) values ('creds', '{}')`);
    await expect(q(f.db, f.admin, `select * from public.wa_auth_state`)).rejects.toThrow(/permission denied/);
    await expect(q(f.db, f.admin, `select public.dv_claim_outbox()`)).rejects.toThrow(/permission denied/);
    await expect(
      q(f.db, f.admin, `select public.dv_ingest_message('a','b','in',null,null,null,'x',null,now())`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('groups', () => {
  it('group managers set permissions; gateway sync never resets them', async () => {
    const id = await addGroup();
    await grant(f.teacherA, ['manage_groups']);
    await q(f.db, f.teacherA, `update public.wa_groups set enabled = true, allow_course_info = true, mode = 'automatic' where id = $1`, [id]);
    await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'Renamed' }])]);
    const [g] = await sq(f.db, `select name, enabled, allow_course_info, mode, updated_by from public.wa_groups`);
    expect(g).toMatchObject({ name: 'Renamed', enabled: true, allow_course_info: true, mode: 'automatic', updated_by: f.teacherA });
    expect(await sq(f.db, `select * from public.audit_logs where action = 'dv.group_updated'`)).toHaveLength(1);
  });

  it('a group the number left is marked unavailable, keeping its settings', async () => {
    await addGroup();
    await svc(f.db, `select public.dv_sync_groups('[]')`);
    expect((await sq<{ is_member: boolean }>(f.db, `select is_member from public.wa_groups`))[0]!.is_member).toBe(false);
  });
});

describe('messages and outbox', () => {
  it('a redelivered event is stored once', async () => {
    const first = await ingest('919845000001@s.whatsapp.net', 'ABC123', '+919845000001');
    const again = await ingest('919845000001@s.whatsapp.net', 'ABC123', '+919845000001');
    expect(first[0]!.id).toBeTruthy();
    expect(again[0]!.id).toBeNull();
    expect(await sq(f.db, `select * from public.wa_messages`)).toHaveLength(1);
  });

  it('links a direct message to the one matching lead, and a sender to the matching CRM user', async () => {
    const phone = nextPhone();
    const lead = await createLead(f.db, f.teamA, { phone });
    await ingest(`${phone.slice(1)}@s.whatsapp.net`, 'M1', phone);
    expect((await sq<{ lead_id: string }>(f.db, `select lead_id from public.wa_messages`))[0]!.lead_id).toBe(lead);

    const volPhone = nextPhone();
    await sq(f.db, `update public.profiles set phone = $1 where id = $2`, [volPhone, f.volA1]);
    await ingest(`${volPhone.slice(1)}@s.whatsapp.net`, 'M2', volPhone);
    const [m] = await sq<{ sender_profile_id: string }>(f.db, `select sender_profile_id from public.wa_messages where provider_message_id = 'M2'`);
    expect(m!.sender_profile_id).toBe(f.volA1);
  });

  it('two leads with the same number: not linked (ambiguous)', async () => {
    const phone = nextPhone();
    await createLead(f.db, f.teamA, { phone });
    await createLead(f.db, f.teamB, { phone });
    await ingest(`${phone.slice(1)}@s.whatsapp.net`, 'M1', phone);
    expect((await sq<{ lead_id: string | null }>(f.db, `select lead_id from public.wa_messages`))[0]!.lead_id).toBeNull();
  });

  it('sending needs permission, an enabled account and an enabled group; no cold messages', async () => {
    const id = await addGroup();
    await grant(f.teacherA, ['reply_messages']);
    const send = (chat: string) => q(f.db, f.teacherA, `select public.dv_send_message($1, 'Jai Gurudev')`, [chat]);

    await expect(send(GROUP)).rejects.toThrow(/switched off/);
    await enable();
    await expect(send(GROUP)).rejects.toThrow(/not enabled/);
    await sq(f.db, `update public.wa_groups set enabled = true where id = $1`, [id]);
    await send(GROUP);
    await expect(send('919800000000@s.whatsapp.net')).rejects.toThrow(/only reply to chats/);
    await expect(q(f.db, f.volA1, `select public.dv_send_message($1, 'hi')`, [GROUP])).rejects.toThrow(/Not authorised/);
  });

  it('the gateway claims each queued message once, and nothing while switched off', async () => {
    const id = await addGroup();
    await sq(f.db, `update public.wa_groups set enabled = true where id = $1`, [id]);
    await enable();
    await grant(f.teacherA, ['reply_messages']);
    await q(f.db, f.teacherA, `select public.dv_send_message($1, 'One')`, [GROUP]);

    await sq(f.db, `update public.wa_account set enabled = false where id`);
    expect(await svc(f.db, `select * from public.dv_claim_outbox()`)).toEqual([]);
    await enable();
    const [claimed] = await svc<{ id: string }>(f.db, `select * from public.dv_claim_outbox()`);
    expect(claimed).toBeTruthy();
    expect(await svc(f.db, `select * from public.dv_claim_outbox()`)).toEqual([]);

    await svc(f.db, `select public.dv_complete_outbox($1, true, 'WAID1')`, [claimed!.id]);
    expect((await sq<{ status: string }>(f.db, `select status from public.wa_outbox`))[0]!.status).toBe('sent');
    await expect(q(f.db, f.teacherA, `select public.dv_cancel_outbox($1)`, [claimed!.id])).rejects.toThrow(/already/);
  });

  it('an interrupted send is not retried blindly', async () => {
    const id = await addGroup();
    await sq(f.db, `update public.wa_groups set enabled = true where id = $1`, [id]);
    await enable();
    await grant(f.teacherA, ['reply_messages']);
    await q(f.db, f.teacherA, `select public.dv_send_message($1, 'One')`, [GROUP]);
    await svc(f.db, `select * from public.dv_claim_outbox()`);
    await sq(f.db, `update public.wa_outbox set claimed_at = now() - interval '10 minutes'`);
    expect(await svc(f.db, `select * from public.dv_claim_outbox()`)).toEqual([]);
    expect((await sq<{ status: string }>(f.db, `select status from public.wa_outbox`))[0]!.status).toBe('failed');
  });
});
