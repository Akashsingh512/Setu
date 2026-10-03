'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Polls the page while something is in progress (QR code waiting, gateway
 * request pending). Live updates also refresh the page, but this guarantees a
 * new QR code shows up even if the realtime connection drops.
 */
export function AutoRefresh({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, router]);
  return null;
}
