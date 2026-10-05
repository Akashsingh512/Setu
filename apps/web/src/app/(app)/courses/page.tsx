import type { Metadata } from 'next';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { requireProfile } from '@/lib/auth';
import { hasFeature } from '@/lib/features';
import { getCourses, getTeams } from '@/lib/data';
import { CourseEditor } from './course-editor';

export const metadata: Metadata = { title: 'Courses' };

export default async function CoursesPage() {
  const profile = await requireProfile();
  const staff = await hasFeature('manage_courses');
  const [courses, teams] = await Promise.all([getCourses(!staff), staff ? getTeams() : Promise.resolve([])]);
  const canEdit = (c: { team_id: string | null; created_by: string | null }) =>
    profile.role === 'super_admin' || (staff && (c.team_id === profile.team_id || c.created_by === profile.id));

  return (
    <>
      <PageHeader title="Courses & Programs" description="Course details and registration links used in WhatsApp messages." />
      {staff ? (
        <div className="mb-6">
          <CourseEditor teams={teams} lockedTeamId={profile.role === 'super_admin' ? null : profile.team_id} />
        </div>
      ) : null}
      {courses.length === 0 ? (
        <Card>
          <EmptyState title="No courses yet" description={staff ? 'Create the first course above.' : 'Your teachers have not added courses yet.'} />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {courses.map((c) => (
            <Card key={c.id} className="flex flex-col gap-2 p-5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">{c.name}</h2>
                <div className="flex gap-1">
                  {c.category ? <Badge>{c.category}</Badge> : null}
                  {!c.is_active ? <Badge tone="warn">Inactive</Badge> : null}
                </div>
              </div>
              {c.short_description ? <p className="text-sm text-ink-muted">{c.short_description}</p> : null}
              {c.target_audience ? <p className="text-sm"><span className="text-ink-muted">For:</span> {c.target_audience}</p> : null}
              {c.registration_url ? (
                <a href={c.registration_url} target="_blank" rel="noopener noreferrer" className="text-sm break-all text-accent underline">
                  {c.registration_url}
                </a>
              ) : null}
              {canEdit(c) ? (
                <div className="mt-2">
                  <CourseEditor course={c} teams={teams} lockedTeamId={profile.role === 'super_admin' ? null : profile.team_id} />
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
