import type { Metadata } from 'next';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import { getOrgSettings, requireProfile } from '@/lib/auth';
import { getProfileNames } from '@/lib/data';
import { requireDv } from '@/lib/dv';
import { formatDateTime, relativeTime, toLocalInputValue } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { introTalkMessage, type IntroTalk } from '../intro-talks/message';
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
  repeat_count: number;
  repeat_every_days: number;
};
type Target = { announcement_id: string; group_id: string };
type OutboxRow = {
  announcement_id: string;
  chat_jid: string;
  status: string;
  last_error: string | null;
  send_after: string;
};

const repeatLabel = (a: Announcement) =>
  a.repeat_count <= 1
    ? null
    : `${a.repeat_every_days === 1 ? 'Every day' : a.repeat_every_days === 7 ? 'Every week' : `Every ${a.repeat_every_days} days`} · ${a.repeat_count} times`;

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

export default async function AnnouncementsPage({ searchParams }: { searchParams: Promise<{ intro?: string }> }) {
  const access = await requireDv('schedule_announcements');
  const { intro } = await searchParams;
  const [profile, settings, names, supabase] = await Promise.all([requireProfile(), getOrgSettings(), getProfileNames(), createClient()]);

  const [{ data: rows }, { data: targets }, { data: groups }] = await Promise.all([
    supabase.from('dv_announcements').select('*').order('send_at', { ascending: false }).limit(50),
    supabase.from('dv_announcement_groups').select('announcement_id, group_id'),
    supabase.from('wa_groups').select('id, jid, name, enabled, is_member, allow_announcements, allow_media').order('name'),
  ]);
  const list = (rows ?? []) as Announcement[];
  const groupJid = new Map((groups ?? []).map((g) => [g.id as string, g.jid as string]));
  const groupName = new Map((groups ?? []).map((g) => [g.id as string, (g.name as string) || 'Unnamed group']));
  const options: GroupOption[] = (groups ?? [])
    .filter((g) => g.enabled && g.is_member && g.allow_announcements)
    .map((g) => ({
      id: g.id as string,
      name: (g.name as string) || 'Unnamed group',
      media: !!g.allow_media,
    }));

  const listIds = list.map((a) => a.id);
  const [{ data: outbox }, posters] = await Promise.all([
    listIds.length
      ? supabase.from('wa_outbox').select('announcement_id, chat_jid, status, last_error, send_after').in('announcement_id', listIds).order('send_after')
      : Promise.resolve({ data: [] as OutboxRow[] }),
    (async () => {
      const paths = list.map((a) => a.poster_path).filter(Boolean) as string[];
      if (!paths.length) return new Map<string, string>();
      const { data } = await supabase.storage.from('dv-posters').createSignedUrls(paths, 3600);
      return new Map((data ?? []).filter((d) => d.signedUrl).map((d) => [d.path as string, d.signedUrl]));
    })(),
  ]);
  const sendsOf = (id: string) => ((outbox ?? []) as OutboxRow[]).filter((o) => o.announcement_id === id);
  const targetsOf = (id: string) => ((targets ?? []) as Target[]).filter((t) => t.announcement_id === id);
  const introTalk =
    intro && /^[0-9a-f-]{36}$/i.test(intro)
      ? ((await supabase.from('dv_intro_talks').select('*').eq('id', intro).maybeSingle()).data as IntroTalk | null)
      : null;
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
            const sends = sendsOf(a.id);
            const next = sends.find((o) => o.status === 'queued');
            const repeat = repeatLabel(a);
            return (
              <Card key={a.id} className="p-5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{a.title}</p>
                    <p className="text-xs text-ink-muted">
                      {repeat ? 'From ' : ''}
                      {formatDateTime(a.send_at, settings.default_timezone)} ({relativeTime(a.send_at)}) · by {names.get(a.created_by) ?? 'someone'}
                      {a.decided_by && a.status !== 'pending_approval' ? ` · decided by ${names.get(a.decided_by) ?? 'someone'}` : ''}
                    </p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                {repeat ? (
                  <p className="mt-1 text-xs">
                    <span className="font-medium">↻ {repeat}</span>
                    {sends.length ? (
                      <span className="text-ink-muted">
                        {' '}
                        · {Math.round(sends.filter((o) => o.status === 'sent').length / Math.max(1, targetsOf(a.id).length))} of {a.repeat_count} done
                        {next && open ? ` · next ${formatDateTime(next.send_after, settings.default_timezone)}` : ''}
                      </span>
                    ) : null}
                  </p>
                ) : null}
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
                    const rows = sends.filter((o) => o.chat_jid === groupJid.get(t.group_id));
                    const sent = rows.filter((o) => o.status === 'sent').length;
                    const failed = rows.find((o) => o.status === 'failed');
                    const state = !rows.length
                      ? ''
                      : rows.length > 1
                        ? ` · ${sent}/${rows.length} sent`
                        : ` · ${rows[0]!.status === 'queued' ? 'waiting' : rows[0]!.status}`;
                    return (
                      <li key={t.group_id} title={failed?.last_error ?? undefined}>
                        <Badge tone={failed ? 'danger' : rows.length && sent === rows.length ? 'ok' : 'neutral'}>
                          {groupName.get(t.group_id) ?? 'Group'}
                          {state}
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
          <CardHeader
            title={introTalk ? 'Announce intro talk' : 'New announcement'}
            description={
              introTalk
                ? 'The message is written for you: check it, pick the groups and when to send.'
                : 'Sent to the chosen groups at the time you pick, after a second person approves it.'
            }
          />
          <NewAnnouncement
            key={introTalk?.id ?? 'new'}
            groups={options}
            defaultSendAt={defaultSendAt}
            initialTitle={introTalk ? `Intro talk: ${introTalk.name}` : ''}
            initialBody={introTalk ? introTalkMessage(introTalk, settings.default_timezone) : ''}
          />
        </Card>
      </section>
    </div>
  );
}
