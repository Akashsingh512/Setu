import type { Metadata } from 'next';
import { CaptureForm } from './capture-form';

export const metadata: Metadata = { title: 'Add lead (works offline)' };

/**
 * A static page with no CRM data in it, so the service worker can keep a copy and it
 * opens with no internet. Everything it needs (courses, teams) comes from the device.
 */
export default function CapturePage() {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="flex h-14 items-center justify-between border-b border-line bg-surface px-4">
        {/* Plain link on purpose: a full page load, which is what works from the offline copy. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/leads" className="text-sm text-ink-muted hover:text-ink">
          ← Setu
        </a>
        <span className="font-semibold">Add lead</span>
        <span className="w-12" />
      </header>
      <main className="mx-auto w-full max-w-xl px-4 py-6">
        <CaptureForm />
      </main>
    </div>
  );
}
