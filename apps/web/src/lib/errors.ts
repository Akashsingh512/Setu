import type { PostgrestError } from '@supabase/supabase-js';

/**
 * Turn database errors into messages for people. RPCs raise human-readable
 * messages already; constraint and permission errors are translated here.
 */
export function friendlyError(error: Pick<PostgrestError, 'message' | 'code'> | null | undefined): string {
  if (!error) return 'Something went wrong. Please try again.';
  const m = error.message ?? '';
  if (error.code === '42501' || /permission denied|row-level security/i.test(m)) {
    return /row-level security|permission denied/i.test(m) ? "You don't have permission to do that." : m;
  }
  if (/e164/.test(m)) return 'Enter a valid mobile number with country code.';
  if (/http_url/.test(m)) return 'Links must start with http:// or https://';
  if (/time_order/.test(m)) return 'End time must be after the start time.';
  if (error.code === '23505') return 'That already exists.';
  if (error.code === '23503') return 'A referenced record no longer exists.';
  return m || 'Something went wrong. Please try again.';
}
