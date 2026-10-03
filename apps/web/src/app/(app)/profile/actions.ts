'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { optionalPhoneSchema, SEVA_DAYS, SEVA_TIMES } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { getOrgSettings, requireProfile } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

export async function saveProfile(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const profile = await requireProfile();
  const settings = await getOrgSettings();
  const schema = z.object({
    full_name: z.string().trim().min(1, 'Name is required').max(200),
    phone: optionalPhoneSchema(settings.default_phone_country),
    default_course_id: z.union([z.uuid(), z.literal('')]).transform((v) => v || null),
  });
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { error } = await supabase
    .from('profiles')
    .update({ ...parsed.data, accepting_leads: formData.get('accepting_leads') === 'on' })
    .eq('id', profile.id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/', 'layout');
  return { ok: true, message: 'Profile saved.' };
}

const sevaSchema = z.object({
  seva_days: z.array(z.enum(SEVA_DAYS)),
  seva_times: z.array(z.enum(SEVA_TIMES)),
  seva_note: z.string().trim().max(300, 'Availability note: 300 characters max'),
  nearest_centre: z.string().trim().max(120, 'Nearest centre: 120 characters max'),
  address: z.string().trim().max(300, 'Address: 300 characters max'),
  seva_interests: z.array(z.string().trim().min(1).max(60, 'Each seva interest: 60 characters max')).max(20, 'Choose up to 20 seva interests'),
});

export async function saveSevaProfile(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const profile = await requireProfile();
  const extra = String(formData.get('seva_interests_other') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed = sevaSchema.safeParse({
    seva_days: formData.getAll('seva_days'),
    seva_times: formData.getAll('seva_times'),
    seva_note: formData.get('seva_note') ?? '',
    nearest_centre: formData.get('nearest_centre') ?? '',
    address: formData.get('address') ?? '',
    seva_interests: [...new Set([...formData.getAll('seva_interests').map(String), ...extra])],
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { error } = await supabase.from('profiles').update(parsed.data).eq('id', profile.id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/profile');
  revalidatePath('/directory');
  revalidatePath('/dashboard');
  return { ok: true, message: 'Seva profile saved. Other members can now see it in the Sevak Directory.' };
}
