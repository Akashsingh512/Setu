import type { Metadata } from 'next';
import { Alert, PageHeader } from '@/components/ui';
import { requireStaff } from '@/lib/auth';
import { getCourses, getTeams, getVisibleProfiles } from '@/lib/data';
import { createLead } from '../actions';
import { LeadForm } from '../lead-form';

export const metadata: Metadata = { title: 'Add lead' };

export default async function NewLeadPage() {
  const profile = await requireStaff();
  const [courses, teams, profiles] = await Promise.all([getCourses(), getTeams(), getVisibleProfiles()]);
  const volunteers = profiles
    .filter((p) => p.role === 'volunteer' && p.status === 'active')
    .map((p) => ({ id: p.id, name: p.full_name || p.email || 'Volunteer' }));

  return (
    <>
      <PageHeader title="Add lead" description="Fields marked * are required." />
      {teams.length === 0 ? (
        <Alert tone="warn">Create a team first (Users page) before adding leads.</Alert>
      ) : (
        <LeadForm
          action={createLead}
          courses={courses}
          teams={teams}
          fixedTeamId={profile.role === 'teacher' ? profile.team_id : null}
          volunteers={volunteers}
        />
      )}
    </>
  );
}
