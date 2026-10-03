'use client';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui';
import { createClient } from '@/lib/supabase/client';

/**
 * Links sent from the Supabase dashboard (and older email templates) put the
 * session in the URL fragment (#access_token=…&type=recovery), which never
 * reaches the server. Pick it up here and continue to the right page.
 */
export function HashSession() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get('error_description')) {
      // Deferred so the state update happens outside the effect body.
      queueMicrotask(() => setError(hash.get('error_description')!.replace(/\+/g, ' ')));
      return;
    }
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    if (!accessToken || !refreshToken) return;

    const supabase = createClient();
    void supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then((result: { error: unknown }) => {
      if (result.error) {
        setError('That link is invalid or has expired. Request a new one.');
        return;
      }
      // Full navigation so the server sees the new session cookie.
      window.location.replace(hash.get('type') === 'recovery' ? '/reset-password' : '/dashboard');
    });
  }, []);

  return error ? (
    <div className="mb-4">
      <Alert>{error}</Alert>
    </div>
  ) : null;
}
