'use server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { optionalPhoneSchema } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { createClient } from '@/lib/supabase/server';

export type TeacherOption = { id: string; full_name: string; team_name: string | null };

/** Public teacher search for the registration form (names and team only). */
export async function searchTeachers(query: string): Promise<TeacherOption[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc('search_teachers', { p_query: query.slice(0, 60) });
  return (data ?? []) as TeacherOption[];
}

const registerSchema = z
  .object({
    full_name: z.string().trim().min(1, 'Enter your name').max(200),
    email: z.email('Enter a valid email'),
    phone: optionalPhoneSchema('IN'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[a-zA-Z]/, 'Password must include a letter')
      .regex(/\d/, 'Password must include a number'),
    confirm: z.string(),
    recommended_by: z.union([z.uuid(), z.literal('')]).optional(),
  })
  .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

export async function register(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[i.path.join('.')] ??= i.message;
    return { error: 'Please fix the highlighted fields.', fieldErrors };
  }
  const { full_name, email, phone, password, recommended_by } = parsed.data;

  const h = await headers();
  const origin = h.get('origin') ?? `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Role/approval are decided by the database, never by this metadata.
      data: { full_name, phone, recommended_by: recommended_by || null },
      emailRedirectTo: `${origin}/auth/confirm`,
    },
  });
  if (error) {
    if (/not allowed|disabled/i.test(error.message)) return { error: 'Registration is currently closed. Please contact your teacher.' };
    if (/already registered|already exists/i.test(error.message)) return { error: 'An account with this email already exists. Try signing in.' };
    if (/rate limit/i.test(error.message)) return { error: 'Too many attempts. Please try again in a few minutes.' };
    return { error: error.message };
  }
  // The account is pending approval; don't keep a session around.
  await supabase.auth.signOut();
  redirect('/login?registered=1');
}
