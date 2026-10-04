'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { DV_PERMISSIONS, DV_TEMPLATE_KINDS, unknownDvPlaceholders, type DvTemplateKind } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { friendlyError } from '@/lib/errors';
import { POSTER_PATH } from '@/lib/posters';
import { createClient } from '@/lib/supabase/server';

// Every action below is authorised again in the database (private.dv_can);
// these wrappers only validate input and translate errors.

export async function requestCommand(command: 'link' | 'logout' | 'sync_groups'): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_request_command', { p_command: command });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer', 'layout');
  return {
    ok: true,
    message: command === 'link' ? 'Generating a QR code…' : command === 'logout' ? 'Unlinking…' : 'Refreshing the group list…',
  };
}

export async function setSwitches(enabled: boolean | null, autoPaused: boolean | null): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_switches', { p_enabled: enabled, p_auto_paused: autoPaused });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer', 'layout');
  return { ok: true };
}

export async function saveDmSettings(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const mode = z.enum(['manual', 'assisted', 'automatic']).safeParse(formData.get('dm_mode'));
  if (!mode.success) return { error: 'Choose a mode.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_dm_settings', {
    p_mode: mode.data,
    p_course_info: formData.get('dm_course_info') === 'on',
    p_followup_sync: formData.get('dm_followup_sync') === 'on',
    p_seva_requests: formData.get('dm_seva_requests') === 'on',
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/account');
  return { ok: true, message: 'Saved.' };
}

const groupSchema = z.object({
  id: z.uuid(),
  enabled: z.boolean(),
  mode: z.enum(['manual', 'assisted', 'automatic']),
  allow_read: z.boolean(),
  allow_course_info: z.boolean(),
  allow_seva_requests: z.boolean(),
  allow_lead_assignment: z.boolean(),
  allow_announcements: z.boolean(),
  allow_media: z.boolean(),
  responsible_admin_id: z.uuid().nullable(),
  max_leads_per_request: z.number().int().min(1).max(50).nullable(),
});

export async function saveGroup(input: z.input<typeof groupSchema>): Promise<ActionState> {
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) return { error: 'Some settings were not valid.' };
  const { id, ...settings } = parsed.data;
  const supabase = await createClient();
  // RLS (manage_groups) decides; .select() tells us whether a row was actually changed.
  const { data, error } = await supabase.from('wa_groups').update(settings).eq('id', id).select('id');
  if (error) return { error: friendlyError(error) };
  if (!data?.length) return { error: "You don't have permission to change group settings." };
  revalidatePath('/digital-volunteer/groups');
  return { ok: true, message: 'Saved.' };
}

export async function setOperatorPermissions(profileId: string, permissions: string[]): Promise<ActionState> {
  const perms = z.array(z.enum(DV_PERMISSIONS)).safeParse(permissions);
  if (!perms.success || !z.uuid().safeParse(profileId).success) return { error: 'Invalid permissions.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_operator_permissions', { p_profile_id: profileId, p_permissions: perms.data });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer', 'layout');
  return { ok: true, message: 'Access updated.' };
}

/** `draft` returns the typed text on failure so the reply box can restore it. */
export async function sendMessage(_: (ActionState & { draft?: string }) | undefined, formData: FormData): Promise<ActionState & { draft?: string }> {
  const chat = String(formData.get('chat') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { error: 'Type a message first.' };
  if (body.length > 4000) return { error: 'Message is too long (4000 characters max).', draft: body };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_send_message', { p_chat_jid: chat, p_body: body, p_quoted_message_id: null });
  if (error) return { error: friendlyError(error), draft: body };
  revalidatePath('/digital-volunteer/inbox');
  return { ok: true, message: 'Queued - it will be sent in a few seconds.' };
}

export async function cancelOutbox(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_cancel_outbox', { p_id: id });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/inbox');
  return { ok: true };
}

export async function saveTemplate(kind: string, body: string | null): Promise<ActionState> {
  if (!(DV_TEMPLATE_KINDS as readonly string[]).includes(kind)) return { error: 'Unknown template.' };
  if (body && unknownDvPlaceholders(body).length) return { error: `Unknown placeholder: ${unknownDvPlaceholders(body).join(', ')}` };
  if (body && body.length > 2000) return { error: 'Template is too long (2000 characters max).' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_save_template', { p_kind: kind, p_body: body });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/responses');
  return { ok: true, message: body ? 'Saved.' : 'Reset to the default.' };
}

export async function setTemplatePoster(kind: DvTemplateKind, path: string | null): Promise<ActionState> {
  if (path && !POSTER_PATH.test(path)) return { error: 'The poster could not be saved. Choose it again.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_template_poster', { p_kind: kind, p_poster_path: path });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/responses');
  return { ok: true, message: path ? 'Poster saved.' : 'Poster removed.' };
}

export async function approveSuggestion(id: string, body: string | null): Promise<ActionState> {
  if (body && body.length > 4000) return { error: 'Message is too long (4000 characters max).' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_approve_outbox', { p_id: id, p_body: body });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/inbox');
  return { ok: true, message: 'Approved - sending now.' };
}

export async function dismissMessage(messageId: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_dismiss_message', { p_message_id: messageId });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/inbox');
  return { ok: true };
}

export async function confirmFollowUp(messageId: string, followUpId: string): Promise<ActionState> {
  if (!z.uuid().safeParse(messageId).success || !z.uuid().safeParse(followUpId).success) return { error: 'Invalid follow-up.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_confirm_followup', { p_message_id: messageId, p_follow_up_id: followUpId });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/inbox');
  return { ok: true };
}
