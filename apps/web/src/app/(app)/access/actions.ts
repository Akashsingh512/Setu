'use server';
import { revalidatePath } from 'next/cache';
import { FEATURES, type Feature } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { requireSuperAdmin } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

// Checked again in the database (set_role_feature: super admins only).
export async function setRoleFeature(role: 'teacher' | 'volunteer', feature: Feature, enabled: boolean): Promise<ActionState> {
  await requireSuperAdmin();
  if (!['teacher', 'volunteer'].includes(role) || !FEATURES.includes(feature)) return { error: 'Unknown role or feature.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_role_feature', { p_role: role, p_feature: feature, p_enabled: enabled });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/', 'layout');
  return { ok: true };
}
