import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatPhone } from '@crm/shared';
import { Badge, Card, CardHeader } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { formatDateTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { BulkControls } from '../controls';

export const metadata: Metadata = { title: 'Bulk message' };

const RECIPIENT: Record<string, { label: string; tone: 'info' | 'accent' | 'warn' | 'ok' | 'neutral' | 'danger' }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  queued: { label: 'Sending soon', tone: 'info' },
  sent: { label: 'Sent', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Not sent', tone: 'neutral' },
  opted_out: { label: 'Replied STOP', tone: 'warn' },
};

export default async function BulkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireDv('schedule_announcements');
  const { id } = await params;
  const supabase = await createClient();
  const settings = await getOrgSettings();
  const [{ data: c }, { data: rows }] = await Promise.all([
    supabase.from('dv_bulk_campaigns').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('dv_bulk_recipients')
      .select('id, seq, phone, name, status, scheduled_at, done_at, error, lead_id')
      .eq('campaign_id', id)
      .order('seq')
      .limit(5000),
  ]);
  if (!c) notFound();
  const tz = settings.default_timezone;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = Array.isArray(c.send_days) && c.send_days.length ? (c.send_days as number[]).map((d) => DAYS[d - 1]).join(', ') : 'every day';
  const pace = `${days}, ${c.min_gap_s}–${c.max_gap_s} s apart, typing ${c.typing_min_s}–${c.typing_max_s} s, up to ${c.daily_cap} a day${
    c.window_start ? `, ${String(c.window_start).slice(0, 5)}–${String(c.window_end).slice(0, 5)}` : ''
  }${c.batch_size ? `, a ${c.batch_pause_min} min break after every ${c.batch_size}` : ''}`;

  return (
    <div className="space-y-4">
      <Link href="/digital-volunteer/bulk" className="text-sm text-ink-muted hover:text-ink">
        ← Bulk messages
      </Link>
      <Card>
        <CardHeader title={c.title} description={pace} action={<BulkControls id={c.id} status={c.status} />} />
        <div className="grid gap-4 p-5 text-sm lg:grid-cols-[1fr_280px]">
          <p className="rounded-lg border border-line bg-canvas p-3 whitespace-pre-wrap">{c.body}</p>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1.5">
            <dt className="text-ink-muted">Status</dt>
            <dd>
              {c.status}
              {c.status_reason ? ` · ${c.status_reason}` : ''}
            </dd>
            <dt className="text-ink-muted">To</dt>
            <dd>{c.audience || '—'}</dd>
            <dt className="text-ink-muted">Starts</dt>
            <dd>{formatDateTime(c.start_at, tz)}</dd>
            <dt className="text-ink-muted">Poster</dt>
            <dd>{c.poster_path ? 'Yes' : 'No'}</dd>
          </dl>
        </div>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line text-left text-ink-muted">
            <tr>
              <th className="px-5 py-3 font-medium">#</th>
              <th className="px-2 py-3 font-medium">Person</th>
              <th className="px-2 py-3 font-medium">Status</th>
              <th className="px-2 py-3 font-medium">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(rows ?? []).map((r) => (
              <tr key={r.id as string}>
                <td className="px-5 py-2.5 text-ink-muted tabular-nums">{r.seq as number}</td>
                <td className="px-2 py-2.5">
                  {r.lead_id ? (
                    <Link href={`/leads/${r.lead_id}`} className="font-medium hover:underline">
                      {(r.name as string) || 'Lead'}
                    </Link>
                  ) : (
                    <span className="font-medium">{(r.name as string) || '—'}</span>
                  )}
                  <span className="block text-xs text-ink-muted tabular-nums">{formatPhone(r.phone as string)}</span>
                </td>
                <td className="px-2 py-2.5">
                  <Badge tone={RECIPIENT[r.status as string]?.tone ?? 'neutral'}>{RECIPIENT[r.status as string]?.label ?? (r.status as string)}</Badge>
                  {r.error ? <span className="block text-xs text-danger">{r.error as string}</span> : null}
                </td>
                <td className="px-2 py-2.5 text-ink-muted">
                  {r.done_at ? formatDateTime(r.done_at as string, tz) : r.scheduled_at ? `around ${formatDateTime(r.scheduled_at as string, tz)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
