import type { Metadata } from 'next';
import { formatSessionSchedule, isStaff, SESSION_MODE_LABELS } from '@crm/shared';
import { Badge, Card, EmptyState, Input, PageHeader, Select } from '@/components/ui';
import { getOrgSettings, requireProfile } from '@/lib/auth';
import { getCourses, getTeams } from '@/lib/data';
import { createClient } from '@/lib/supabase/server';
import type { UpcomingSession } from '@/lib/types';
import { CancelSessionButton, SessionForm } from './session-form';

export const metadata: Metadata = { title: 'Upcoming Programs' };

export default async function UpcomingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const supabase = await createClient();
  const [profile, settings, sp] = await Promise.all([requireProfile(), getOrgSettings(), searchParams]);
  const staff = isStaff(profile.role);

  let query = supabase.from('upcoming_sessions').select('*').order('starts_at');
  if (sp.mode) query = query.eq('mode', sp.mode);
  if (sp.category) query = query.eq('course_category', sp.category);
  const [{ data, error }, courses, teams] = await Promise.all([query, getCourses(), staff ? getTeams() : Promise.resolve([])]);
  let sessions = (data ?? []) as UpcomingSession[];
  if (sp.q) {
    const needle = sp.q.toLowerCase();
    sessions = sessions.filter((s) => s.display_title.toLowerCase().includes(needle) || s.course_name.toLowerCase().includes(needle) || (s.city ?? '').toLowerCase().includes(needle));
  }
  const categories = [...new Set(courses.map((c) => c.category).filter(Boolean))] as string[];

  return (
    <>
      <PageHeader title="Upcoming Programs" description="Scheduled sessions. Past and cancelled sessions are hidden automatically." />
      {staff ? (
        <div className="mb-6">
          <SessionForm courses={courses} teams={teams} lockedTeamId={profile.role === 'teacher' ? profile.team_id : null} defaultTimeZone={settings.default_timezone} />
        </div>
      ) : null}

      <form className="mb-4 grid gap-2 sm:grid-cols-4" role="search">
        <Input name="q" defaultValue={sp.q} placeholder="Search course or city" aria-label="Search" className="sm:col-span-2" />
        <Select name="mode" defaultValue={sp.mode ?? ''} aria-label="Format">
          <option value="">Any format</option>
          <option value="in_person">In person</option>
          <option value="online">Online</option>
          <option value="hybrid">Hybrid</option>
        </Select>
        <div className="flex gap-2">
          <Select name="category" defaultValue={sp.category ?? ''} aria-label="Category">
            <option value="">Any category</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <button className="min-h-10 rounded-lg bg-ink px-4 text-sm font-medium text-on-ink" type="submit">
            Go
          </button>
        </div>
      </form>

      {error ? (
        <Card className="p-5 text-sm text-danger">Could not load sessions: {error.message}</Card>
      ) : sessions.length === 0 ? (
        <Card>
          <EmptyState title="No upcoming programs" description={staff ? 'Publish a session above.' : 'Check back soon.'} />
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {sessions.map((s) => {
            const running = new Date(s.starts_at) <= new Date();
            return (
              <li key={s.id}>
                <Card className="flex h-full flex-col gap-2 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold">{s.display_title}</h2>
                    <div className="flex gap-1">
                      <Badge tone="info">{SESSION_MODE_LABELS[s.mode]}</Badge>
                      {running ? <Badge tone="ok">In progress</Badge> : null}
                    </div>
                  </div>
                  <p className="text-sm font-medium">{formatSessionSchedule(s, 'en-IN', settings.default_timezone)}</p>
                  {s.display_description ? <p className="text-sm text-ink-muted">{s.display_description}</p> : null}
                  <p className="text-sm text-ink-muted">
                    {[s.venue, s.city].filter(Boolean).join(', ')}
                    {s.instructor_name ? ` · ${s.instructor_name}` : ''}
                  </p>
                  {s.instructions ? <p className="text-sm">{s.instructions}</p> : null}
                  <div className="mt-auto flex flex-wrap gap-3 pt-2 text-sm">
                    {s.effective_registration_url ? (
                      <a href={s.effective_registration_url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">
                        Registration link
                      </a>
                    ) : null}
                    {s.meeting_url ? (
                      <a href={s.meeting_url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                        Meeting link
                      </a>
                    ) : null}
                    {staff ? (
                      <span className="ml-auto flex gap-4">
                        <SessionForm
                          session={s}
                          courses={courses}
                          teams={teams}
                          lockedTeamId={profile.role === 'teacher' ? profile.team_id : null}
                          defaultTimeZone={settings.default_timezone}
                        />
                        <CancelSessionButton sessionId={s.id} />
                      </span>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
