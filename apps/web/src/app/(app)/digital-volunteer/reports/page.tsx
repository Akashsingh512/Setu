import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, CardHeader, cn, EmptyState, Stat } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { formatDate, formatDateTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Digital Volunteer reports' };

type Report = {
  messages: { in: number; out: number; in_groups: number; in_direct: number; needs_review: number };
  by_day: { day: string; in: number; out: number }[];
  intents: Record<string, number>;
  replies: Record<'automatic' | 'approved_suggestions' | 'written_by_people' | 'seva_numbers' | 'announcements' | 'failed' | 'discarded', number>;
  seva: Record<'requests' | 'fulfilled' | 'automatic' | 'rejected' | 'no_leads' | 'pending' | 'leads_assigned', number>;
  announcements: Record<string, number>;
  lead_replies: number;
  groups: { name: string; in: number }[];
};
type AuditRow = { id: number; created_at: string; actor_name: string; action: string; entity_type: string; data: Record<string, unknown> };

const PERIODS = { '7': 'Last 7 days', '30': 'Last 30 days', '90': 'Last 90 days' } as const;
const INTENTS: Record<string, string> = { course_info: 'Course questions', seva_request: 'Seva requests', none: 'Other messages', 'not analysed': 'Not analysed' };
const ACTIONS: Record<string, string> = {
  'dv.permissions_changed': 'Operator access changed',
  'dv.switches_changed': 'Safety switches changed',
  'dv.dm_settings_changed': 'Direct chat settings changed',
  'dv.command': 'Gateway command',
  'dv.group_updated': 'Group settings changed',
  'dv.message_queued': 'Message sent by a person',
  'dv.message_cancelled': 'Message cancelled',
  'dv.message_dismissed': 'Message marked handled',
  'dv.suggestion_approved': 'Suggested reply approved',
  'dv.template_saved': 'Course response edited',
  'dv.followup_confirmed': 'Follow-up confirmed from WhatsApp',
  'dv.announcement_created': 'Announcement created',
  'dv.announcement_approved': 'Announcement approved',
  'dv.announcement_rejected': 'Announcement not approved',
  'dv.announcement_cancelled': 'Announcement cancelled',
  'dv.seva_identified': 'Seva requester identified',
  'dv.sender_unlinked': 'Remembered sender removed',
};

export default async function DvReportsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requireDv('view_audit');
  const { days: raw } = await searchParams;
  const days = raw && raw in PERIODS ? (raw as keyof typeof PERIODS) : '7';
  const [settings, supabase] = await Promise.all([getOrgSettings(), createClient()]);
  // eslint-disable-next-line react-hooks/purity -- server component: rendered once per request
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - Number(days) * 86_400_000);

  const [{ data, error }, { data: audit }] = await Promise.all([
    supabase.rpc('dv_report', { p_from: from.toISOString(), p_to: to.toISOString() }),
    supabase.rpc('dv_audit_log', { p_limit: 100 }),
  ]);
  if (error || !data) return <Alert>Could not load the report. Run the latest database migration.</Alert>;
  const r = data as Report;
  const maxDay = Math.max(1, ...r.by_day.map((d) => d.in + d.out));

  return (
    <div className="space-y-6">
      <nav aria-label="Period" className="flex flex-wrap gap-2 text-sm">
        {(Object.keys(PERIODS) as (keyof typeof PERIODS)[]).map((k) => (
          <Link
            key={k}
            href={`/digital-volunteer/reports?days=${k}`}
            aria-current={k === days ? 'page' : undefined}
            className={cn('rounded-full border px-3 py-1', k === days ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:text-ink')}
          >
            {PERIODS[k]}
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Messages in" value={r.messages.in} />
        <Stat label="Messages out" value={r.messages.out} />
        <Stat label="Lead replies logged" value={r.lead_replies} />
        <Stat label="Seva leads assigned" value={r.seva.leads_assigned} />
        <Stat label="Announcements sent" value={r.replies.announcements} />
        <Stat label="Failed to send" value={r.replies.failed} tone={r.replies.failed ? 'danger' : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Messages per day" description="Incoming and outgoing" />
          {r.by_day.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-muted">
                <tr>
                  <th className="px-5 py-2 font-medium">Day</th>
                  <th className="px-2 py-2 text-right font-medium">In</th>
                  <th className="px-2 py-2 text-right font-medium">Out</th>
                  <th className="w-1/2 px-5 py-2">
                    <span className="sr-only">Volume</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.by_day.map((d) => (
                  <tr key={d.day}>
                    <td className="px-5 py-1.5 whitespace-nowrap">{formatDate(d.day)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.in}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.out}</td>
                    <td className="px-5 py-1.5" aria-hidden="true">
                      <div className="flex h-2 overflow-hidden rounded-full bg-canvas">
                        <div className="bg-accent" style={{ width: `${(d.in / maxDay) * 100}%` }} />
                        <div className="bg-accent/40" style={{ width: `${(d.out / maxDay) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No messages in this period" />
          )}
        </Card>

        <Card>
          <CardHeader title="What people asked" />
          <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 px-5 py-4 text-sm">
            {Object.entries(r.intents).length ? (
              Object.entries(r.intents)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => (
                  <div key={k} className="contents">
                    <dt>{INTENTS[k] ?? k}</dt>
                    <dd className="text-right tabular-nums">{n}</dd>
                  </div>
                ))
            ) : (
              <p className="text-ink-muted">Nothing yet.</p>
            )}
          </dl>
          <CardHeader title="How replies went out" />
          <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 px-5 py-4 text-sm">
            <dt>Sent automatically</dt>
            <dd className="text-right tabular-nums">{r.replies.automatic}</dd>
            <dt>Suggested, approved by a person</dt>
            <dd className="text-right tabular-nums">{r.replies.approved_suggestions}</dd>
            <dt>Written by a person</dt>
            <dd className="text-right tabular-nums">{r.replies.written_by_people}</dd>
            <dt>Seva lead details</dt>
            <dd className="text-right tabular-nums">{r.replies.seva_numbers}</dd>
            <dt>Discarded or cancelled</dt>
            <dd className="text-right tabular-nums">{r.replies.discarded}</dd>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Seva requests" />
          <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 px-5 py-4 text-sm">
            <dt>Requests</dt>
            <dd className="text-right tabular-nums">{r.seva.requests}</dd>
            <dt>Leads given (of which automatic)</dt>
            <dd className="text-right tabular-nums">
              {r.seva.fulfilled} ({r.seva.automatic})
            </dd>
            <dt>Declined</dt>
            <dd className="text-right tabular-nums">{r.seva.rejected}</dd>
            <dt>No leads available</dt>
            <dd className="text-right tabular-nums">{r.seva.no_leads}</dd>
            <dt>Still waiting</dt>
            <dd className="text-right tabular-nums">{r.seva.pending}</dd>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Busiest groups" description="Incoming messages" />
          {r.groups.length ? (
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 px-5 py-4 text-sm">
              {r.groups.map((g) => (
                <div key={g.name} className="contents">
                  <dt className="truncate">{g.name || 'Unnamed group'}</dt>
                  <dd className="text-right tabular-nums">{g.in}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <EmptyState title="No group messages in this period" />
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Audit log" description="Every change to Digital Volunteer settings and every human action, newest first (last 100)." />
        {(audit as AuditRow[] | null)?.length ? (
          <ol className="divide-y divide-line text-sm">
            {(audit as AuditRow[]).map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 px-5 py-2.5">
                <span>
                  <span className="font-medium">{ACTIONS[a.action] ?? a.action}</span>
                  <span className="text-ink-muted"> · {a.actor_name}</span>
                  {typeof a.data.name === 'string' && a.data.name ? <span className="text-ink-muted"> · {a.data.name}</span> : null}
                  {typeof a.data.title === 'string' ? <span className="text-ink-muted"> · {a.data.title}</span> : null}
                  {typeof a.data.command === 'string' ? <span className="text-ink-muted"> · {a.data.command}</span> : null}
                </span>
                <span className="text-ink-muted">{formatDateTime(a.created_at, settings.default_timezone)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState title="Nothing recorded yet" />
        )}
      </Card>
    </div>
  );
}
