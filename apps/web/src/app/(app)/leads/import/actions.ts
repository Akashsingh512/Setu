'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { IMPORT_CHUNK_SIZE, isE164, LEAD_SOURCES, MAX_BULK_ASSIGN } from '@crm/shared';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

const text = (max: number) => z.string().max(max).nullable();
const rowSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  phone: z.string().refine(isE164),
  whatsapp_phone: z.string().refine(isE164).nullable(),
  email: z.email().nullable(),
  source: z.enum(LEAD_SOURCES),
  source_detail: text(300),
  course_id: z.uuid().nullable(),
  met_by_name: text(200),
  met_on: z.iso.date().nullable(),
  meeting_notes: text(4000),
  notes: text(4000),
});
const inputSchema = z.object({
  teamId: z.uuid(),
  rows: z.array(rowSchema).min(1).max(IMPORT_CHUNK_SIZE),
  skipDuplicates: z.boolean(),
  assignTo: z.uuid().nullable(),
});

export type ImportChunkResult =
  | {
      ok: true;
      inserted: number;
      /** Indexes are 0-based positions within the chunk. */
      errors: { index: number; message: string }[];
      duplicates: { index: number; existingLeadId: string }[];
      assigned: number;
      assignError?: string;
    }
  | { ok: false; error: string };

/**
 * Imports one chunk through the import_leads RPC (which checks team permission,
 * duplicates and every constraint). Optionally assigns the newly created leads.
 */
export async function importLeadChunk(input: z.input<typeof inputSchema>): Promise<ImportChunkResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Some rows were not in the expected format. Re-check the file and try again.' };
  const { teamId, rows, skipDuplicates, assignTo } = parsed.data;
  // Margin for clock skew between this server and the database.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('import_leads', { p_team_id: teamId, p_rows: rows, p_skip_duplicates: skipDuplicates });
  if (error) return { ok: false, error: friendlyError(error) };

  const result = data as { inserted: number; errors: { row: number; message: string }[]; duplicates: { row: number; existing_lead_id: string }[] };
  const errors = result.errors.map((e) => ({ index: e.row - 1, message: friendlyError({ message: e.message, code: '' }) }));
  const duplicates = result.duplicates.map((d) => ({ index: d.row - 1, existingLeadId: d.existing_lead_id }));

  let assigned = 0;
  let assignError: string | undefined;
  if (assignTo && result.inserted > 0) {
    // import_leads doesn't return ids: find this user's unassigned leads created
    // for these phones in the last few minutes.
    const { data: claims } = await supabase.auth.getClaims();
    const { data: created, error: findError } = await supabase
      .from('leads')
      .select('id')
      .eq('team_id', teamId)
      .eq('created_by', claims?.claims.sub ?? '')
      .gte('created_at', since)
      .is('assigned_to', null)
      .in('phone', rows.map((r) => r.phone))
      .limit(MAX_BULK_ASSIGN);
    if (findError) assignError = friendlyError(findError);
    else if (created?.length) {
      const { error: aErr } = await supabase.rpc('assign_leads', { p_lead_ids: created.map((l) => l.id), p_assignee_id: assignTo });
      if (aErr) assignError = friendlyError(aErr);
      else assigned = created.length;
    }
  }

  revalidatePath('/leads');
  return { ok: true, inserted: result.inserted, errors, duplicates, assigned, assignError };
}
