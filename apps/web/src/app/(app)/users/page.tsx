import type { Metadata } from 'next';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requireSuperAdmin } from '@/lib/auth';
import { loadUserRows } from './load';
import { PendingRegistrations } from './pending';
import { CreateUserForm, TeamsCard, UserTable } from './user-admin';

export const metadata: Metadata = { title: 'Users' };

export default async function UsersPage() {
  const profile = await requireSuperAdmin();
  const { rows, pending, teams } = await loadUserRows(() => true, profile);
  return (
    <>
      <PageHeader title="Teachers & Users" description="Create accounts, assign roles and teams, and deactivate access." />
      <PendingRegistrations rows={pending} teams={teams} isSuperAdmin />
      <div className="mb-6 flex flex-col gap-6">
        <TeamsCard teams={teams} />
        <CreateUserForm mode="users" teams={teams} myTeamId={null} />
      </div>
      {rows.length ? (
        <UserTable rows={rows} mode="users" teams={teams} currentUserId={profile.id} />
      ) : (
        <Card>
          <EmptyState title="No users yet" />
        </Card>
      )}
    </>
  );
}
