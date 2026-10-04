import type { Metadata } from 'next';
import { Alert, Card, CardHeader } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { formatDateTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { gatewayAlive, type WaAccount } from '../shared';
import { AutoRefresh } from '../auto-refresh';
import { DmSettingsForm, LinkPanel, ReplyApproverToggle, SafetySwitches } from './controls';

export const metadata: Metadata = { title: 'WhatsApp account' };

export default async function AccountPage() {
  await requireDv('manage_integration');
  const supabase = await createClient();
  const settings = await getOrgSettings();
  const [{ data: acc }, { data: pairing }, { data: commands }, { data: replyApprovers }] = await Promise.all([
    supabase.from('wa_account').select('*').eq('id', true).maybeSingle<WaAccount>(),
    supabase.from('wa_pairing').select('qr_data_url, updated_at').eq('id', true).maybeSingle<{ qr_data_url: string | null; updated_at: string }>(),
    supabase.from('wa_commands').select('id, command, requested_at, done_at, result').order('requested_at', { ascending: false }).limit(5),
    supabase.rpc('dv_reply_approver_candidates'),
  ]);
  if (!acc) return <Alert tone="warn">Run the Digital Volunteer database migration first.</Alert>;
  // eslint-disable-next-line react-hooks/purity -- server component: rendered once per request
  const alive = gatewayAlive(acc.gateway_seen_at, Date.now());

  const busy = acc.status === 'waiting_for_scan' || acc.status === 'connecting' || (commands ?? []).some((c) => !c.done_at);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <AutoRefresh active={busy} />
      <Card>
        <CardHeader title="Linked number" description="Use a dedicated number, not anyone's personal WhatsApp." />
        <div className="p-5">
          <LinkPanel status={acc.status} phone={acc.phone_e164} name={acc.display_name} qr={pairing?.qr_data_url ?? null} gatewayAlive={alive} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Safety switches" />
        <div className="p-5">
          <SafetySwitches enabled={acc.enabled} autoPaused={acc.auto_paused} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Direct chats" description="Messages sent to the number one-to-one (leads, volunteers)." />
        <div className="p-5">
          <DmSettingsForm mode={acc.dm_mode} courseInfo={acc.dm_course_info} followupSync={acc.dm_followup_sync} sevaRequests={acc.dm_seva_requests} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Approve suggested replies from WhatsApp"
          description="Chosen people get suggested replies on their own WhatsApp (which ones: Settings → AI) and answer SEND 12, EDIT 12 new text, or SKIP 12. They need the Reply permission and a phone number in Setu."
        />
        {((replyApprovers ?? []) as unknown[]).length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">Nobody can send replies yet. Give someone the Reply permission on Operators.</p>
        ) : (
          <ul className="divide-y divide-line">
            {((replyApprovers ?? []) as { id: string; full_name: string; has_phone: boolean; can_reply: boolean; is_approver: boolean }[]).map((a) => (
              <ReplyApproverToggle key={a.id} id={a.id} name={a.full_name} hasPhone={a.has_phone} canReply={a.can_reply} on={a.is_approver} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent requests to the gateway" />
        {commands?.length ? (
          <ul className="divide-y divide-line text-sm">
            {commands.map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2 px-5 py-2">
                <span>
                  {c.command === 'link' ? 'Link' : c.command === 'logout' ? 'Unlink' : 'Refresh groups'} ·{' '}
                  <span className="text-ink-muted">{formatDateTime(c.requested_at, settings.default_timezone)}</span>
                </span>
                <span className={c.done_at ? 'text-ink-muted' : 'text-warn'}>{c.done_at ? c.result : 'Waiting for gateway…'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-sm text-ink-muted">None yet.</p>
        )}
      </Card>
    </div>
  );
}
