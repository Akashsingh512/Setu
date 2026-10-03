import { beforeEach, describe, expect, it } from 'vitest';
import { createFixture, q, sq, svc, type Fixture } from '../src/db';

let f: Fixture;
const GROUP = '120363000000000001@g.us';

beforeEach(async () => {
  f = await createFixture();
  await svc(f.db, `select public.dv_sync_groups($1)`, [JSON.stringify([{ jid: GROUP, name: 'Satsang' }])]);
  await sq(f.db, `update public.wa_account set enabled = true where id`);
  await sq(f.db, `update public.wa_groups set enabled = true, allow_read = true`);
});

const report = (who: string) =>
  q<{ r: Record<string, any> }>(f.db, who, `select public.dv_report(now() - interval '1 day', now() + interval '1 day') as r`).then((x) => x[0]!.r);

describe('Digital Volunteer reports', () => {
  it('needs the Reports & audit permission', async () => {
    await expect(report(f.teacherA)).rejects.toThrow(/Not authorised/);
    await expect(q(f.db, f.teacherA, `select * from public.dv_audit_log()`)).rejects.toThrow(/Not authorised/);
    await q(f.db, f.admin, `select public.dv_set_operator_permissions($1, '{view_audit}')`, [f.teacherA]);
    expect(await report(f.teacherA)).toBeTruthy();
  });

  it('counts messages, intents and groups without exposing text', async () => {
    for (const [i, body] of ['hello', 'when is the course?'].entries()) {
      const [m] = await svc<{ id: string }>(f.db, `select public.dv_ingest_message($1, $2, 'in', null, null, 'A', $3, null, now()) as id`, [GROUP, `M${i}`, body]);
      await svc(f.db, `select public.dv_record_intent($1, $2, 'keywords')`, [m!.id, i ? 'course_info' : 'none']);
    }
    const r = await report(f.admin);
    expect(r.messages).toMatchObject({ in: 2, out: 0, in_groups: 2, in_direct: 0 });
    expect(r.intents).toEqual({ none: 1, course_info: 1 });
    expect(r.groups).toEqual([{ name: 'Satsang', in: 2 }]);
    expect(r.by_day).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('hello');
  });

  it('rejects silly periods', async () => {
    await expect(q(f.db, f.admin, `select public.dv_report(now(), now() - interval '1 day')`)).rejects.toThrow(/period/);
  });

  it('the audit log shows only Digital Volunteer entries', async () => {
    await q(f.db, f.admin, `select public.dv_set_switches(false)`);
    await sq(f.db, `insert into public.audit_logs (action, entity_type) values ('lead.exported', 'lead')`);
    const rows = await q<{ action: string; actor_name: string }>(f.db, f.admin, `select action, actor_name from public.dv_audit_log()`);
    expect(rows.map((r) => r.action)).toEqual(['dv.switches_changed']);
  });
});
