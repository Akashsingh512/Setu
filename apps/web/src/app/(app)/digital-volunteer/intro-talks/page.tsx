import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, ButtonLink, Card, CardHeader, EmptyState } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { formatDateTime, relativeTime, toLocalInputValue } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { DeleteIntroTalkButton, IntroTalkForm } from './controls';
import type { IntroTalk } from './message';

export const metadata: Metadata = { title: 'Intro talks' };

export default async function IntroTalksPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  await requireDv('schedule_announcements');
  const [{ edit }, settings, supabase] = await Promise.all([searchParams, getOrgSettings(), createClient()]);
  const { data } = await supabase.from('dv_intro_talks').select('*').order('starts_at', { ascending: false }).limit(100);
  const talks = (data ?? []) as IntroTalk[];
  // eslint-disable-next-line react-hooks/purity -- server component: rendered once per request
  const now = Date.now();
  const upcoming = talks.filter((t) => new Date(t.starts_at).getTime() >= now).reverse();
  const past = talks.filter((t) => new Date(t.starts_at).getTime() < now);
  const editing = edit ? talks.find((t) => t.id === edit) : undefined;

  const row = (t: IntroTalk, isPast: boolean) => (
    <li key={t.id}>
      <Card className="p-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium">{t.name}</p>
            <p className="text-ink-muted">
              {formatDateTime(t.starts_at, settings.default_timezone)} ({relativeTime(t.starts_at, now)})
            </p>
          </div>
          {isPast ? <Badge>Past</Badge> : <Badge tone="info">Upcoming</Badge>}
        </div>
        <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1">
          <dt className="text-ink-muted">Location</dt>
          <dd>{t.location}</dd>
          {t.organised_by ? (
            <>
              <dt className="text-ink-muted">Organised by</dt>
              <dd>{t.organised_by}</dd>
            </>
          ) : null}
          {t.location_url ? (
            <>
              <dt className="text-ink-muted">Map</dt>
              <dd className="truncate">
                <a href={t.location_url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                  {t.location_url}
                </a>
              </dd>
            </>
          ) : null}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {!isPast ? <ButtonLink href={`/digital-volunteer/announcements?intro=${t.id}`}>Announce in groups</ButtonLink> : null}
          <ButtonLink href={`/digital-volunteer/intro-talks?edit=${t.id}`} variant="secondary">
            Edit
          </ButtonLink>
          <DeleteIntroTalkButton id={t.id} name={t.name} />
        </div>
      </Card>
    </li>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
      <div className="space-y-6">
        <section aria-labelledby="it-up" className="space-y-3">
          <h2 id="it-up" className="font-semibold">
            Upcoming intro talks
          </h2>
          {upcoming.length ? (
            <ul className="space-y-3">{upcoming.map((t) => row(t, false))}</ul>
          ) : (
            <Card>
              <EmptyState title="No upcoming intro talks" description="Add one on the right, then announce it in your WhatsApp groups." />
            </Card>
          )}
        </section>
        {past.length ? (
          <section aria-labelledby="it-past" className="space-y-3">
            <h2 id="it-past" className="font-semibold text-ink-muted">
              Past
            </h2>
            <ul className="space-y-3">{past.slice(0, 20).map((t) => row(t, true))}</ul>
          </section>
        ) : null}
      </div>

      <section>
        <Card>
          <CardHeader
            title={editing ? 'Edit intro talk' : 'New intro talk'}
            description={editing ? undefined : 'Saved here first. Then use "Announce in groups" to send it on WhatsApp.'}
          />
          <IntroTalkForm
            key={editing?.id ?? 'new'}
            talk={{
              id: editing?.id ?? '',
              name: editing?.name ?? '',
              location: editing?.location ?? '',
              startsAtLocal: editing ? toLocalInputValue(new Date(editing.starts_at), settings.default_timezone) : '',
              organised_by: editing?.organised_by ?? '',
              location_url: editing?.location_url ?? '',
            }}
          />
          {editing ? null : (
            <p className="border-t border-line px-5 py-3 text-xs text-ink-muted">
              Groups can receive it only when{' '}
              <Link href="/digital-volunteer/groups" className="underline">
                Scheduled announcements
              </Link>{' '}
              is ticked for them.
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
