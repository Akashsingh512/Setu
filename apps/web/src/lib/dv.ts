import { cache } from 'react';
import { redirect } from 'next/navigation';
import { DV_PERMISSIONS, type DvPermission } from '@crm/shared';
import { requireProfile } from './auth';
import { getFeatures } from './features';
import { createClient } from './supabase/server';

export interface DvAccess {
  isOperator: boolean;
  isSuperAdmin: boolean;
  permissions: Set<DvPermission>;
  can: (p: DvPermission) => boolean;
}

/**
 * The signed-in user's Digital Volunteer permissions. Only decides what to
 * show; every action is re-checked in the database (private.dv_can).
 */
export const getDvAccess = cache(async (): Promise<DvAccess> => {
  const profile = await requireProfile();
  let permissions: Set<DvPermission>;
  if (profile.role === 'super_admin') permissions = new Set(DV_PERMISSIONS);
  else {
    // Given to this person (Operators), or to their whole role (Feature access).
    const supabase = await createClient();
    const [{ data }, features] = await Promise.all([
      supabase.from('dv_operator_permissions').select('permission').eq('profile_id', profile.id),
      getFeatures(),
    ]);
    permissions = new Set((data ?? []).map((r) => r.permission as DvPermission));
    for (const p of DV_PERMISSIONS) if (features.has(`dv_${p}`)) permissions.add(p);
  }
  return { isOperator: permissions.size > 0, isSuperAdmin: profile.role === 'super_admin', permissions, can: (p) => permissions.has(p) };
});

export async function requireDv(permission?: DvPermission): Promise<DvAccess> {
  const access = await getDvAccess();
  if (!access.isOperator) redirect('/dashboard');
  if (permission && !access.can(permission)) redirect('/digital-volunteer');
  return access;
}

/** Follow-up journeys the signed-in user may start leads on (none without the permission). */
export const getStartableJourneys = cache(async (): Promise<{ id: string; name: string }[]> => {
  const access = await getDvAccess();
  if (!access.can('schedule_announcements')) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.from('dv_journeys').select('id, name').eq('active', true).order('name');
  return error ? [] : ((data ?? []) as { id: string; name: string }[]);
});
