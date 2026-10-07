'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/form';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

// Seva requests. Every action is authorised again in the database
// (private.dv_can); these wrappers validate input and translate errors.

const uuid = z.uuid();

export async function approveSeva(requestId: string, count: number | null): Promise<ActionState> {
  if (!uuid.safeParse(requestId).success) return { error: 'Invalid request.' };
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > 50)) return { error: 'Choose between 1 and 50 leads.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('dv_seva_approve', { p_request_id: requestId, p_count: count });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer', 'layout');
  const r = data as { status: string; assigned?: number; reason?: string };
  if (r.status === 'fulfilled') return { ok: true, message: `${r.assigned} lead(s) assigned. The numbers are being sent privately.` };
  return { error: r.reason ?? 'No leads could be assigned.' };
}

export async function rejectSeva(requestId: string, reason: string): Promise<ActionState> {
  if (!uuid.safeParse(requestId).success) return { error: 'Invalid request.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_seva_reject', { p_request_id: requestId, p_reason: reason.trim().slice(0, 300) || null });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer', 'layout');
  return { ok: true, message: 'Request declined.' };
}

export async function identifyRequester(requestId: string, profileId: string): Promise<ActionState> {
  if (!uuid.safeParse(requestId).success || !uuid.safeParse(profileId).success) return { error: 'Choose a volunteer.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_seva_set_requester', { p_request_id: requestId, p_profile_id: profileId });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer', 'layout');
  return { ok: true, message: 'Identified.' };
}

export async function revokeSeva(requestId: string): Promise<ActionState> {
  if (!uuid.safeParse(requestId).success) return { error: 'Invalid request.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('dv_seva_revoke', { p_request_id: requestId });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer', 'layout');
  const r = data as { revoked: number; kept: number };
  return {
    ok: true,
    message: `${r.revoked} lead(s) taken back${r.kept ? `; ${r.kept} stayed because the volunteer had already worked on them` : ''}.`,
  };
}

const limit = z.number().int().min(1).max(100000).nullable();

export async function saveSevaSettings(input: { perRequest: number; maxActive: number | null; daily: number | null; weekly: number | null }): Promise<ActionState> {
  const p = z.object({ perRequest: z.number().int().min(1).max(50), maxActive: limit, daily: limit, weekly: limit }).safeParse(input);
  if (!p.success) return { error: 'Limits must be whole numbers (per request: 1 to 50).' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_save_seva_settings', {
    p_default_per_request: p.data.perRequest,
    p_default_max_active: p.data.maxActive,
    p_daily_limit: p.data.daily,
    p_weekly_limit: p.data.weekly,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/seva/limits');
  return { ok: true, message: 'Saved.' };
}

export async function saveSevaLimit(input: {
  profileId: string;
  perRequest: number | null;
  maxActive: number | null;
  daily: number | null;
  weekly: number | null;
  exceptionPerRequest: number | null;
  exceptionDays: number | null;
  note: string;
}): Promise<ActionState> {
  const p = z
    .object({
      profileId: uuid,
      perRequest: z.number().int().min(1).max(50).nullable(),
      maxActive: limit,
      daily: limit,
      weekly: limit,
      exceptionPerRequest: z.number().int().min(1).max(50).nullable(),
      exceptionDays: z.number().int().min(1).max(31).nullable(),
      note: z.string().max(300),
    })
    .safeParse(input);
  if (!p.success) return { error: 'Check the numbers: per request 1–50, exception 1–31 days.' };
  const d = p.data;
  if ((d.exceptionPerRequest === null) !== (d.exceptionDays === null)) return { error: 'A temporary exception needs both a number and a number of days.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_save_seva_limit', {
    p_profile_id: d.profileId,
    p_per_request: d.perRequest,
    p_max_active: d.maxActive,
    p_daily_limit: d.daily,
    p_weekly_limit: d.weekly,
    p_exception_per_request: d.exceptionPerRequest,
    p_exception_until: d.exceptionDays === null ? null : new Date(Date.now() + d.exceptionDays * 86_400_000).toISOString(),
    p_note: d.note || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/seva/limits');
  return { ok: true, message: 'Saved.' };
}

export async function unlinkSender(senderJid: string): Promise<ActionState> {
  if (!senderJid || senderJid.length > 120) return { error: 'Invalid sender.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_seva_unlink_sender', { p_sender_jid: senderJid });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/seva');
  return { ok: true, message: 'Forgotten.' };
}

export async function saveLeadDetails(notes: boolean, history: boolean): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_save_lead_details', { p_notes: notes, p_history: history });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/seva/limits');
  return { ok: true, message: 'Saved.' };
}

export async function saveAllotMessages(allot: string, welcome: string): Promise<ActionState> {
  if (allot.length > 3000 || welcome.length > 3000) return { error: 'A message is too long (3000 characters max).' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_save_allot_messages', { p_allot: allot, p_welcome: welcome });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/seva/limits');
  return { ok: true, message: 'Saved. The next allotted leads use these messages.' };
}

export async function setLeadAllotter(profileId: string, enabled: boolean): Promise<ActionState> {
  if (!uuid.safeParse(profileId).success) return { error: 'Invalid person.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_lead_allotter', { p_profile_id: profileId, p_enabled: enabled });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/seva/limits');
  return { ok: true };
}

export async function setWhatsAppApprover(profileId: string, enabled: boolean): Promise<ActionState> {
  if (!uuid.safeParse(profileId).success) return { error: 'Invalid person.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_whatsapp_approver', { p_profile_id: profileId, p_enabled: enabled });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/seva/limits');
  return { ok: true };
}
