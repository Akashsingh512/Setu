import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPhone } from '@crm/shared';
import { Alert, Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { getCourses, getStatuses, getTeams } from '@/lib/data';
import { requireDv } from '@/lib/dv';
import { formatDateTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { BulkControls, OptOutForm, RemoveOptOut } from './controls';
import { NewBulk } from './new-bulk';

export const metadata: Metadata = { title: 'Bulk messages' };

type Campaign = {
  id: string;
  title: string;
  status: string;
  status_reason: string | null;
  audience: string | null;
  start_at: string;
  next_send_at: string | null;
  created_at: string;
};
type Progress = { campaign_id: string; total: number; sent: number; failed: number; waiting: number; skipped: number };

const STATUS: Record<string, { label: string; tone: 'info' | 'accent' | 'warn' | 'ok' | 'neutral' }> = {
  scheduled: { label: 'Scheduled', tone: 'info' },
  sending: { label: 'Sending', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  completed: { label: 'Done', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export default async function BulkPage() {
  await requireDv('schedule_announcements');
  const supabase = await createClient();
  const [settings, statuses, courses, teams, { data: campaigns, error }, { data: progress }, { data: optOuts }, { data: account }] = await Promise.all([
    getOrgSettings(),
    getStatuses(),
    getCourses(),
    getTeams(),
    supabase
      .from('dv_bulk_campaigns')
      .select('id, title, status, status_reason, audience, start_at, next_send_at, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    supabase.from('dv_bulk_progress').select('*'),
    supabase.from('dv_opt_outs').select('phone, source, created_at').order('created_at', { ascending: false }).limit(200),
    supabase.from('wa_account').select('enabled, status').maybeSingle(),
  ]);
  if (error) return <Alert>Run the latest database migration to use bulk messages.</Alert>;
  const prog = new Map(((progress ?? []) as Progress[]).map((p) => [p.campaign_id, p]));
  const tz = settings.default_timezone;

  return (
    <div className="space-y-6">
      <Alert tone="warn">
        WhatsApp can ban a number that messages many people who do not know it. Send only to people who expect to hear from you, keep the pace slow, and keep
        the STOP line. Sending happens only while the number is linked and Digital Volunteer is on
        {account && (account.status !== 'connected' || !account.enabled) ? ' (right now it is not, so nothing will go out)' : ''}.
      </Alert>

      <NewBulk
        statuses={statuses.filter((s) => s.is_active).map((s) => ({ id: s.code, label: s.label }))}
        courses={courses.map((c) => ({ id: c.id, label: c.name }))}
        teams={teams.map((t) => ({ id: t.id, label: t.name }))}
      />

      <Card>
        <CardHeader title="Bulk messages" />
        {(campaigns ?? []).length === 0 ? (
          <EmptyState title="None yet" description="Bulk messages you schedule appear here with their progress." />
        ) : (
          <ul className="divide-y divide-line">
            {((campaigns ?? []) as Campaign[]).map((c) => {
              const p = prog.get(c.id);
              const done = p ? p.sent + p.failed + p.skipped : 0;
              const pct = p && p.total ? Math.round((done / p.total) * 100) : 0;
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-4 px-5 py-4 text-sm">
                  <div className="min-w-56 flex-1">
                    <Link href={`/digital-volunteer/bulk/${c.id}`} className="font-medium hover:underline">
                      {c.title}
                    </Link>{' '}
                    <Badge tone={STATUS[c.status]?.tone ?? 'neutral'}>{STATUS[c.status]?.label ?? c.status}</Badge>
                    <p className="text-xs text-ink-muted">
                      {c.audience ? `${c.audience} · ` : ''}
                      {c.status === 'scheduled' ? `starts ${formatDateTime(c.start_at, tz)}` : `created ${formatDateTime(c.created_at, tz)}`}
                      {c.next_send_at && (c.status === 'sending' || c.status === 'scheduled') ? ` · next around ${formatDateTime(c.next_send_at, tz)}` : ''}
                    </p>
                    {c.status_reason && c.status === 'paused' ? <p className="text-xs text-warn">{c.status_reason}</p> : null}
                  </div>
                  {p ? (
                    <div className="w-56">
                      <div className="h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-ink-muted tabular-nums">
                        {p.sent} sent · {p.waiting} waiting{p.failed ? ` · ${p.failed} failed` : ''}
                        {p.skipped ? ` · ${p.skipped} skipped` : ''} · of {p.total}
                      </p>
                    </div>
                  ) : null}
                  <BulkControls id={c.id} status={c.status} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Do-not-message list"
          description="People who replied STOP, or numbers you added. They never get bulk messages. Replies and lead messages still work."
        />
        <div className="border-b border-line px-5 py-4">
          <OptOutForm />
        </div>
        {(optOuts ?? []).length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">Nobody yet.</p>
        ) : (
          <ul className="grid gap-x-6 px-5 py-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {(optOuts ?? []).map((o) => (
              <li key={o.phone as string} className="flex items-center justify-between gap-2 py-1.5">
                <span className="tabular-nums">
                  {formatPhone(o.phone as string)} <span className="text-xs text-ink-muted">{o.source === 'reply' ? 'replied STOP' : 'added by hand'}</span>
                </span>
                <RemoveOptOut phone={o.phone as string} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
