'use client';
import { createBrowserClient } from '@supabase/ssr';
import { supabaseKey, supabaseUrl } from './env';

let client: ReturnType<typeof createBrowserClient> | undefined;

/** Browser client (realtime subscriptions, client-side auth calls). */
export function createClient() {
  client ??= createBrowserClient(supabaseUrl, supabaseKey);
  return client;
}
