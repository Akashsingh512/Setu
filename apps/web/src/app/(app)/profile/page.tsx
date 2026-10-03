import type { Metadata } from 'next';
import { ROLE_LABELS } from '@crm/shared';
import { Card, PageHeader } from '@/components/ui';
import { requireProfile } from '@/lib/auth';
import { getCourses, getTeams } from '@/lib/data';
import { PushSettings } from '@/components/push';
import { PasswordForm, ProfileForm } from './profile-forms';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const profile = await requireProfile();
  const [courses, teams] = await Promise.all([getCourses(), getTeams()]);
  const team = teams.find((t) => t.id === profile.team_id);
  return (
    <>
      <PageHeader title="Profile" description={`${ROLE_LABELS[profile.role]}${team ? ` · ${team.name}` : ''} · ${profile.email ?? ''}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Your details</h2>
          <ProfileForm profile={profile} courses={courses} />
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Change password</h2>
          <PasswordForm />
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Phone notifications</h2>
          <PushSettings />
        </Card>
      </div>
    </>
  );
}
