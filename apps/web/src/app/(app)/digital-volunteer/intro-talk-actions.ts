'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/form';
import { getOrgSettings } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { localInputToIso } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

// Intro talks. Row-level security allows only people with the Announcements permission.

const schema = z.object({
  id: z.union([z.uuid(), z.literal('')]),
  name: z.string().trim().min(1, 'Give the talk a name.').max(150),
  location: z.string().trim().min(1, 'Where is it?').max(300),
  starts_at: z.string().min(1, 'Choose the date and time.'),
  organised_by: z.string().trim().max(150),
  location_url: z.union([z.literal(''), z.url({ protocol: /^https?$/, error: 'Paste a full link, starting with https://' }).max(500)]),
});

export async function saveIntroTalk(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Some details are not valid.' };
  const { id, starts_at, organised_by, location_url, ...rest } = parsed.data;
  const settings = await getOrgSettings();
  const iso = localInputToIso(starts_at, settings.default_timezone);
  if (!iso) return { error: 'Choose the date and time.' };
  const row = { ...rest, starts_at: iso, organised_by: organised_by || null, location_url: location_url.trim() || null };

  const supabase = await createClient();
  const { data, error } = id
    ? await supabase.from('dv_intro_talks').update(row).eq('id', id).select('id')
    : await supabase.from('dv_intro_talks').insert(row).select('id');
  if (error) return { error: friendlyError(error) };
  if (!data?.length) return { error: "You don't have permission to manage intro talks." };
  revalidatePath('/digital-volunteer/intro-talks');
  return { ok: true, message: id ? 'Intro talk updated.' : 'Intro talk added. Use "Announce in groups" to send it on WhatsApp.' };
}

export async function deleteIntroTalk(id: string): Promise<ActionState> {
  if (!z.uuid().safeParse(id).success) return { error: 'Invalid intro talk.' };
  const supabase = await createClient();
  const { error } = await supabase.from('dv_intro_talks').delete().eq('id', id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/intro-talks');
  return { ok: true };
}
