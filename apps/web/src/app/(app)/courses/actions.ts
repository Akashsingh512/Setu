'use server';
import { revalidatePath } from 'next/cache';
import { courseInputSchema, sessionInputSchema } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { getOrgSettings } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { localInputToIso } from '@/lib/format';
import { POSTER_PATH } from '@/lib/posters';
import { createClient } from '@/lib/supabase/server';

function firstErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path.join('.');
    if (!out[k]) out[k] = i.message;
  }
  return out;
}

export async function saveCourse(courseId: string | null, _: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const raw = Object.fromEntries(formData) as Record<string, string>;
  const parsed = courseInputSchema.safeParse({ ...raw, is_active: raw.is_active === 'on', team_id: raw.team_id || null });
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: firstErrors(parsed.error.issues) };

  const supabase = await createClient();
  const { data: saved, error } = courseId
    ? await supabase.from('courses').update(parsed.data).eq('id', courseId).select('id')
    : await supabase.from('courses').insert(parsed.data).select('id');
  if (error) return { error: friendlyError(error) };
  // RLS filters rows silently on update: no row means no permission.
  if (!saved?.length) return { error: "You don't have permission to edit this course." };
  revalidatePath('/courses');
  return { ok: true, message: courseId ? 'Course updated.' : 'Course created.' };
}

/** Create (sessionId null) or update a session. Datetimes arrive as local values in the session timezone. */
export async function saveSession(sessionId: string | null, _: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const settings = await getOrgSettings();
  const raw = Object.fromEntries(formData) as Record<string, string>;
  const tz = raw.timezone || settings.default_timezone;
  const parsed = sessionInputSchema.safeParse({
    ...raw,
    timezone: tz,
    starts_at: localInputToIso(raw.starts_at ?? '', tz) ?? '',
    ends_at: localInputToIso(raw.ends_at ?? '', tz) ?? '',
    team_id: raw.team_id || null,
  });
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: firstErrors(parsed.error.issues) };
  const poster = raw.poster_path || null;
  if (poster && !POSTER_PATH.test(poster)) return { error: 'The poster could not be saved. Choose it again.' };

  // Fields hidden by the chosen format are cleared, not left stale.
  const data = {
    ...parsed.data,
    venue: parsed.data.mode === 'online' ? null : parsed.data.venue,
    city: parsed.data.mode === 'online' ? null : parsed.data.city,
    meeting_url: parsed.data.mode === 'in_person' ? null : parsed.data.meeting_url,
    poster_path: poster,
  };
  const supabase = await createClient();
  const { data: saved, error } = sessionId
    ? await supabase.from('course_sessions').update(data).eq('id', sessionId).select('id')
    : await supabase.from('course_sessions').insert(data).select('id');
  if (error) return { error: friendlyError(error) };
  // RLS filters rows silently on update: no row means no permission.
  if (!saved?.length) return { error: "You don't have permission to edit this session." };
  revalidatePath('/upcoming');
  return {
    ok: true,
    message: sessionId ? 'Session updated. Volunteers are notified if the schedule or venue changed.' : 'Session published. Volunteers have been notified.',
  };
}

export async function cancelSession(sessionId: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data: saved, error } = await supabase.from('course_sessions').update({ status: 'cancelled' }).eq('id', sessionId).select('id');
  if (error) return { error: friendlyError(error) };
  if (!saved?.length) return { error: "You don't have permission to cancel this session." };
  revalidatePath('/upcoming');
  return { ok: true };
}

/** Finish a running program early (programs are also completed automatically once they end). */
export async function completeSession(sessionId: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data: saved, error } = await supabase
    .from('course_sessions')
    .update({ status: 'completed' })
    .eq('id', sessionId)
    .eq('status', 'scheduled')
    .select('id');
  if (error) return { error: friendlyError(error) };
  if (!saved?.length) return { error: "You don't have permission to change this session." };
  revalidatePath('/upcoming');
  return { ok: true };
}
