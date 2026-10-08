'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/form';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

// Every call is checked again in the database (Digital Volunteer "Announcements"
// permission, plus access to each lead).

const stepSchema = z.object({
  kind: z.enum(['message', 'call_task', 'program_invite']),
  delay_days: z.number().int().min(0, 'Days: 0 or more').max(365, 'Days: at most 365'),
  send_time: z.string().regex(/^\d{2}:\d{2}$/, 'Choose a time for every step'),
  body: z.string().max(3900, 'A message is too long'),
  poster_path: z
    .string()
    .regex(/^announcements\/[A-Za-z0-9._/-]+$/)
    .nullable(),
  course_id: z.uuid().nullable(),
});
const journeySchema = z.object({
  name: z.string().trim().min(1, 'Give the journey a name').max(120),
  description: z.string().trim().max(1000),
  active: z.boolean(),
  ai_auto_reply: z.boolean(),
  forward_replies: z.boolean(),
  pause_on_reply: z.boolean(),
  resume_after_hours: z.number().int().min(1, 'Wait at least 1 hour').max(720, 'Wait at most 720 hours'),
  stop_statuses: z.array(z.string().max(60)).max(50),
});
export type JourneyInput = z.input<typeof journeySchema>;
export type JourneyStepInput = z.input<typeof stepSchema>;

export async function saveJourney(id: string | null, journey: JourneyInput, steps: JourneyStepInput[]): Promise<ActionState & { id?: string }> {
  const j = journeySchema.safeParse(journey);
  if (!j.success) return { error: j.error.issues[0]?.message ?? 'Please check the form.' };
  const s = z.array(stepSchema).min(1, 'Add at least one step').max(100).safeParse(steps);
  if (!s.success) return { error: s.error.issues[0]?.message ?? 'Please check the steps.' };
  if (id && !z.uuid().safeParse(id).success) return { error: 'Invalid journey.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('dv_journey_save', { p_id: id, p_journey: j.data, p_steps: s.data });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/journeys', 'layout');
  return { ok: true, id: data as string, message: 'Saved.' };
}

export async function startJourney(journeyId: string, leadIds: string[]): Promise<ActionState> {
  if (!z.uuid().safeParse(journeyId).success) return { error: 'Choose a journey.' };
  if (!z.array(z.uuid()).min(1).max(2000).safeParse(leadIds).success) return { error: 'Choose up to 2000 leads.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('dv_journey_start', { p_journey_id: journeyId, p_lead_ids: leadIds });
  if (error) return { error: friendlyError(error) };
  const r = data as { started: number; already: number; skipped: number };
  revalidatePath('/digital-volunteer/journeys', 'layout');
  revalidatePath('/leads', 'layout');
  const extra = [r.already ? `${r.already} already on it` : '', r.skipped ? `${r.skipped} skipped (Do not contact, deleted, or not yours)` : '']
    .filter(Boolean)
    .join(', ');
  return { ok: true, message: `Started the journey for ${r.started} ${r.started === 1 ? 'person' : 'people'}.${extra ? ` ${extra}.` : ''}` };
}

export async function controlJourney(enrollmentId: string, action: 'pause' | 'resume' | 'stop'): Promise<ActionState> {
  if (!z.uuid().safeParse(enrollmentId).success) return { error: 'Invalid entry.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_journey_control', { p_enrollment_id: enrollmentId, p_action: action });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/journeys', 'layout');
  revalidatePath('/leads', 'layout');
  return { ok: true };
}
