import 'server-only';
import { getTeams, getVisibleProfiles } from '@/lib/data';
import { formatDateTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import type { Profile } from '@/lib/types';
import type { PendingRow } from './pending';
import type { UserRow } from './user-admin';

export async function loadUserRows(
  filter: (role: string) => boolean,
  viewer: Profile,
): Promise<{ rows: UserRow[]; pending: PendingRow[]; teams: { id: string; name: string }[] }> {
  const supabase = await createClient();
  const [profiles, teams, { data: open }] = await Promise.all([
    getVisibleProfiles(),
    getTeams(),
    supabase.from('lead_assignments').select('assignee_id').is('ended_at', null).limit(10000),
  ]);
  const openCount = new Map<string, number>();
  for (const a of open ?? []) openCount.set(a.assignee_id as string, (openCount.get(a.assignee_id as string) ?? 0) + 1);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const nameOf = new Map(profiles.map((p) => [p.id, p.full_name || p.email || 'Unnamed']));

  const rows = profiles
    .filter((p) => filter(p.role) && p.approval_status !== 'pending')
    .sort((a, b) => (a.status === b.status ? (a.full_name || '').localeCompare(b.full_name || '') : a.status === 'active' ? -1 : 1))
    .map((p) => ({
      id: p.id,
      name: p.full_name || p.email || 'Unnamed',
      email: p.email,
      phone: p.phone,
      role: p.role,
      status: p.status,
      team_id: p.team_id,
      teamName: p.team_id ? (teamName.get(p.team_id) ?? null) : null,
      accepting_leads: p.accepting_leads,
      max_open_leads: p.max_open_leads,
      openLeads: openCount.get(p.id) ?? 0,
      lastLogin: p.last_login_at ? formatDateTime(p.last_login_at) : null,
    }));

  // Teachers review only registrations that named them; super admins review all.
  const pending = profiles
    .filter((p) => p.approval_status === 'pending' && (viewer.role === 'super_admin' || p.recommended_by === viewer.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((p) => ({
      id: p.id,
      name: p.full_name || p.email || 'Unnamed',
      email: p.email,
      phone: p.phone,
      recommendedBy: p.recommended_by ? (nameOf.get(p.recommended_by) ?? 'A teacher') : null,
      teamId: p.team_id,
      registeredAt: formatDateTime(p.created_at),
    }));

  return { rows, pending, teams: teams.map((t) => ({ id: t.id, name: t.name })) };
}
