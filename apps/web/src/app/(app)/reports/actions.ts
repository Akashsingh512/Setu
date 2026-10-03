'use server';
import { createClient } from '@/lib/supabase/server';

/** Records a report export in the audit log (staff only; enforced by the RPC). */
export async function logExport(entity: string, rowCount: number): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc('log_export', { p_entity: entity, p_row_count: rowCount, p_filters: {} });
}
