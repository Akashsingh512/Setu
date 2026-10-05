import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatPhone, ROLE_LABELS, SEVA_DAY_LABELS, SEVA_DAYS, SEVA_TIME_LABELS, SEVA_TIMES, telUrl, whatsAppUrl } from '@crm/shared';
import { Alert, Badge, Card, cn, PageHeader } from '@/components/ui';
import { requireFeature } from '@/lib/features';
import { hasSevaProfile, loadDirectory } from '../data';

export const metadata: Metadata = { title: 'Sevak' };

export default async function SevakPage({ params }: { params: Promise<{ id: string }> }) {
  const [profile, { id }] = await Promise.all([requireFeature('sevak_directory'), params]);
  const all = await loadDirectory();
  if (!all) return <Alert>Could not load the directory. Run the latest database migration.</Alert>;
  const m = all.find((x) => x.id === id);
  if (!m) notFound();
  const me = m.id === profile.id;

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/directory" className="text-ink-muted hover:text-ink">
          ← Sevak Directory
        </Link>
      </div>
      <PageHeader
        title={m.full_name || 'Member'}
        description={`${ROLE_LABELS[m.role]}${m.team_name ? ` · ${m.team_name}` : ''}`}
        actions={me ? <Badge tone="accent">You</Badge> : undefined}
      />

      <div className="grid max-w-4xl gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Seva interests</h2>
            {m.seva_interests.length ? (
              <ul className="flex flex-wrap gap-2">
                {m.seva_interests.map((i) => (
                  <li key={i}>
                    <Badge tone="accent" className="px-3 py-1 text-sm">
                      {i}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Not filled in yet.</p>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Available for seva</h2>
            <div className="flex flex-col gap-4 text-sm">
              <div>
                <p className="mb-2 text-xs font-medium text-ink-muted">Days</p>
                <ul className="flex flex-wrap gap-1.5">
                  {SEVA_DAYS.map((d) => {
                    const on = m.seva_days.includes(d);
                    return (
                      <li key={d}>
                        <span
                          className={cn(
                            'inline-flex rounded-md border px-2.5 py-1',
                            on ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-muted line-through',
                          )}
                          aria-label={`${SEVA_DAY_LABELS[d]}: ${on ? 'available' : 'not available'}`}
                        >
                          {SEVA_DAY_LABELS[d]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-ink-muted">Time of day</p>
                <p>
                  {m.seva_times.length
                    ? SEVA_TIMES.filter((t) => m.seva_times.includes(t))
                        .map((t) => SEVA_TIME_LABELS[t])
                        .join(', ')
                    : 'Any time'}
                </p>
              </div>
              {m.seva_note ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-muted">Note</p>
                  <p className="whitespace-pre-wrap">{m.seva_note}</p>
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card className="p-5 text-sm">
            <h2 className="mb-3 font-semibold">Where</h2>
            <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-2">
              <dt className="text-ink-muted">Centre</dt>
              <dd>{m.nearest_centre || '—'}</dd>
              <dt className="text-ink-muted">Area</dt>
              <dd className="whitespace-pre-wrap">{m.address || '—'}</dd>
              <dt className="text-ink-muted">Team</dt>
              <dd>{m.team_name || '—'}</dd>
            </dl>
          </Card>

          <Card className="p-5 text-sm">
            <h2 className="mb-3 font-semibold">Contact</h2>
            {m.phone ? (
              <>
                <p className="mb-3 tabular-nums">{formatPhone(m.phone)}</p>
                {me ? (
                  <p className="text-xs text-ink-muted">
                    Others see your number only if you chose to show it in your{' '}
                    <Link href="/profile" className="underline">
                      seva profile
                    </Link>
                    .
                  </p>
                ) : (
                  <div className="flex gap-2">
                    <a
                      href={telUrl(m.phone)}
                      className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover"
                    >
                      Call
                    </a>
                    <a
                      href={whatsAppUrl(m.phone, `Jai Gurudev ${m.full_name.split(' ')[0] ?? ''}, `.trim())}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-whatsapp px-4 font-medium text-white hover:bg-whatsapp-hover"
                    >
                      WhatsApp
                    </a>
                  </div>
                )}
              </>
            ) : (
              <p className="text-ink-muted">
                {me ? (
                  <>
                    Add your phone and choose to show it in your{' '}
                    <Link href="/profile" className="underline">
                      seva profile
                    </Link>
                    .
                  </>
                ) : (
                  'This member has not shared a phone number.'
                )}
              </p>
            )}
          </Card>

          {me && !hasSevaProfile(m) ? (
            <Alert tone="info">
              Your seva profile is empty.{' '}
              <Link href="/profile" className="underline">
                Fill it in
              </Link>{' '}
              so others know how you can help.
            </Alert>
          ) : null}
        </div>
      </div>
    </>
  );
}
