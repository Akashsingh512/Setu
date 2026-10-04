import 'server-only';
import type { createClient } from '@/lib/supabase/server';

/** Signed URLs (1 hour) for poster previews, keyed by storage path. Unreadable ones are left out. */
export async function signPosters(supabase: Awaited<ReturnType<typeof createClient>>, paths: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => !!p))];
  if (!unique.length) return {};
  const { data } = await supabase.storage.from('dv-posters').createSignedUrls(unique, 3600);
  return Object.fromEntries((data ?? []).filter((d) => d.signedUrl && !d.error && d.path).map((d) => [d.path!, d.signedUrl as string]));
}

export const POSTER_PATH = /^(programs|templates)\/[A-Za-z0-9._/-]+$/;
