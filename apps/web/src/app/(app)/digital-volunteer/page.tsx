import type { Metadata } from 'next';
import Link from 'next/link';
import { WA_STATUS_LABELS } from '@crm/shared';
import { Alert, Badge, Card, CardHeader, cn } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { formatDateTime, relativeTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { formatPhone } from '@crm/shared';
import { gatewayAlive, type WaAccount } from './shared';

export const metadata: Metadata = { title: 'Digital Volunteer' };

export default async function DigitalVolunteerOverview() {
  const access = await requireDv();
  const supabase = await createClient();
  const settings = await getOrgSettings();
  // eslint-disable-next-line react-hooks/purity -- server component: rendered once per request
  const now = Date.now();
  const since = new Date(now - 86_400_000).toISOString();
  const canMessages = access.can('view_messages');

  const [{ data: acc }, groups, inbound, outbound, failed, queued, review, sevaWaiting, staleReview, annWaiting] = await Promise.all([
    supabase.from('wa_account').select('*').eq('id', true).maybeSingle<WaAccount>(),
    supabase.from('wa_groups').select('enabled, is_member'),
    canMessages ? supabase.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'in').gte('received_at', since) : null,
    canMessages ? supabase.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'out').gte('received_at', since) : null,
    canMessages ? supabase.from('wa_outbox').select('id', { count: 'exact', head: true }).eq('status', 'failed') : null,
    canMessages ? supabase.from('wa_outbox').select('id', { count: 'exact', head: true }).in('status', ['queued', 'sending']) : null,
    canMessages ? supabase.from('wa_messages').select('id', { count: 'exact', head: true }).eq('status', 'needs_review') : null,
    access.can('assign_seva') ? supabase.from('dv_seva_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending') : null,
    canMessages ? supabase.from('wa_messages').select('id', { count: 'exact', head: true }).eq('status', 'needs_review').lt('received_at', since) : null,
    access.can('schedule_announcements')
      ? supabase.from('dv_announcements').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval')
      : null,
  ]);
  if (!acc) return <Alert tone="warn">Digital Volunteer is not set up yet. Run the latest database migration.</Alert>;

  const alive = gatewayAlive(acc.gateway_seen_at, now);
  const groupRows = (groups.data ?? []) as { enabled: boolean; is_member: boolean }[];
  const tiles = (canMessages
    ? [
        { label: 'Messages in (24 h)', value: inbound?.count ?? 0 },
        { label: 'Messages out (24 h)', value: outbound?.count ?? 0 },
        { label: 'Waiting for review', value: review?.count ?? 0 },
        { label: 'Waiting to send', value: queued?.count ?? 0 },
        { label: 'Failed to send', value: failed?.count ?? 0, tone: (failed?.count ?? 0) > 0 ? 'danger' : undefined },
      ]
    : []
  ).concat(
    sevaWaiting ? [{ label: 'Seva requests waiting', value: sevaWaiting.count ?? 0, tone: (sevaWaiting.count ?? 0) > 0 ? 'warn' : undefined }] : [],
  ) as { label: string; value: number; tone?: 'danger' | 'warn' }[];

  // Health checks: what must be true for Digital Volunteer to work, and what needs a person.
  const enabledGroups = groupRows.filter((g) => g.enabled && g.is_member).length;
  const checks: { ok: boolean; label: string; fix?: string; href?: string }[] = [
    { ok: alive, label: 'Gateway is running', fix: 'Start apps/wa-gateway (see docs/DIGITAL_VOLUNTEER.md)' },
    { ok: acc.status === 'connected', label: 'WhatsApp number is linked and connected', fix: 'Link it from WhatsApp account', href: '/digital-volunteer/account' },
    { ok: acc.enabled, label: 'Digital Volunteer is switched on', fix: 'Turn it on from WhatsApp account', href: '/digital-volunteer/account' },
    { ok: enabledGroups > 0, label: 'At least one group is enabled', fix: 'Enable groups', href: '/digital-volunteer/groups' },
  ];
  if (failed) checks.push({ ok: !failed.count, label: 'No messages failed to send', fix: `${failed.count} failed: check them in the inbox`, href: '/digital-volunteer/inbox' });
  if (staleReview) checks.push({ ok: !staleReview.count, label: 'No message has waited more than a day', fix: `${staleReview.count} waiting since yesterday or earlier`, href: '/digital-volunteer/inbox' });
  if (annWaiting) checks.push({ ok: !annWaiting.count, label: 'No announcement waiting for approval', fix: `${annWaiting.count} waiting`, href: '/digital-volunteer/announcements' });

  return (
    <div className="space-y-6">
      {!acc.enabled ? (
        <Alert tone="warn">
          Digital Volunteer is <strong>switched off</strong>: it reads and sends nothing.
          {access.can('manage_integration') ? (
            <>
              {' '}
              Turn it on from{' '}
              <Link href="/digital-volunteer/account" className="underline">
                WhatsApp account
              </Link>
              .
            </>
          ) : null}
        </Alert>
      ) : acc.auto_paused ? (
        <Alert tone="info">Automatic replies are paused. People can still reply from the inbox.</Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connection" />
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2 px-5 py-4 text-sm">
            <dt className="text-ink-muted">WhatsApp</dt>
            <dd>
              <Badge tone={acc.status === 'connected' ? 'ok' : acc.status === 'waiting_for_scan' || acc.status === 'connecting' ? 'warn' : 'danger'}>
                {WA_STATUS_LABELS[acc.status] ?? acc.status}
              </Badge>
            </dd>
            <dt className="text-ink-muted">Number</dt>
            <dd>{acc.phone_e164 ? `${formatPhone(acc.phone_e164)}${acc.display_name ? ` · ${acc.display_name}` : ''}` : '—'}</dd>
            <dt className="text-ink-muted">Gateway</dt>
            <dd>
              {alive ? (
                <span className="text-ok">Running</span>
              ) : (
                <span className="text-danger">Not running{acc.gateway_seen_at ? ` (last seen ${relativeTime(acc.gateway_seen_at)})` : ''}</span>
              )}
            </dd>
            <dt className="text-ink-muted">Linked since</dt>
            <dd>{acc.connected_at ? formatDateTime(acc.connected_at, settings.default_timezone) : '—'}</dd>
          </dl>
          {acc.last_error ? (
            <div className="border-t border-line px-5 py-3 text-sm">
              <p className="text-ink-muted">Last problem{acc.last_error_at ? ` · ${relativeTime(acc.last_error_at)}` : ''}</p>
              <p className="mt-1">{acc.last_error}</p>
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader title="Groups" />
          <div className="px-5 py-4 text-sm">
            <p>
              <span className="text-2xl font-semibold tabular-nums">{groupRows.filter((g) => g.enabled && g.is_member).length}</span>{' '}
              <span className="text-ink-muted">enabled of {groupRows.length} found</span>
            </p>
            <p className="mt-2 text-ink-muted">
              The bot ignores every group until it is enabled, and only does what each group allows.{' '}
              <Link href="/digital-volunteer/groups" className="text-accent underline">
                Manage groups
              </Link>
            </p>
          </div>
        </Card>
      </div>

      {tiles.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {tiles.map((t) => (
            <Card key={t.label} className="p-4">
              <p className="text-xs text-ink-muted">{t.label}</p>
              <p className={cn('mt-1 text-2xl font-semibold tabular-nums', t.tone === 'danger' && 'text-danger', t.tone === 'warn' && 'text-warn')}>{t.value}</p>
            </Card>
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader title="Checks" description={checks.every((c) => c.ok) ? 'Everything looks right.' : 'Some things need attention.'} />
        <ul className="divide-y divide-line text-sm">
          {checks.map((c) => (
            <li key={c.label} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
              <span>
                <span aria-hidden="true" className={cn('mr-2', c.ok ? 'text-ok' : 'text-danger')}>
                  {c.ok ? '✓' : '✗'}
                </span>
                <span className="sr-only">{c.ok ? 'OK: ' : 'Problem: '}</span>
                {c.label}
              </span>
              {!c.ok && c.fix ? (
                c.href ? (
                  <Link href={c.href} className="text-accent underline">
                    {c.fix}
                  </Link>
                ) : (
                  <span className="text-ink-muted">{c.fix}</span>
                )
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {!alive ? (
        <Card className="p-5 text-sm">
          <h2 className="font-semibold">Start the gateway</h2>
          <p className="mt-1 text-ink-muted">
            The gateway is the small program that keeps the WhatsApp connection open. Until it runs, linking, reading and sending can&apos;t happen. See
            <code className="mx-1 rounded bg-canvas px-1">docs/DIGITAL_VOLUNTEER.md</code>for how to start it.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
