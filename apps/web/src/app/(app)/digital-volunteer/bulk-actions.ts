'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { normalizePhone } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { getOrgSettings } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { localInputToIso } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

// Every call is checked again in the database (Digital Volunteer "Announcements" permission).

const opt = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);
const bulkSchema = z.object({
  title: z.string().trim().min(1, 'Give it a name').max(120),
  body: z.string().trim().min(1, 'Write the message').max(3900, 'The message is too long'),
  posterPath: z
    .string()
    .regex(/^announcements\/[A-Za-z0-9._/-]+$/)
    .nullable(),
  addStopLine: z.boolean(),
  sendDays: z.array(z.number().int().min(1).max(7)).min(1, 'Choose at least one day').max(7),
  leads: z.object({ status: opt, course: opt, team: opt, assignee: opt, from: opt, to: opt }).nullable(),
  members: z.object({ role: z.enum(['volunteer', 'teacher', 'all']), team: opt }).nullable(),
  pasted: z.string().max(400_000),
  pace: z
    .object({
      minGap: z.number().int().min(5, 'Shortest gap: at least 5 seconds').max(3600),
      maxGap: z.number().int().min(5).max(7200),
      typingMin: z.number().int().min(0).max(30),
      typingMax: z.number().int().min(0).max(30),
      dailyCap: z.number().int().min(1, 'Daily limit: at least 1').max(2000, 'Daily limit: at most 2000'),
      windowStart: z.string().regex(/^(\d{2}:\d{2})?$/),
      windowEnd: z.string().regex(/^(\d{2}:\d{2})?$/),
      batchSize: z.number().int().min(0).max(1000),
      batchPause: z.number().int().min(0).max(600),
      startAt: z.string(),
    })
    .refine((p) => p.maxGap >= p.minGap, 'The longest gap must be at least the shortest')
    .refine((p) => p.typingMax >= p.typingMin, 'Longest typing time must be at least the shortest')
    .refine(
      (p) => !p.windowStart === !p.windowEnd && (!p.windowStart || p.windowEnd > p.windowStart),
      'Sending hours: give both times, the end after the start',
    ),
});
export type BulkInput = z.input<typeof bulkSchema>;
type Recipient = { phone: string; name: string | null; lead_id?: string; profile_id?: string };

export type BulkPreview = ActionState & {
  counts?: { recipients: number; invalid: number; duplicates: number; opted_out: number; do_not_contact: number; unreadable: number };
  sample?: string;
  id?: string;
};

