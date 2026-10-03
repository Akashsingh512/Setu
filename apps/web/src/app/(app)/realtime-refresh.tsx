'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

const TABLES = ['leads', 'lead_assignments', 'call_attempts', 'follow_ups', 'notifications', 'courses', 'course_sessions'];

/**
 * Re-renders the current page when rows the user can see change (web ↔ mobile
 * sync). Realtime applies RLS, so each user only hears about their own data.
 */
export function RealtimeRefresh({ userId }: { userId: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`crm-${userId}`);
    for (const table of TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        // Debounce bursts (bulk assignment produces many events).
        clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 400);
      });
    }
    channel.subscribe();
    return () => {
      clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [router, userId]);

  return null;
}
