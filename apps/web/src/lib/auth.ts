import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { isStaff } from '@crm/shared';
import { createClient } from './supabase/server';
import type { OrgSettings, Profile } from './types';

/**
 * The signed-in user's id, from the session JWT. getClaims() verifies the
 * token signature locally (asymmetric signing keys), avoiding a network round
 * trip to Supabase Auth on every page. Data access is still enforced by RLS.
 */
export const getUserId = cache(async (): Promise<string | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return (data?.claims?.sub as string | undefined) ?? null;
});

/**
 * The signed-in user's profile for this request. Redirects to /login when
 * signed out, and to /login?inactive=1 when the account is deactivated.
 */
export const requireProfile = cache(async (): Promise<Profile> => {
  const userId = await getUserId();
  if (!userId) redirect('/login');

  const supabase = await createClient();
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single<Profile>();
  if (!profile) redirect('/login?error=no-profile');
  if (profile.status !== 'active') redirect(profile.approval_status === 'pending' ? '/login?pending=1' : '/login?inactive=1');
  return profile;
});

export async function requireStaff(): Promise<Profile> {
  const profile = await requireProfile();
  if (!isStaff(profile.role)) redirect('/dashboard');
  return profile;
}

export async function requireSuperAdmin(): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role !== 'super_admin') redirect('/dashboard');
  return profile;
}

export const getOrgSettings = cache(async (): Promise<OrgSettings> => {
  const supabase = await createClient();
  const { data } = await supabase.from('org_settings').select('*').single<OrgSettings>();
  return (
    data ?? {
      org_name: 'Setu',
      default_timezone: 'Asia/Kolkata',
      default_phone_country: 'IN',
      contact_deadline_hours: 24,
      auto_reassign_enabled: true,
      auto_assign_enabled: true,
      auto_assign_after_minutes: 30,
      max_auto_reassignments: 3,
      default_max_open_leads: null,
      follow_up_reminder_minutes: 60,
    }
  );
});
