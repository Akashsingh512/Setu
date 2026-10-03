import type { ReactNode } from 'react';
import { SetuMark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center px-4 py-12">
      <ThemeToggle className="absolute top-4 right-4" />
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <SetuMark size={72} className="mx-auto mb-4" />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
        </div>
        <div className="rounded-xl border border-line bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}
