import type { Metadata } from 'next';
import { ROLE_LABELS } from '@crm/shared';
import { Card, PageHeader } from '@/components/ui';
import { requireProfile } from '@/lib/auth';
import { getCourses, getTeams } from '@/lib/data';
import { PushSettings } from '@/components/push';
import { createClient } from '@/lib/supabase/server';
import { PasswordForm, ProfileForm, SevaProfileForm } from './profile-forms';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const profile = await requireProfile();
  const supabase = await createClient();
  const [courses, teams, { data: members }] = await Promise.all([getCourses(), getTeams(), supabase.rpc('member_directory')]);
  // Centres others already use, so people pick the same spelling.
  const centres = [...new Set(((members ?? []) as { nearest_centre: string | null }[]).map((m) => m.nearest_centre).filter(Boolean) as string[])].sort();
  const team = teams.find((t) => t.id === profile.team_id);
  return (
    <>
      <PageHeader title="Profile" description={`${ROLE_LABELS[profile.role]}${team ? ` · ${team.name}` : ''} · ${profile.email ?? ''}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Your details</h2>
          <ProfileForm profile={profile} courses={courses} />
        </Card>
        <Card className="p-5 lg:row-span-3">
          <h2 className="font-semibold">Seva profile</h2>
          <p className="mb-4 text-sm text-ink-muted">Shown to teachers and volunteers in the Sevak Directory, so they know when and how you can help.</p>
          <SevaProfileForm profile={profile} centres={centres} />
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
