'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

const TABLES = ['wa_account', 'wa_pairing', 'wa_messages', 'wa_outbox', 'wa_groups'];

/** Live updates for Digital Volunteer pages (status, QR code, new messages). RLS applies. */
export function DvRealtime() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel('digital-volunteer');
    for (const table of TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 300);
      });
    }
    channel.subscribe();
    return () => {
      clearTimeout(timer.current);
      void supabase.removeChannel(channel);
    };
  }, [router]);
  return null;
}
