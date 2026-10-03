import type { Metadata } from 'next';
import { Alert, PageHeader } from '@/components/ui';
import { getOrgSettings, requireStaff } from '@/lib/auth';
import { getCourses, getTeams, getVisibleProfiles } from '@/lib/data';
import { Importer } from './importer';

export const metadata: Metadata = { title: 'Import leads' };

export default async function ImportLeadsPage() {
  const profile = await requireStaff();
  const [courses, teams, profiles, settings] = await Promise.all([getCourses(), getTeams(), getVisibleProfiles(), getOrgSettings()]);
  const volunteers = profiles
    .filter((p) => p.role === 'volunteer' && p.status === 'active')
    .map((p) => ({ id: p.id, name: p.full_name || p.email || 'Volunteer', teamId: p.team_id }));
  const fixedTeamId = profile.role === 'teacher' ? profile.team_id : null;

  return (
    <>
      <PageHeader title="Import leads" description="Upload many leads at once from an Excel or CSV file." />
      {teams.length === 0 || (profile.role === 'teacher' && !fixedTeamId) ? (
        <Alert tone="warn">You need to belong to a team before importing leads. Ask a super admin to set this up on the Users page.</Alert>
      ) : (
        <Importer
          courses={courses.map((c) => ({ id: c.id, name: c.name }))}
          teams={teams.map((t) => ({ id: t.id, name: t.name }))}
          fixedTeamId={fixedTeamId}
          volunteers={volunteers}
          defaultCountry={settings.default_phone_country}
        />
      )}
    </>
  );
}
