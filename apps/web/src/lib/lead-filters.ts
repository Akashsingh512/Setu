import type { SupabaseClient } from '@supabase/supabase-js';

/** The subset of the PostgREST filter builder the lead filters use. */
export interface Filterable<T> {
  is(column: string, value: null | boolean): T;
  eq(column: string, value: unknown): T;
  or(filters: string): T;
  not(column: string, operator: string, value: unknown): T;
  gte(column: string, value: string): T;
  lte(column: string, value: string): T;
}

export interface LeadFilterParams {
  q?: string;
  status?: string;
  course?: string;
  assignee?: string; // volunteer id, or "none"
  view?: string; // attention | awaiting | overdue | followups
  from?: string; // YYYY-MM-DD (created)
  to?: string;
}

export function readLeadFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): LeadFilterParams {
  const get = (k: string) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    return (Array.isArray(v) ? v[0] : v) || undefined;
  };
  return {
    q: get('q'),
    status: get('status'),
    course: get('course'),
    assignee: get('assignee'),
    view: get('view'),
    from: get('from'),
    to: get('to'),
  };
}

/** Strip characters that have meaning in PostgREST filter syntax. */
function cleanSearch(q: string): string {
  return q.replace(/[,()*%\\:."']/g, ' ').trim().slice(0, 80);
}

/**
 * Apply list filters to a `leads` query. Views that depend on the open
 * assignment (awaiting/overdue) are resolved by the caller into lead ids.
 */
export function applyLeadFilters<Q extends Filterable<Q>>(query: Q, f: LeadFilterParams): Q {
  let q = query.is('archived_at', null);
  const search = f.q ? cleanSearch(f.q) : '';
  if (search) {
    const digits = search.replace(/\D/g, '');
    const parts = [`full_name.ilike.*${search}*`, `lead_code.ilike.*${search}*`];
    if (digits.length >= 4) parts.push(`phone.like.*${digits}*`, `whatsapp_phone.like.*${digits}*`);
    q = q.or(parts.join(','));
  }
  if (f.status) q = q.eq('status', f.status);
  if (f.course) q = q.eq('course_id', f.course);
  if (f.assignee === 'none') q = q.is('assigned_to', null);
  else if (f.assignee) q = q.eq('assigned_to', f.assignee);
  if (f.view === 'attention') q = q.eq('needs_attention', true);
  if (f.view === 'followups') q = q.not('next_follow_up_at', 'is', null);
  if (f.from) q = q.gte('created_at', `${f.from}T00:00:00Z`);
  if (f.to) q = q.lte('created_at', `${f.to}T23:59:59Z`);
  return q;
}

/**
 * Embeds the lead's status so assignment queries can drop closed leads: once a
 * lead is Registered (or otherwise closed) no first call is owed, it is not
 * overdue and the scheduler never moves it.
 */
export const OPEN_LEAD_EMBED = 'open_lead:leads!lead_assignments_lead_id_fkey!inner(st:lead_statuses!inner(is_closed))';
export const OPEN_LEAD_FILTER = 'open_lead.st.is_closed';

/** Lead ids whose open assignment has no call yet (optionally: past deadline). Closed leads excluded. */
export async function awaitingLeadIds(supabase: SupabaseClient, opts: { assigneeId?: string; overdueOnly?: boolean }): Promise<string[]> {
  let q = supabase.from('lead_assignments').select(`lead_id, ${OPEN_LEAD_EMBED}`).eq(OPEN_LEAD_FILTER, false).is('ended_at', null).is('first_contact_at', null);
  if (opts.assigneeId) q = q.eq('assignee_id', opts.assigneeId);
  if (opts.overdueOnly) q = q.lt('contact_deadline_at', new Date().toISOString());
  const { data } = await q.limit(5000);
  return (data ?? []).map((r) => r.lead_id as string);
}
