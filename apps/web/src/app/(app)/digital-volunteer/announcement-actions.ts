'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/form';
import { getOrgSettings } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { localInputToIso } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

// Scheduled announcements. Every action is authorised again in the database
// (private.dv_can, second-person approval); these wrappers validate input.

const uuid = z.uuid();
const createSchema = z.object({
  title: z.string().trim().min(1, 'Give it a name.').max(120),
  body: z.string().max(4000, 'Message is too long (4000 characters max).'),
  posterPath: z.string().regex(/^announcements\/[A-Za-z0-9._/-]+$/).nullable(),
  sendAt: z.string().min(1, 'Choose when to send it.'),
  groupIds: z.array(uuid).min(1, 'Choose at least one group.'),
});

export async function createAnnouncement(input: z.input<typeof createSchema>): Promise<ActionState> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Some details are not valid.' };
  const { title, body, posterPath, sendAt, groupIds } = parsed.data;
  if (!body.trim() && !posterPath) return { error: 'Write a message or add a poster.' };
  const settings = await getOrgSettings();
  const iso = localInputToIso(sendAt, settings.default_timezone);
  if (!iso) return { error: 'Choose when to send it.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_create_announcement', {
    p_title: title,
    p_body: body.trim() || null,
    p_poster_path: posterPath,
    p_send_at: iso,
    p_group_ids: groupIds,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/announcements');
  return { ok: true, message: 'Created. Someone else with the Announcements permission must approve it before it is sent.' };
}

export async function approveAnnouncement(id: string): Promise<ActionState> {
  if (!uuid.safeParse(id).success) return { error: 'Invalid announcement.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_approve_announcement', { p_id: id });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/announcements');
  return { ok: true, message: 'Approved. It will be sent at the scheduled time.' };
}

export async function rejectAnnouncement(id: string, reason: string): Promise<ActionState> {
  if (!uuid.safeParse(id).success) return { error: 'Invalid announcement.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_reject_announcement', { p_id: id, p_reason: reason.trim().slice(0, 300) || null });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/announcements');
  return { ok: true, message: 'Not approved.' };
}

export async function cancelAnnouncement(id: string): Promise<ActionState> {
  if (!uuid.safeParse(id).success) return { error: 'Invalid announcement.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('dv_cancel_announcement', { p_id: id });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/announcements');
  return { ok: true, message: data ? `Cancelled. ${data} group message(s) stopped.` : 'Cancelled.' };
}
