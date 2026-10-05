import 'server-only';
import type { Role, SevaDay, SevaTime } from '@crm/shared';
import { createClient } from '@/lib/supabase/server';

export type Member = {
  id: string;
  full_name: string;
  role: Role;
  team_name: string | null;
  seva_days: SevaDay[];
  seva_times: SevaTime[];
  seva_note: string | null;
  nearest_centre: string | null;
  address: string | null;
  seva_interests: string[];
  /** Only when the member chose to show it (or it is you). */
  phone?: string | null;
};

export const hasSevaProfile = (m: Pick<Member, 'seva_days' | 'seva_interests' | 'nearest_centre'>) =>
  m.seva_days.length > 0 || m.seva_interests.length > 0 || !!m.nearest_centre;

/** Everyone active, as the Sevak Directory shows them (checked in the database). */
export async function loadDirectory(): Promise<Member[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('member_directory');
  return error ? null : ((data ?? []) as Member[]);
}
