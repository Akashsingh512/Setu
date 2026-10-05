'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { assignLeadsSchema, CALL_OUTCOME_LABELS, CALL_OUTCOMES, leadInputSchema, normalizePhone } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { getOrgSettings } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { getProfileNames } from '@/lib/data';
import { formatDateTime, localInputToIso } from '@/lib/format';
import { applyLeadFilters, awaitingLeadIds, readLeadFilters, type Filterable } from '@/lib/lead-filters';
import { createClient } from '@/lib/supabase/server';

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

function leadFormValues(formData: FormData) {
  const raw = Object.fromEntries(formData) as Record<string, string>;
  return {
    ...raw,
    course_id: raw.course_id || null,
    met_on: raw.met_on || null,
    met_at_time: raw.met_at_time || null,
  };
}

export type DuplicateCheck = { total: number; visible: { id: string; lead_code: string; full_name: string; status: string }[] };

export async function checkDuplicates(phoneInput: string, excludeId?: string): Promise<DuplicateCheck | null> {
  const settings = await getOrgSettings();
  const phone = normalizePhone(phoneInput, settings.default_phone_country);
  if (!phone.ok) return null;
  const supabase = await createClient();
  const { data } = await supabase.rpc('find_duplicate_leads', { p_phone: phone.e164, p_exclude_lead_id: excludeId ?? null });
  return (data as DuplicateCheck | null) ?? null;
}

export async function createLead(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const settings = await getOrgSettings();
  const parsed = leadInputSchema(settings.default_phone_country).safeParse(leadFormValues(formData));
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase.from('leads').insert(parsed.data).select('id').single();
  if (error) return { error: friendlyError(error) };

  const assignee = formData.get('assign_to');
  if (typeof assignee === 'string' && assignee) {
    const { error: assignError } = await supabase.rpc('assign_leads', { p_lead_ids: [data.id], p_assignee_id: assignee });
    if (assignError) return { error: `Lead saved, but assignment failed: ${friendlyError(assignError)}` };
  }
  revalidatePath('/leads');
  redirect(`/leads/${data.id}`);
}

/** Volunteers add a lead they met: their own team, checked again in the database (volunteer_add_lead). */
export async function volunteerCreateLead(_: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const settings = await getOrgSettings();
  const parsed = leadInputSchema(settings.default_phone_country).omit({ team_id: true, met_by_id: true }).safeParse(leadFormValues(formData));
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('volunteer_add_lead', {
    p_lead: parsed.data,
    p_assign_to_me: formData.get('assign_to_me') === 'on',
  });
  if (error) return { error: friendlyError(error) };
  const r = data as { id?: string; duplicate?: boolean; assigned_to_me?: boolean };
  if (r.duplicate) {
    return {
      error: 'This person is already in Setu, so they were not added again. Your teacher has been told that you met them.',
    };
  }
  revalidatePath('/leads');
  if (r.assigned_to_me && r.id) redirect(`/leads/${r.id}`);
  return { ok: true, message: 'Lead added. Your teacher will assign someone to follow up.' };
}

