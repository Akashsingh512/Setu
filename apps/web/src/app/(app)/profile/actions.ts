'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { optionalPhoneSchema } from '@crm/shared';
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
