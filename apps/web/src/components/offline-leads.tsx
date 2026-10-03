'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  isOnline,
  loadContext,
  parseJson,
  rawQueue,
  saveContext,
  subscribeOnline,
  subscribeStore,
  syncOfflineLeads,
  type OfflineContext,
  type OfflineLead,
} from '@/lib/offline-leads';

const REFRESH_MS = 6 * 3_600_000;

/**
 * Runs on every page of the signed-in app: sends leads saved offline whenever the
 * internet is available, keeps what the offline page needs (courses, teams) on the
 * device, and keeps the offline page itself cached by the service worker.
 */
export function OfflineLeadSync({ userId, role, teamId }: { userId: string; role: OfflineContext['role']; teamId: string | null }) {
  const raw = useSyncExternalStore(subscribeStore, rawQueue, () => '');
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const pending = useMemo(() => parseJson<OfflineLead[]>(raw, []).filter((i) => i.state === 'pending' && i.ownerId === userId).length, [raw, userId]);

  useEffect(() => {
    const supabase = createClient();
    const sync = () => void syncOfflineLeads(supabase);

    async function refreshContext() {
      const ctx = loadContext();
      if (!navigator.onLine || (ctx && ctx.userId === userId && Date.now() - new Date(ctx.savedAt).getTime() < REFRESH_MS)) return;
      const [courses, teams, settings] = await Promise.all([
        supabase.from('courses').select('id, name').eq('is_active', true).order('name'),
        supabase.from('teams').select('id, name').eq('is_active', true).order('name'),
        supabase.from('org_settings').select('default_phone_country').single(),
      ]);
      if (courses.error || teams.error) return;
      saveContext({
        userId,
        role,
        teamId,
        phoneCountry: (settings.data?.default_phone_country as string | undefined) ?? 'IN',
        courses: courses.data ?? [],
        teams: teams.data ?? [],
        savedAt: new Date().toISOString(),
      });
      // Loading the offline page once while online lets the service worker keep a copy.
      void fetch('/capture', { credentials: 'same-origin' }).catch(() => {});
    }
    const onOnline = () => {
      sync();
      void refreshContext().catch(() => {});
    };

    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    onOnline();
    window.addEventListener('online', onOnline);
    const timer = setInterval(sync, 60_000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(timer);
    };
  }, [userId, role, teamId]);

  if (!pending) return null;
  return (
    // Plain <a>: a full page load, which also works when the offline page comes from the cache.
    <a
      href="/capture"
      className="fixed inset-x-4 bottom-20 z-40 mx-auto block max-w-sm rounded-full border border-warn/30 bg-warn-soft px-4 py-2 text-center text-sm text-warn shadow-sm lg:bottom-6"
    >
      {pending} lead{pending === 1 ? '' : 's'} saved offline · {online ? 'sending…' : 'will send when online'}
    </a>
  );
}