/** The list, built on the server from what this person may see (leads follow their access). */
async function buildRecipients(input: z.output<typeof bulkSchema>): Promise<{ recipients: Recipient[]; unreadable: number }> {
  const supabase = await createClient();
  const settings = await getOrgSettings();
  const out: Recipient[] = [];
  let unreadable = 0;

  if (input.leads) {
    const l = input.leads;
    let q = supabase.from('leads').select('id, full_name, phone, whatsapp_phone').is('archived_at', null).is('merged_into_id', null).limit(5000);
    if (l.status) q = q.eq('status', l.status);
    if (l.course) q = q.eq('course_id', l.course);
    if (l.team) q = q.eq('team_id', l.team);
    if (l.assignee === 'none') q = q.is('assigned_to', null);
    else if (l.assignee === 'assigned') q = q.not('assigned_to', 'is', null);
    if (l.from) q = q.gte('created_at', `${l.from}T00:00:00Z`);
    if (l.to) q = q.lte('created_at', `${l.to}T23:59:59Z`);
    const { data, error } = await q;
    if (error) throw new Error(friendlyError(error));
    for (const r of data ?? []) out.push({ phone: (r.whatsapp_phone || r.phone) as string, name: r.full_name as string, lead_id: r.id as string });
  }

  if (input.members) {
    let q = supabase.from('profiles').select('id, full_name, phone, role, team_id').eq('status', 'active').not('phone', 'is', null).limit(5000);
    if (input.members.role !== 'all') q = q.eq('role', input.members.role);
    if (input.members.team) q = q.eq('team_id', input.members.team);
    const { data, error } = await q;
    if (error) throw new Error(friendlyError(error));
    for (const r of data ?? []) out.push({ phone: r.phone as string, name: (r.full_name as string) || null, profile_id: r.id as string });
  }

  // Pasted or uploaded: one person per line, "Name, number" or "number, name" or just a number.
  for (const line of input.pasted.split(/\r?\n/)) {
    const cells = line
      .split(/[,;\t]/)
      .map((c) => c.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    if (!cells.length) continue;
    let phone: string | null = null;
    const nameParts: string[] = [];
    for (const cell of cells) {
      let c = cell;
      // The number may share a cell with the name: "Srikesh 97912 07085".
      const m = phone ? null : c.match(/\+?\d[\d\s().-]{4,}\d/);
      if (m && /\d{6,}/.test(m[0].replace(/\D/g, ''))) {
        const r = normalizePhone(m[0], settings.default_phone_country);
        if (r.ok) {
          phone = r.e164;
          c = c.replace(m[0], ' ').replace(/^[\s:–-]+|[\s:–-]+$/g, '').replace(/\s+/g, ' ');
          if (!c) continue;
        }
      }
      if (!/^(name|phone|mobile|number|whatsapp)$/i.test(c)) nameParts.push(c); // skip a header row's labels
    }
    if (phone) out.push({ phone, name: nameParts.join(' ').slice(0, 200) || null });
    else if (!cells.every((c) => /^(name|phone|mobile|number|whatsapp)$/i.test(c))) unreadable += 1;
  }
  return { recipients: out, unreadable };
}

function campaignJson(input: z.output<typeof bulkSchema>, tz: string, audience: string) {
  const p = input.pace;
  return {
    title: input.title,
    body: input.body,
    poster_path: input.posterPath,
    add_stop_line: input.addStopLine,
    send_days: input.sendDays.length === 7 ? null : [...new Set(input.sendDays)],
    audience,
    start_at: p.startAt ? localInputToIso(p.startAt, tz) : null,
    min_gap_s: p.minGap,
    max_gap_s: p.maxGap,
    typing_min_s: p.typingMin,
    typing_max_s: p.typingMax,
    daily_cap: p.dailyCap,
    window_start: p.windowStart || null,
    window_end: p.windowEnd || null,
    batch_size: p.batchSize,
    batch_pause_min: p.batchPause,
  };
}

function describeAudience(input: z.output<typeof bulkSchema>) {
  const parts: string[] = [];
  if (input.leads) parts.push('Leads');
  if (input.members) parts.push(input.members.role === 'all' ? 'Members' : input.members.role === 'teacher' ? 'Teachers' : 'Volunteers');
  if (input.pasted.trim()) parts.push('Pasted numbers');
  return parts.join(' + ');
}

async function run(raw: BulkInput, dryRun: boolean): Promise<BulkPreview> {
  const parsed = bulkSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  const input = parsed.data;
  if (!input.leads && !input.members && !input.pasted.trim()) return { error: 'Choose who gets the message.' };
  let built;
  try {
    built = await buildRecipients(input);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!built.recipients.length) return { error: 'Nobody matches. Change the filters or paste some numbers.' };
  const settings = await getOrgSettings();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('dv_bulk_create', {
    p_campaign: campaignJson(input, settings.default_timezone, describeAudience(input)),
    p_recipients: built.recipients,
    p_dry_run: dryRun,
  });
  if (error) return { error: friendlyError(error) };
  const r = data as { id?: string; recipients: number; invalid: number; duplicates: number; opted_out: number; do_not_contact: number };
  const firstName = (built.recipients[0]?.name ?? '').split(' ')[0] ?? '';
  const sample =
    input.body
      .replaceAll('{{full_name}}', built.recipients[0]?.name ?? '')
      .replaceAll('{{name}}', firstName)
      .replace(/[ \t]+([,!.?])/g, '$1') + (input.addStopLine ? '\n\nReply STOP to stop these messages.' : '');
  if (!dryRun) revalidatePath('/digital-volunteer/bulk');
  return { ok: true, id: r.id, counts: { ...r, unreadable: built.unreadable }, sample };
}

export async function previewBulk(input: BulkInput): Promise<BulkPreview> {
  return run(input, true);
}

export async function createBulk(input: BulkInput): Promise<BulkPreview> {
  const r = await run(input, false);
  return r.ok ? { ...r, message: `Scheduled for ${r.counts?.recipients ?? 0} people.` } : r;
}

export async function controlBulk(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<ActionState> {
  if (!z.uuid().safeParse(id).success) return { error: 'Invalid bulk message.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_bulk_control', { p_id: id, p_action: action });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/bulk', 'layout');
  return { ok: true };
}

export async function setOptOut(rawPhone: string, optedOut: boolean): Promise<ActionState> {
  const settings = await getOrgSettings();
  const r = normalizePhone(rawPhone, settings.default_phone_country);
  if (!r.ok) return { error: r.error };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_opt_out', { p_phone: r.e164, p_opted_out: optedOut });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/bulk');
  return { ok: true, message: optedOut ? 'Added to the do-not-message list.' : 'Removed from the list.' };
}
