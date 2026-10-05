import { navForRole, ROLE_LABELS } from '@crm/shared';
import { requireProfile } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { NavLinks, MobileNav } from './nav';
import { RealtimeRefresh } from './realtime-refresh';
import { ThemeToggle } from '@/components/theme-toggle';
import { PushPrompt } from '@/components/push';
import { SignOutButton } from '@/components/sign-out-button';
import { getDvAccess } from '@/lib/dv';
import { getFeatures } from '@/lib/features';
import { SetuMark } from '@/components/brand';
import { OfflineLeadSync } from '@/components/offline-leads';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  // Independent requests run in parallel: each Supabase round trip is ~0.5 s from here.
  const [profile, { count: unread }, dv, features] = await Promise.all([
    requireProfile(),
    supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    getDvAccess(),
    getFeatures(),
  ]);

  const nav = navForRole(profile.role, { digitalVolunteer: dv.isOperator, features });

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-2 border-b border-line px-5">
          <SetuMark size={32} />
          <span className="font-semibold">Setu</span>
        </div>
        <NavLinks items={nav} unread={unread ?? 0} />
        <div className="border-t border-line p-4">
          <p className="truncate text-sm font-medium">{profile.full_name || profile.email}</p>
          <p className="text-xs text-ink-muted">{ROLE_LABELS[profile.role]}</p>
          <ThemeToggle className="mt-3" />
          <SignOutButton className="mt-3 block text-sm text-ink-muted hover:text-ink" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-line bg-surface px-4 lg:hidden">
          <span className="flex items-center gap-2 font-semibold">
            <SetuMark size={28} />
            Setu
          </span>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <SignOutButton className="text-sm text-ink-muted" />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-24 sm:px-6 lg:px-8 lg:pb-10">
          <PushPrompt />
          {children}
        </main>
      </div>

      <MobileNav teamLeads={features.has('team_leads')} unread={unread ?? 0} />
      <RealtimeRefresh userId={profile.id} />
      <OfflineLeadSync userId={profile.id} role={profile.role} teamId={profile.team_id} />
    </div>
  );
}
