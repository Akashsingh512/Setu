// Account administration that needs the service role (never shipped to clients).
//
// POST { action: "create", email, password, full_name, phone?, role, team_id? }
// POST { action: "set_access", user_id, active }   -- blocks/unblocks sign-in
//
// Authorisation mirrors the database rules: super admins manage anyone;
// teachers manage volunteers in their own team only.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ROLES = ['super_admin', 'teacher', 'volunteer'] as const;
type Role = (typeof ROLES)[number];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';

  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await asCaller.auth.getUser();
  if (!userData.user) return json(401, { error: 'Not signed in' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: caller } = await admin
    .from('profiles')
    .select('id, role, status, team_id')
    .eq('id', userData.user.id)
    .single();
  if (!caller || caller.status !== 'active' || caller.role === 'volunteer') {
    return json(403, { error: 'Not authorised' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const audit = (action: string, entityId: string | null, data: Record<string, unknown>) =>
    admin.from('audit_logs').insert({ actor_id: caller.id, action, entity_type: 'profile', entity_id: entityId, data });

  if (body.action === 'create') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const fullName = String(body.full_name ?? '').trim();
    const phone = body.phone ? String(body.phone) : null;
    const role = String(body.role ?? 'volunteer') as Role;
    let teamId = body.team_id ? String(body.team_id) : null;

    if (!EMAIL.test(email)) return json(400, { error: 'Enter a valid email' });
    if (!fullName) return json(400, { error: 'Name is required' });
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      return json(400, { error: 'Temporary password must be 8+ characters with letters and numbers' });
    }
    if (phone && !E164.test(phone)) return json(400, { error: 'Phone must be in international format' });
    if (!ROLES.includes(role)) return json(400, { error: 'Invalid role' });
    if (teamId && !UUID.test(teamId)) return json(400, { error: 'Invalid team' });

    if (caller.role === 'teacher') {
      if (role !== 'volunteer') return json(403, { error: 'Teachers can only create volunteer accounts' });
      teamId = caller.team_id;
    }
    if (role !== 'super_admin' && !teamId) return json(400, { error: 'Teachers and volunteers must belong to a team' });

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role, team_id: role === 'super_admin' ? null : teamId },
      user_metadata: { full_name: fullName, phone },
    });
    if (error) {
      const exists = /already/i.test(error.message);
      return json(exists ? 409 : 400, { error: exists ? 'An account with this email already exists' : error.message });
    }
    await audit('user.created', data.user.id, { email, role, team_id: teamId });
    return json(200, { user_id: data.user.id });
  }

  if (body.action === 'set_access') {
    const userId = String(body.user_id ?? '');
    const active = body.active === true;
    if (!UUID.test(userId)) return json(400, { error: 'Invalid user' });
    if (userId === caller.id) return json(400, { error: 'You cannot change your own access' });

    const { data: target } = await admin.from('profiles').select('id, role, team_id').eq('id', userId).single();
    if (!target) return json(404, { error: 'User not found' });
    if (caller.role === 'teacher' && (target.role !== 'volunteer' || target.team_id !== caller.team_id)) {
      return json(403, { error: 'Teachers can only manage volunteers in their team' });
    }

    const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : '876000h' });
    if (error) return json(400, { error: error.message });
    await audit(active ? 'user.sign_in_enabled' : 'user.sign_in_blocked', userId, {});
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action' });
});
