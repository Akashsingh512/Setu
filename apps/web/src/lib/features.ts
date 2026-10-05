import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { FEATURES, type Feature } from '@crm/shared';
import { requireProfile } from './auth';
import { createClient } from './supabase/server';

/**
 * The features the signed-in person has (Feature access). Only decides what to
 * show; every action is checked again in the database (private.role_can).
 */
export const getFeatures = cache(async (): Promise<ReadonlySet<Feature>> => {
  const profile = await requireProfile();
  if (profile.role === 'super_admin') return new Set(FEATURES);
  const supabase = await createClient();
  const { data } = await supabase.from('role_features').select('feature').eq('role', profile.role).eq('enabled', true);
  return new Set((data ?? []).map((r) => r.feature as Feature));
});

export async function hasFeature(feature: Feature): Promise<boolean> {
  return (await getFeatures()).has(feature);
}

/** For pages a feature opens: without it, back to the dashboard. */
export async function requireFeature(feature: Feature) {
  const profile = await requireProfile();
  if (!(await hasFeature(feature))) redirect('/dashboard');
  return profile;
}
