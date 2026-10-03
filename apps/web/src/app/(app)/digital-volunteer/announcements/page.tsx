import type { Metadata } from 'next';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import { getOrgSettings, requireProfile } from '@/lib/auth';
import { getProfileNames } from '@/lib/data';
import { requireDv } from '@/lib/dv';
import { formatDateTime, relativeTime, toLocalInputValue } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { AnnouncementActions, NewAnnouncement, type GroupOption } from './controls';

export const metadata: Metadata = { title: 'Announcements' };

type Announcement = {
  id: string;
  title: string;
  body: string | null;
  poster_path: string | null;
  send_at: string;
  status: 'pending_approval' | 'scheduled' | 'sending' | 'sent' | 'partly_sent' | 'failed' | 'rejected' | 'cancelled';
  created_by: string;
  decided_by: string | null;
  reason: string | null;
};
type Target = { announcement_id: string; group_id: string; outbox_id: string | null };
type OutboxRow = { id: string; status: string; last_error: string | null };

const STATUS: Record<Announcement['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  pending_approval: { label: 'Waiting for approval', tone: 'warn' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'ok' },
  partly_sent: { label: 'Partly sent', tone: 'warn' },
  failed: { label: 'Not sent', tone: 'danger' },
  rejected: { label: 'Not approved', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export default async function AnnouncementsPage() {
  const access = await requireDv('schedule_announcements');
  const [profile, settings, names, supabase] = await Promise.all([requireProfile(), getOrgSettings(), getProfileNames(), createClient()]);

  const [{ data: rows }, { data: targets }, { data: groups }] = await Promise.all([
    supabase.from('dv_announcements').select('*').order('send_at', { ascending: false }).limit(50),
    supabase.from('dv_announcement_groups').select('announcement_id, group_id, outbox_id'),
    supabase.from('wa_groups').select('id, name, enabled, is_member, allow_announcements, allow_media').order('name'),
  ]);
  const list = (rows ?? []) as Announcement[];
  const groupName = new Map((groups ?? []).map((g) => [g.id as string, (g.name as string) || 'Unnamed group']));
  const options: GroupOption[] = (groups ?? [])
    .filter((g) => g.enabled && g.is_member && g.allow_announcements)
    .map((g) => ({ id: g.id as string, name: (g.name as string) || 'Unnamed group', media: !!g.allow_media }));

  const outboxIds = ((targets ?? []) as Target[]).map((t) => t.outbox_id).filter(Boolean) as string[];
  const [{ data: outbox }, posters] = await Promise.all([
    outboxIds.length ? supabase.from('wa_outbox').select('id, status, last_error').in('id', outboxIds) : Promise.resolve({ data: [] as OutboxRow[] }),
    (async () => {
      const paths = list.map((a) => a.poster_path).filter(Boolean) as string[];
      if (!paths.length) return new Map<string, string>();
      const { data } = await supabase.storage.from('dv-posters').createSignedUrls(paths, 3600);
      return new Map((data ?? []).filter((d) => d.signedUrl).map((d) => [d.path as string, d.signedUrl]));
    })(),
  ]);
  const outboxById = new Map(((outbox ?? []) as OutboxRow[]).map((o) => [o.id, o]));
  const targetsOf = (id: string) => ((targets ?? []) as Target[]).filter((t) => t.announcement_id === id);
  // eslint-disable-next-line react-hooks/purity -- server component: rendered once per request
  const defaultSendAt = toLocalInputValue(new Date(Date.now() + 3_600_000), settings.default_timezone);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
      <section aria-labelledby="ann-list" className="space-y-3">
        <h2 id="ann-list" className="font-semibold">
          Announcements
        </h2>
        {list.length === 0 ? (
          <Card>
            <EmptyState title="No announcements yet" description="Create one on the right. It is sent only after a second person approves it." />
          </Card>
        ) : (
          list.map((a) => {
            const s = STATUS[a.status];
            const poster = a.poster_path ? posters.get(a.poster_path) : undefined;
            const mine = a.created_by === profile.id;
            const open = a.status === 'pending_approval' || a.status === 'scheduled' || a.status === 'sending';
            return (
              <Card key={a.id} className="p-5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{a.title}</p>
                    <p className="text-xs text-ink-muted">
                      {formatDateTime(a.send_at, settings.default_timezone)} ({relativeTime(a.send_at)}) · by {names.get(a.created_by) ?? 'someone'}
                      {a.decided_by && a.status !== 'pending_approval' ? ` · decided by ${names.get(a.decided_by) ?? 'someone'}` : ''}
                    </p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-3">
                  {poster ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
                    <img src={poster} alt="Poster" className="h-32 w-auto rounded-lg border border-line object-contain" />
                  ) : a.poster_path ? (
                    <span className="text-ink-muted">[poster]</span>
                  ) : null}
                  {a.body ? <p className="min-w-0 flex-1 rounded-lg bg-canvas px-3 py-2 whitespace-pre-wrap">{a.body}</p> : null}
                </div>
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {targetsOf(a.id).map((t) => {
                    const o = t.outbox_id ? outboxById.get(t.outbox_id) : undefined;
                    return (
                      <li key={t.group_id} title={o?.last_error ?? undefined}>
                        <Badge tone={o?.status === 'sent' ? 'ok' : o?.status === 'failed' ? 'danger' : 'neutral'}>
                          {groupName.get(t.group_id) ?? 'Group'}
                          {o ? ` · ${o.status === 'queued' ? 'waiting' : o.status}` : ''}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
                {a.reason ? <p className="mt-2 text-ink-muted">Reason: {a.reason}</p> : null}
                {open ? (
                  <AnnouncementActions
                    id={a.id}
                    canApprove={a.status === 'pending_approval' && (!mine || access.isSuperAdmin)}
                    canCancel={a.status !== 'pending_approval' || mine}
                  />
                ) : null}
              </Card>
            );
          })
        )}
      </section>

      <section>
        <Card>
          <CardHeader title="New announcement" description="Sent to the chosen groups at the time you pick, after a second person approves it." />
          <NewAnnouncement groups={options} defaultSendAt={defaultSendAt} />
        </Card>
      </section>
    </div>
  );
}
