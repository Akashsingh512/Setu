'use server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { normalizePhone } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { createClient } from '@/lib/supabase/server';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email or mobile number'),
  password: z.string().min(1, 'Enter your password'),
  next: z.string().optional(),
});

/** Only allow same-site relative redirects after login. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

/**
 * Email, or a mobile number: people added from WhatsApp have no email and sign in
 * with their number (their account address is "<digits>@phone.setu.invalid").
 */
function loginEmail(id: string): string | null {
  if (id.includes('@')) return z.email().safeParse(id).success ? id.toLowerCase() : null;
  const phone = normalizePhone(id, 'IN');
  return phone.ok ? `${phone.e164.replace(/\D/g, '')}@phone.setu.invalid` : null;
}

export async function signIn(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const email = loginEmail(parsed.data.email);
  if (!email) return { error: 'Enter a valid email or mobile number.' };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: parsed.data.password,
  });
  if (error) return { error: 'Incorrect email / mobile number or password.' };

  // select('*') keeps sign-in working even before the approval columns exist.
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).single();
  if (profile?.status !== 'active') {
    await supabase.auth.signOut();
    if (profile?.approval_status === 'pending') {
      return { error: 'Your registration is waiting for approval by your recommending teacher or an administrator.' };
    }
    if (profile?.approval_status === 'rejected') {
      return { error: 'Your registration was not approved. Please contact your teacher.' };
    }
    return { error: 'Your account is inactive. Please contact your teacher or administrator.' };
  }
  await supabase.rpc('touch_last_seen');
  redirect(safeNext(parsed.data.next));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

export async function requestPasswordReset(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const email = z.email().safeParse(formData.get('email'));
  if (!email.success) return { error: 'Enter a valid email' };

  const h = await headers();
  const origin = h.get('origin') ?? `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host')}`;
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email.data, {
    redirectTo: `${origin}/auth/confirm?type=recovery&next=/reset-password`,
  });
  // Same response whether or not the account exists.
  return {
    ok: true,
    message: 'If an account exists for that email, a reset link is on its way. Open it in this same browser, and check your spam folder.',
  };
}

export async function updatePassword(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const schema = z
    .object({
      password: z
        .string()
        .min(8, 'Use at least 8 characters')
        .regex(/[a-zA-Z]/, 'Include a letter')
        .regex(/\d/, 'Include a number'),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: error.message };
  await supabase.rpc('clear_must_change_password');
  if (formData.get('first_time') === '1') redirect('/dashboard');
  return { ok: true, message: 'Password updated.' };
}
