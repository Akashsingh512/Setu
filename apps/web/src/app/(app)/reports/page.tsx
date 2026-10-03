import type { Metadata } from 'next';
import Link from 'next/link';
import { CALL_OUTCOME_LABELS, type CallOutcome } from '@crm/shared';
import { Alert, Card, CardHeader, cn, EmptyState, Input, PageHeader, Select, Stat } from '@/components/ui';
import { getOrgSettings, requireStaff } from '@/lib/auth';
import { getCourses, getStatuses, getTeams, getVisibleProfiles } from '@/lib/data';
import { localInputToIso } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { CsvButton, DailyChart, type DailyPoint } from './charts';

export const metadata: Metadata = { title: 'Reports' };

interface VolunteerRow {
  volunteer_id: string;
  name: string;
  role: string | null;
  assigned: number;
  on_time: number;
  late: number;
  missed: number;
  pending: number;
  auto_reassigned: number;
  attempts: number;
  leads_contacted: number;
  median_hours_to_first_call: number | null;
}

interface Report {
  totals: { leads_created: number; assignments: number; leads_assigned: number; call_attempts: number; leads_contacted: number; registrations: number; overdue_now: number };
  by_volunteer: VolunteerRow[];
  outcomes: Partial<Record<CallOutcome, number>>;
  follow_ups: { due: number; done: number; cancelled: number; open_overdue: number; open_upcoming: number };
  by_course: { course: string; leads: number; interested: number; link_shared: number; registered_now: number; converted: number; registrations_in_range: number }[];
  registrations_by_course: { course: string; registrations: number }[];
  funnel: { status: string; label: string; count: number }[];
  daily: DailyPoint[];
  overdue: { lead_id: string; full_name: string; lead_code: string; assignee: string; hours_overdue: number }[];
}

const PRESETS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

function ymdInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const isYmd = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Single-series horizontal bars with the value as a direct label. */
function HBars({ items, total }: { items: { label: string; value: number }[]; total?: number }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[minmax(7rem,10rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-ink-muted" title={i.label}>
            {i.label}
          </span>
          <span className="h-3 rounded-r-[4px] bg-canvas" aria-hidden>
            <span className="block h-full rounded-r-[4px] bg-accent" style={{ width: i.value ? `${Math.max(1.5, (i.value / max) * 100)}%` : 0 }} />
          </span>
          <span className="w-16 text-right font-medium tabular-nums">
            {i.value}
            {total ? <span className="ml-1 text-xs font-normal text-ink-muted">{pct(i.value, total)}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const [profile, settings, sp] = await Promise.all([requireStaff(), getOrgSettings(), searchParams]);
  const tz = settings.default_timezone;
  const today = ymdInTz(new Date(), tz);
  const to = isYmd(sp.to) ? sp.to : today;
  const from = isYmd(sp.from) ? sp.from : addDays(to, -29);
  const isAdmin = profile.role === 'super_admin';

  const supabase = await createClient();
  const [{ data, error }, teams, profiles, courses, statuses] = await Promise.all([
    supabase.rpc('report_overview', {
      p_from: localInputToIso(`${from}T00:00`, tz),
      p_to: localInputToIso(`${addDays(to, 1)}T00:00`, tz),
      p_team_id: isAdmin ? sp.team || null : null,
      p_volunteer_id: sp.volunteer || null,
      p_course_id: sp.course || null,
      p_status: sp.status || null,
    }),
    isAdmin ? getTeams() : Promise.resolve([]),
    getVisibleProfiles(),
    getCourses(false),
    getStatuses(),
  ]);
  const volunteers = profiles.filter((p) => p.role === 'volunteer' && p.approval_status !== 'pending');
  const r = data as Report | null;

  const presetHref = (days: number) => {
    const p = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== 'from' && k !== 'to') as [string, string][]);
    p.set('from', addDays(today, -(days - 1)));
    p.set('to', today);
    return `/reports?${p.toString()}`;
  };
  const activePreset = to === today ? PRESETS.find((p) => addDays(today, -(p.days - 1)) === from)?.days : undefined;

  return (
    <>
      <PageHeader
        title="Reports"
        description={isAdmin ? 'Organisation-wide activity. Use filters to narrow by team, volunteer or course.' : 'Your team’s activity.'}
      />

      {/* Filters: one row above everything they scope. */}
      <div className="mb-3 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Link
            key={p.days}
            href={presetHref(p.days)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm',
              activePreset === p.days ? 'border-ink bg-ink font-medium text-on-ink' : 'border-line-strong bg-surface hover:bg-canvas',
            )}
          >
            {p.label}
          </Link>
        ))}
      </div>
      <form className="mb-6 grid gap-2 sm:grid-cols-3 lg:grid-cols-7" aria-label="Report filters">
        <Input type="date" name="from" defaultValue={from} max={today} aria-label="From date" />
        <Input type="date" name="to" defaultValue={to} max={today} aria-label="To date" />
        {isAdmin ? (
          <Select name="team" defaultValue={sp.team ?? ''} aria-label="Team">
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select name="volunteer" defaultValue={sp.volunteer ?? ''} aria-label="Volunteer">
          <option value="">All volunteers</option>
          {volunteers.map((v) => (
            <option key={v.id} value={v.id}>
              {v.full_name || v.email}
            </option>
          ))}
        </Select>
        <Select name="course" defaultValue={sp.course ?? ''} aria-label="Course">
          <option value="">All courses</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select name="status" defaultValue={sp.status ?? ''} aria-label="Lead status">
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <button type="submit" className="min-h-10 flex-1 rounded-lg bg-ink px-4 text-sm font-medium text-on-ink">
            Apply
          </button>
          <Link href="/reports" className="flex min-h-10 items-center px-2 text-sm text-ink-muted hover:text-ink">
            Reset
          </Link>
        </div>
      </form>

      {error || !r ? (
        <Alert>
          {/function .*report_overview|Could not find the function/i.test(error?.message ?? '')
            ? 'Reports need the latest database migration (20261003000200_reports.sql). Run it in the Supabase SQL Editor, then reload.'
            : `Could not load reports: ${error?.message ?? 'unknown error'}`}
        </Alert>
      ) : (
        <ReportBody r={r} />
      )}
    </>
  );
}

