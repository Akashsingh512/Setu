'use server';
import { revalidatePath } from 'next/cache';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { inviteUserSchema, type Role } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { getOrgSettings } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

async function functionError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      if (body?.error) return String(body.error);
    } catch {
      /* fall through */
    }
  }
  return error instanceof Error ? error.message : 'Request failed';
}

function refresh() {
  revalidatePath('/volunteers');
  revalidatePath('/users');
}

export async function createUser(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const settings = await getOrgSettings();
  const raw = Object.fromEntries(formData) as Record<string, string>;
  const parsed = inviteUserSchema(settings.default_phone_country).safeParse({ ...raw, team_id: raw.team_id || null });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const password = raw.password ?? '';
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return { error: 'Temporary password must be 8+ characters with letters and numbers.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.functions.invoke('admin-users', {
    body: { action: 'create', ...parsed.data, password },
  });
  if (error) return { error: await functionError(error) };
  refresh();
  return { ok: true, message: `Account created for ${parsed.data.email}. Share the temporary password with them securely.` };
}

/** Activate/deactivate: database status first (data access), then sign-in access. */
export async function setUserActive(userId: string, active: boolean): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_update_user', { p_user_id: userId, p_status: active ? 'active' : 'inactive' });
  if (error) return { error: friendlyError(error) };
  const { error: fnError } = await supabase.functions.invoke('admin-users', { body: { action: 'set_access', user_id: userId, active } });
  refresh();
  if (fnError) return { error: `Status saved, but sign-in access could not be updated: ${await functionError(fnError)}` };
  const open = (data as { open_assignments: number } | null)?.open_assignments ?? 0;
  return {
    ok: true,
    message: !active && open > 0 ? `Deactivated. They still hold ${open} lead(s) — reassign them from the Leads page.` : active ? 'Activated.' : 'Deactivated.',
  };
}

export async function updateUserSettings(
  userId: string,
  changes: { role?: Role; team_id?: string; accepting_leads?: boolean; max_open_leads?: number | null },
): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_update_user', {
    p_user_id: userId,
    p_role: changes.role ?? null,
    p_team_id: changes.team_id ?? null,
    p_accepting_leads: changes.accepting_leads ?? null,
    p_max_open_leads: changes.max_open_leads ?? null,
    p_clear_max_open_leads: changes.max_open_leads === null,
  });
  if (error) return { error: friendlyError(error) };
  refresh();
  return { ok: true, message: 'Saved.' };
}

export async function createTeam(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return { error: 'Team name is required' };
  const supabase = await createClient();
  const { error } = await supabase.from('teams').insert({ name });
  if (error) return { error: friendlyError(error) };
  refresh();
  return { ok: true, message: `Team "${name}" created.` };
}

export async function reviewRegistration(userId: string, approve: boolean, teamId?: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('review_registration', {
    p_user_id: userId,
    p_approve: approve,
    p_team_id: teamId || null,
  });
  if (error) return { error: friendlyError(error) };
  refresh();
  revalidatePath('/dashboard');
  return { ok: true, message: approve ? 'Approved. They can sign in now.' : 'Registration rejected.' };
}