export async function updateLead(leadId: string, _: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const settings = await getOrgSettings();
  const parsed = leadInputSchema(settings.default_phone_country).safeParse(leadFormValues(formData));
  if (!parsed.success) return { error: 'Please fix the highlighted fields.', fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.from('leads').update(parsed.data).eq('id', leadId);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  redirect(`/leads/${leadId}`);
}

export type AssignResult = ActionState & { assigned?: number; skipped?: { lead_id: string; reason: string }[] };

export async function assignLeads(input: { leadIds: string[]; assigneeId: string; note?: string }): Promise<AssignResult> {
  const parsed = assignLeadsSchema.safeParse({ lead_ids: input.leadIds, assignee_id: input.assigneeId, note: input.note });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('assign_leads', {
    p_lead_ids: parsed.data.lead_ids,
    p_assignee_id: parsed.data.assignee_id,
    p_note: parsed.data.note,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/leads');
  const r = data as { assigned_count: number; skipped: { lead_id: string; reason: string }[] };
  return { ok: true, assigned: r.assigned_count, skipped: r.skipped };
}

/** For "select all matching the filter": resolve ids server-side through RLS. */
export async function idsForFilter(search: string): Promise<string[]> {
  const supabase = await createClient();
  const filters = readLeadFilters(new URLSearchParams(search));
  let restrictTo: string[] | null = null;
  if (filters.view === 'awaiting' || filters.view === 'overdue') {
    const ids = await awaitingLeadIds(supabase, { overdueOnly: filters.view === 'overdue' });
    restrictTo = ids.length ? ids : ['00000000-0000-0000-0000-000000000000'];
  }
  // Narrow type: the full PostgREST builder type is too deep for TypeScript to infer here.
  type IdQuery = Filterable<IdQuery> & {
    in(column: string, values: string[]): IdQuery;
    limit(n: number): PromiseLike<{ data: { id: string }[] | null }>;
  };
  const base = supabase.from('leads').select('id') as unknown as IdQuery;
  const query = applyLeadFilters(restrictTo ? base.in('id', restrictTo) : base, filters);
  const { data } = await query.limit(2000);
  return (data ?? []).map((r) => r.id);
}

export async function unassignLeads(leadIds: string[]): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('unassign_leads', { p_lead_ids: leadIds });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/leads');
  const kept = (data as { kept_registered?: number } | null)?.kept_registered ?? 0;
  return {
    ok: true,
    message: kept ? `Unassigned. ${kept} registered lead(s) were kept with their volunteer.` : 'Unassigned.',
  };
}

/** Delete = move to the Deleted list (unassigned, follow-ups cancelled, history kept). */
export async function deleteLeads(leadIds: string[], reason?: string): Promise<ActionState> {
  if (!leadIds.length) return { error: 'Choose leads first.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('archive_leads', { p_lead_ids: leadIds, p_reason: reason ?? null });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/leads', 'layout');
  return { ok: true, message: `Moved ${data ?? leadIds.length} lead(s) to Deleted. You can restore them from the Deleted view.` };
}

export async function restoreLeads(leadIds: string[]): Promise<ActionState> {
  if (!leadIds.length) return { error: 'Choose leads first.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('restore_leads', { p_lead_ids: leadIds });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/leads', 'layout');
  return { ok: true, message: `Restored ${data ?? 0} lead(s). They are unassigned.` };
}

/** Super admins: erase leads from the Deleted list for ever. */
export async function purgeLeads(leadIds: string[]): Promise<ActionState> {
  if (!leadIds.length) return { error: 'Choose leads first.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('purge_leads', { p_lead_ids: leadIds });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/leads', 'layout');
  return { ok: true, message: `Deleted ${data ?? 0} lead(s) for ever.` };
}

const callSchema = z.object({
  outcome: z.enum(CALL_OUTCOMES, 'Choose what happened on the call'),
  notes: z.string().trim().max(4000).optional(),
  new_status: z.string().optional(),
  follow_up_at: z.string().optional(),
  follow_up_note: z.string().trim().max(2000).optional(),
});

export async function logCall(leadId: string, _: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const parsed = callSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const settings = await getOrgSettings();
  const followUpIso = parsed.data.follow_up_at ? localInputToIso(parsed.data.follow_up_at, settings.default_timezone) : null;

  const supabase = await createClient();
  const { error } = await supabase.rpc('log_call_attempt', {
    p_lead_id: leadId,
    p_outcome: parsed.data.outcome,
    p_notes: parsed.data.notes || null,
    p_new_status: parsed.data.new_status || null,
    p_follow_up_at: followUpIso,
    p_follow_up_note: parsed.data.follow_up_note || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, message: 'Call recorded.' };
}

/** Sends the message from the Setu WhatsApp number, with the program's poster when it has one. */
export async function sendFromSetu(leadId: string, body: string, sessionId: string | null): Promise<ActionState> {
  if (!body.trim()) return { error: 'Write a message.' };
  if (body.length > 4000) return { error: 'The message is too long (4000 characters max).' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('dv_send_lead_message', { p_lead_id: leadId, p_body: body, p_session_id: sessionId });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  return {
    ok: true,
    message: (data as { poster?: boolean } | null)?.poster ? 'Sending with the poster from the Setu number.' : 'Sending from the Setu number.',
  };
}

export async function updateStatus(leadId: string, _: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const status = String(formData.get('status') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  if (!status) return { error: 'Choose a status' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('update_lead_status', { p_lead_id: leadId, p_status: status, p_note: note || null });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, message: 'Status updated.' };
}

export async function addNote(leadId: string, _: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { error: 'Note cannot be empty' };
  const supabase = await createClient();
  const { error } = await supabase.from('lead_notes').insert({ lead_id: leadId, body });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, message: 'Note added.' };
}

export async function scheduleFollowUp(leadId: string, _: ActionState | undefined, formData: FormData): Promise<ActionState> {
  const settings = await getOrgSettings();
  const due = localInputToIso(String(formData.get('due_at') ?? ''), settings.default_timezone);
  if (!due) return { error: 'Choose a date and time' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('schedule_follow_up', {
    p_lead_id: leadId,
    p_due_at: due,
    p_note: String(formData.get('note') ?? '').trim() || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, message: 'Follow-up scheduled.' };
}

export async function completeFollowUp(leadId: string, followUpId: string, cancel = false): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('complete_follow_up', { p_follow_up_id: followUpId, p_cancel: cancel });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}

export async function addFollowUpComment(leadId: string, followUpId: string | null, body: string): Promise<ActionState> {
  if (!body.trim()) return { error: 'Write a comment.' };
  if (body.length > 2000) return { error: 'The comment is too long (2000 characters max).' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('add_follow_up_comment', { p_lead_id: leadId, p_follow_up_id: followUpId, p_body: body });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}

export type QuickViewData = {
  followUps: { id: string; due: string; overdue: boolean; note: string | null; status: string; owner: string | null }[];
  history: { id: string; kind: 'note' | 'call' | 'follow_up'; text: string; detail: string | null; who: string; when: string; at: string }[];
};

/** Follow-ups and comment/call history for the lead quick-view sheet (RLS applies). */
export async function getLeadQuickView(leadId: string): Promise<QuickViewData | { error: string }> {
  const supabase = await createClient();
  const [settings, names, followUps, notes, calls] = await Promise.all([
    getOrgSettings(),
    getProfileNames(),
    supabase.from('follow_ups').select('*').eq('lead_id', leadId).order('due_at', { ascending: false }).limit(20),
    supabase.from('lead_notes').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(30),
    supabase.from('call_attempts').select('*').eq('lead_id', leadId).order('attempted_at', { ascending: false }).limit(30),
  ]);
  if (followUps.error || notes.error || calls.error) return { error: "Couldn't load this lead's history." };
  const tz = settings.default_timezone;
  const who = (id: string | null) => (id ? (names.get(id) ?? 'A volunteer') : 'System');
  const now = new Date();

  const history: QuickViewData['history'] = [
    ...(notes.data ?? []).map((n) => ({
      id: `n-${n.id}`,
      kind: 'note' as const,
      text: n.body as string,
      detail: null,
      who: who(n.author_id),
      when: formatDateTime(n.created_at, tz),
      at: n.created_at as string,
    })),
    ...(calls.data ?? []).map((c) => ({
      id: `c-${c.id}`,
      kind: 'call' as const,
      text: `Call: ${CALL_OUTCOME_LABELS[c.outcome as keyof typeof CALL_OUTCOME_LABELS] ?? c.outcome}`,
      detail: (c.notes as string | null) ?? null,
      who: who(c.caller_id),
      when: formatDateTime(c.attempted_at, tz),
      at: c.attempted_at as string,
    })),
    ...(followUps.data ?? [])
      .filter((f) => f.status !== 'open')
      .map((f) => ({
        id: `f-${f.id}`,
        kind: 'follow_up' as const,
        text: f.status === 'done' ? 'Follow-up done' : 'Follow-up cancelled',
        detail: (f.note as string | null) ?? null,
        who: who(f.completed_by),
        when: formatDateTime(f.completed_at ?? f.due_at, tz),
        at: (f.completed_at ?? f.due_at) as string,
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    followUps: (followUps.data ?? [])
      .filter((f) => f.status === 'open')
      .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
      .map((f) => ({
        id: f.id as string,
        due: formatDateTime(f.due_at, tz),
        overdue: new Date(f.due_at) < now,
        note: (f.note as string | null) ?? null,
        status: f.status as string,
        owner: f.owner_id ? who(f.owner_id) : null,
      })),
    history,
  };
}
