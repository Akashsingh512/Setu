import type { Metadata } from 'next';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requireStaff } from '@/lib/auth';
import { loadUserRows } from '../users/load';
import { PendingRegistrations } from '../users/pending';
import { CreateUserForm, UserTable } from '../users/user-admin';

export const metadata: Metadata = { title: 'Volunteers' };

export default async function VolunteersPage() {
  const profile = await requireStaff();
  const { rows, pending, teams } = await loadUserRows((role) => role === 'volunteer', profile);
  return (
    <>
      <PageHeader
        title="Volunteers"
        description="Inactive or unavailable volunteers never receive automatic reassignments."
      />
      <PendingRegistrations rows={pending} teams={teams} isSuperAdmin={profile.role === 'super_admin'} />
      <div className="mb-6">
        <CreateUserForm mode="volunteers" teams={teams} myTeamId={profile.role === 'teacher' ? profile.team_id : null} />
      </div>
      {rows.length ? (
        <UserTable rows={rows} mode="volunteers" teams={teams} currentUserId={profile.id} />
      ) : (
        <Card>
          <EmptyState title="No volunteers yet" description="Add your first volunteer above." />
        </Card>
      )}
    </>
  );
}
