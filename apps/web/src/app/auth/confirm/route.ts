import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

function safePath(value: string | null): string | null {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

/**
 * Handles email links (password recovery, invites) and signs the user in.
 * Supports both link styles Supabase can send:
 *   ?token_hash=…&type=recovery   (custom email template; works in any browser)
 *   ?code=…                        (PKCE; must be opened in the browser that requested it)
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const code = searchParams.get('code');
  const next = safePath(searchParams.get('next'));

  const supabase = await createClient();
  let ok = false;
  if (tokenHash && type) {
    ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }
  if (!ok) return NextResponse.redirect(new URL('/login?error=link', origin));

  // A recovery sign-in must end on the "choose a new password" page.
  let isRecovery = type === 'recovery';
  if (!isRecovery) {
    const { data } = await supabase.auth.getClaims();
    const amr = (data?.claims?.amr ?? []) as { method?: string }[];
    isRecovery = amr.some((m) => m.method === 'recovery');
  }
  const destination = isRecovery ? '/reset-password' : (next ?? '/dashboard');
  return NextResponse.redirect(new URL(destination, origin));
}
