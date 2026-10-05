import type { Metadata } from 'next';
import { Alert, PageHeader } from '@/components/ui';
import { requireFeature, hasFeature } from '@/lib/features';
import { getCourses, getTeams, getVisibleProfiles } from '@/lib/data';
import { createLead, volunteerCreateLead } from '../actions';
import { LeadForm } from '../lead-form';

export const metadata: Metadata = { title: 'Add lead' };

export default async function NewLeadPage() {
  const profile = await requireFeature('add_leads');

  // Without the team's leads, people add leads the volunteer way (to their team, optionally to themselves).
  if (profile.role === 'volunteer' && !(await hasFeature('team_leads'))) {
    const courses = await getCourses();
    return (
      <>
        <PageHeader title="Add a lead" description="Someone you met who is interested. Fields marked * are required." />
        <OfflineHint />
        {profile.team_id ? (
          <LeadForm action={volunteerCreateLead} courses={courses} teams={[]} fixedTeamId={profile.team_id} volunteerMode />
        ) : (
          <Alert tone="warn">You are not in a team yet. Ask your teacher to add you to one, then you can add leads.</Alert>
        )}
      </>
    );
  }

  const [courses, teams, profiles] = await Promise.all([getCourses(), getTeams(), getVisibleProfiles()]);
  const volunteers = profiles
    .filter((p) => p.role === 'volunteer' && p.status === 'active')
    .map((p) => ({ id: p.id, name: p.full_name || p.email || 'Volunteer' }));

  return (
    <>
      <PageHeader title="Add lead" description="Fields marked * are required." />
      <OfflineHint />
      {teams.length === 0 ? (
        <Alert tone="warn">Create a team first (Users page) before adding leads.</Alert>
      ) : (
        <LeadForm
          action={createLead}
          courses={courses}
          teams={teams}
          fixedTeamId={profile.role === 'super_admin' ? null : profile.team_id}
          volunteers={volunteers}
        />
      )}
    </>
  );
}

function OfflineHint() {
  return (
    <p className="-mt-4 mb-4 text-sm text-ink-muted">
      Weak or no signal where you are?{' '}
      <a href="/capture" className="text-accent underline">
        Use offline add
      </a>
      : leads are saved on your phone and sent when you are back online.
    </p>
  );
}
