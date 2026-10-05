import type { Metadata } from 'next';
import { Alert, PageHeader } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireFeature } from '@/lib/features';
import { getCourses, getTeams, getVisibleProfiles } from '@/lib/data';
import { Importer } from './importer';

export const metadata: Metadata = { title: 'Import leads' };

export default async function ImportLeadsPage() {
  const profile = await requireFeature('import_leads');
  const [courses, teams, profiles, settings] = await Promise.all([getCourses(), getTeams(), getVisibleProfiles(), getOrgSettings()]);
  const volunteers = profiles
    .filter((p) => p.role === 'volunteer' && p.status === 'active')
    .map((p) => ({ id: p.id, name: p.full_name || p.email || 'Volunteer', teamId: p.team_id }));
  const fixedTeamId = profile.role === 'super_admin' ? null : profile.team_id;

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
