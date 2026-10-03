import type { Metadata } from 'next';
import Link from 'next/link';
import { ROLE_LABELS, SEVA_DAY_LABELS, SEVA_DAYS, SEVA_TIME_LABELS, SEVA_TIMES, type Role, type SevaDay, type SevaTime } from '@crm/shared';
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, Input, PageHeader, Select } from '@/components/ui';
import { requireProfile } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Sevak Directory' };

type Member = {
  id: string;
  full_name: string;
  role: Role;
  team_name: string | null;
  seva_days: SevaDay[];
  seva_times: SevaTime[];
  seva_note: string | null;
  nearest_centre: string | null;
  address: string | null;
  seva_interests: string[];
};

const hasSevaProfile = (m: Pick<Member, 'seva_days' | 'seva_interests' | 'nearest_centre'>) =>
  m.seva_days.length > 0 || m.seva_interests.length > 0 || !!m.nearest_centre;

export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const [profile, params, supabase] = await Promise.all([requireProfile(), searchParams, createClient()]);
  const { data, error } = await supabase.rpc('member_directory');
  if (error) return <Alert>Could not load the directory. Run the latest database migration.</Alert>;
  const all = (data ?? []) as Member[];

  const q = params.q?.trim().toLowerCase() ?? '';
  const interest = params.interest ?? '';
  const day = (SEVA_DAYS as readonly string[]).includes(params.day ?? '') ? (params.day as SevaDay) : '';
  const time = (SEVA_TIMES as readonly string[]).includes(params.time ?? '') ? (params.time as SevaTime) : '';
  const centre = params.centre ?? '';
  const onlyFilled = params.all !== '1';

  const interests = [...new Set(all.flatMap((m) => m.seva_interests))].sort();
  const centres = [...new Set(all.map((m) => m.nearest_centre).filter(Boolean) as string[])].sort();
  const members = all.filter(
    (m) =>
      (!onlyFilled || hasSevaProfile(m)) &&
      (!q || [m.full_name, m.nearest_centre, m.address, m.team_name, m.seva_note].some((v) => v?.toLowerCase().includes(q))) &&
      (!interest || m.seva_interests.includes(interest)) &&
      (!day || m.seva_days.includes(day)) &&
      (!time || m.seva_times.includes(time)) &&
      (!centre || m.nearest_centre === centre),
  );
  const me = all.find((m) => m.id === profile.id);
  const filtered = !!(q || interest || day || time || centre);

  return (
    <>
      <PageHeader
        title="Sevak Directory"
        description="Who can help, when, and with what. Everyone fills in their own seva profile."
        actions={<ButtonLink href="/profile" variant="secondary">Edit my seva profile</ButtonLink>}
      />

      {me && !hasSevaProfile(me) ? (
        <div className="mb-4">
          <Alert tone="info">
            You haven&apos;t filled in your seva profile yet.{' '}
            <Link href="/profile" className="underline">
              Add your availability and interests
            </Link>{' '}
            so others know how you can help.
          </Alert>
        </div>
      ) : null}

      <form method="get" className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_repeat(4,10rem)_auto]">
        {onlyFilled ? null : <input type="hidden" name="all" value="1" />}
        <label htmlFor="d-q" className="sr-only">
          Search
        </label>
        <Input id="d-q" name="q" defaultValue={params.q ?? ''} placeholder="Search name, centre, area…" />
        <label htmlFor="d-interest" className="sr-only">
          Seva interest
        </label>
        <Select id="d-interest" name="interest" defaultValue={interest}>
          <option value="">Any seva</option>
          {interests.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
        <label htmlFor="d-centre" className="sr-only">
          Centre
        </label>
        <Select id="d-centre" name="centre" defaultValue={centre}>
          <option value="">Any centre</option>
          {centres.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <label htmlFor="d-day" className="sr-only">
          Day
        </label>
        <Select id="d-day" name="day" defaultValue={day}>
          <option value="">Any day</option>
          {SEVA_DAYS.map((d) => (
            <option key={d} value={d}>
              {SEVA_DAY_LABELS[d]}
            </option>
          ))}
        </Select>
        <label htmlFor="d-time" className="sr-only">
          Time of day
        </label>
        <Select id="d-time" name="time" defaultValue={time}>
          <option value="">Any time</option>
          {SEVA_TIMES.map((t) => (
            <option key={t} value={t}>
              {SEVA_TIME_LABELS[t]}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Button type="submit">Filter</Button>
          {filtered ? (
            <ButtonLink href="/directory" variant="ghost">
              Clear
            </ButtonLink>
          ) : null}
        </div>
      </form>

      <p className="mb-3 text-sm text-ink-muted">
        {members.length} {members.length === 1 ? 'person' : 'people'}
        {onlyFilled ? (
          <>
            {' '}
            with a seva profile ·{' '}
            <Link href={{ query: { ...params, all: '1' } }} className="underline">
              show everyone
            </Link>
          </>
        ) : null}
      </p>

      {members.length === 0 ? (
        <Card>
          <EmptyState title="Nobody matches" description={filtered ? 'Try fewer filters.' : 'Nobody has filled in a seva profile yet.'} />
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {members.map((m) => (
            <li key={m.id}>
              <Card className="h-full p-4 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.full_name || 'Member'}</p>
                    <p className="text-xs text-ink-muted">
                      {ROLE_LABELS[m.role]}
                      {m.team_name ? ` · ${m.team_name}` : ''}
                    </p>
                  </div>
                  {m.id === profile.id ? <Badge tone="accent">You</Badge> : null}
                </div>
                <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1.5">
                  {m.seva_days.length || m.seva_times.length ? (
                    <>
                      <dt className="text-ink-muted">Available</dt>
                      <dd>
                        {SEVA_DAYS.filter((d) => m.seva_days.includes(d))
                          .map((d) => SEVA_DAY_LABELS[d])
                          .join(', ') || 'Any day'}
                        {m.seva_times.length
                          ? ` · ${SEVA_TIMES.filter((t) => m.seva_times.includes(t))
                              .map((t) => SEVA_TIME_LABELS[t].toLowerCase())
                              .join(', ')}`
                          : ''}
                        {m.seva_note ? <span className="block text-ink-muted">{m.seva_note}</span> : null}
                      </dd>
                    </>
                  ) : null}
                  {m.nearest_centre ? (
                    <>
                      <dt className="text-ink-muted">Centre</dt>
                      <dd>{m.nearest_centre}</dd>
                    </>
                  ) : null}
                  {m.address ? (
                    <>
                      <dt className="text-ink-muted">Area</dt>
                      <dd className="whitespace-pre-wrap">{m.address}</dd>
                    </>
                  ) : null}
                </dl>
                {m.seva_interests.length ? (
                  <ul className="mt-3 flex flex-wrap gap-1">
                    {m.seva_interests.map((i) => (
                      <li key={i}>
                        <Badge>{i}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