function ReportBody({ r }: { r: Report }) {
  const t = r.totals;
  const vols = r.by_volunteer;
  const fu = r.follow_ups;
  const outcomes = (Object.keys(CALL_OUTCOME_LABELS) as CallOutcome[]).map((o) => ({ label: CALL_OUTCOME_LABELS[o], value: r.outcomes[o] ?? 0 }));
  const firstCallDecided = vols.reduce((s, v) => s + v.on_time + v.late + v.missed, 0);
  const onTimeAll = vols.reduce((s, v) => s + v.on_time, 0);

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Leads created" value={t.leads_created} />
        <Stat label="Leads assigned" value={t.leads_assigned} />
        <Stat label="Call attempts" value={t.call_attempts} />
        <Stat label="Unique leads contacted" value={t.leads_contacted} />
        <Stat label="Registrations" value={t.registrations} tone="ok" />
        <Stat label="Overdue right now" value={t.overdue_now} tone={t.overdue_now ? 'danger' : undefined} href="/leads?view=overdue" />
      </section>
      <p className="-mt-3 text-xs text-ink-muted">
        {t.assignments} assignment(s) were made in this range, including reassignments. Calls within the deadline:{' '}
        <span className="font-medium text-ink">{pct(onTimeAll, firstCallDecided)}</span> of assignments whose deadline has been decided.
      </p>

      <Card className="p-5">
        <h2 className="mb-4 text-base font-semibold">Daily activity</h2>
        <DailyChart data={r.daily} />
      </Card>

      <Card>
        <CardHeader
          title="Volunteer performance"
          description="First call measured against each assignment's contact deadline."
          action={
            <CsvButton
              filename="volunteer-performance.csv"
              entity="report.volunteers"
              rows={vols.map((v) => ({
                volunteer: v.name,
                leads_assigned: v.assigned,
                called_on_time: v.on_time,
                called_late: v.late,
                not_called: v.missed,
                waiting: v.pending,
                auto_reassigned: v.auto_reassigned,
                call_attempts: v.attempts,
                unique_leads_contacted: v.leads_contacted,
                median_hours_to_first_call: v.median_hours_to_first_call,
              }))}
            />
          }
        />
        {vols.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm tabular-nums">
              <thead className="border-b border-line text-left text-ink-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Volunteer</th>
                  <th className="px-2 py-3 text-right font-medium">Assigned</th>
                  <th className="px-2 py-3 text-right font-medium">On time</th>
                  <th className="px-2 py-3 text-right font-medium">Late</th>
                  <th className="px-2 py-3 text-right font-medium">Not called</th>
                  <th className="px-2 py-3 text-right font-medium">Waiting</th>
                  <th className="px-2 py-3 text-right font-medium">Auto-reassigned</th>
                  <th className="px-2 py-3 text-right font-medium">Attempts</th>
                  <th className="px-2 py-3 text-right font-medium">Leads contacted</th>
                  <th className="px-5 py-3 text-right font-medium">Median to 1st call</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {vols.map((v) => {
                  const decided = v.on_time + v.late + v.missed;
                  return (
                    <tr key={v.volunteer_id}>
                      <td className="px-5 py-3">
                        <Link href={`/reports?volunteer=${v.volunteer_id}`} className="font-medium hover:underline">
                          {v.name}
                        </Link>
                        {v.role && v.role !== 'volunteer' ? <span className="ml-1 text-xs text-ink-muted">(staff)</span> : null}
                      </td>
                      <td className="px-2 py-3 text-right">{v.assigned}</td>
                      <td className="px-2 py-3 text-right">
                        {v.on_time} <span className="text-xs text-ink-muted">{pct(v.on_time, decided)}</span>
                      </td>
                      <td className="px-2 py-3 text-right">{v.late}</td>
                      <td className={cn('px-2 py-3 text-right', v.missed > 0 && 'font-medium text-danger')}>{v.missed}</td>
                      <td className="px-2 py-3 text-right">{v.pending}</td>
                      <td className="px-2 py-3 text-right">{v.auto_reassigned}</td>
                      <td className="px-2 py-3 text-right">{v.attempts}</td>
                      <td className="px-2 py-3 text-right">{v.leads_contacted}</td>
                      <td className="px-5 py-3 text-right">{v.median_hours_to_first_call === null ? '—' : `${v.median_hours_to_first_call} h`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No assignments or calls in this range" />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-1 text-base font-semibold">Call outcomes</h2>
          <p className="mb-4 text-sm text-ink-muted">{t.call_attempts} attempt(s) across {t.leads_contacted} lead(s)</p>
          {t.call_attempts ? <HBars items={outcomes} total={t.call_attempts} /> : <p className="text-sm text-ink-muted">No calls recorded.</p>}
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-base font-semibold">Follow-up completion</h2>
          <p className="mb-4 text-sm text-ink-muted">Follow-ups due in this range</p>
          {fu.due ? (
            <>
              <p className="mb-4">
                <span className="text-3xl font-semibold tabular-nums">{pct(fu.done, fu.due)}</span>{' '}
                <span className="text-sm text-ink-muted">completed</span>
              </p>
              <HBars
                total={fu.due}
                items={[
                  { label: 'Done', value: fu.done },
                  { label: 'Open, overdue', value: fu.open_overdue },
                  { label: 'Open, upcoming', value: fu.open_upcoming },
                  { label: 'Cancelled', value: fu.cancelled },
                ]}
              />
            </>
          ) : (
            <p className="text-sm text-ink-muted">No follow-ups due in this range.</p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-base font-semibold">Registrations by course</h2>
          <p className="mb-4 text-sm text-ink-muted">Leads whose status changed to Registered in this range.</p>
          {r.registrations_by_course.length ? (
            <HBars items={r.registrations_by_course.map((c) => ({ label: c.course, value: c.registrations }))} />
          ) : (
            <p className="text-sm text-ink-muted">No registrations in this range.</p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-base font-semibold">Lead status</h2>
          <p className="mb-4 text-sm text-ink-muted">Current status of the {t.leads_created} lead(s) created in this range.</p>
          {t.leads_created ? (
            <HBars total={t.leads_created} items={r.funnel.map((s) => ({ label: s.label, value: s.count }))} />
          ) : (
            <p className="text-sm text-ink-muted">No leads created in this range.</p>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Courses" description="Leads created in this range, by course of interest and current status." />
        {r.by_course.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm tabular-nums">
              <thead className="border-b border-line text-left text-ink-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Course</th>
                  <th className="px-2 py-3 text-right font-medium">Leads</th>
                  <th className="px-2 py-3 text-right font-medium">Interested</th>
                  <th className="px-2 py-3 text-right font-medium">Link shared</th>
                  <th className="px-2 py-3 text-right font-medium">Registered</th>
                  <th className="px-5 py-3 text-right font-medium">Attended</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.by_course.map((c) => (
                  <tr key={c.course}>
                    <td className="px-5 py-3 font-medium">{c.course}</td>
                    <td className="px-2 py-3 text-right">{c.leads}</td>
                    <td className="px-2 py-3 text-right">{c.interested}</td>
                    <td className="px-2 py-3 text-right">{c.link_shared}</td>
                    <td className="px-2 py-3 text-right">{c.registered_now}</td>
                    <td className="px-5 py-3 text-right">{c.converted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No leads created in this range" />
        )}
      </Card>

      <Card>
        <CardHeader title="Overdue right now" description="Open assignments past their contact deadline with no call recorded. These will be reassigned automatically." />
        {r.overdue.length ? (
          <ul className="divide-y divide-line text-sm">
            {r.overdue.map((o) => (
              <li key={o.lead_id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
                <span>
                  <Link href={`/leads/${o.lead_id}`} className="font-medium hover:underline">
                    {o.full_name}
                  </Link>{' '}
                  <span className="text-ink-muted">
                    {o.lead_code} · {o.assignee}
                  </span>
                </span>
                <span className="font-medium text-danger tabular-nums">{o.hours_overdue} h overdue</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing overdue" description="Every assigned lead has been called within its deadline." />
        )}
      </Card>

      <p className="text-xs text-ink-muted">
        Registrations are reported by course, not credited to volunteers: the CRM records who called a lead, not what led them to register.
      </p>
    </div>
  );
}
