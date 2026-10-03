'use client';
import { useState, type ReactNode } from 'react';
import { cn } from '@/components/ui';

/**
 * Search is always visible; the other filters collapse behind a "Filters"
 * button on small screens and sit in one row on large screens.
 */
export function FilterBar({ search, activeCount, children }: { search: ReactNode; activeCount: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <form className="mb-4 flex flex-col gap-2 lg:grid lg:grid-cols-6" role="search">
      <div className="flex gap-2 lg:col-span-2">
        <div className="min-w-0 flex-1">{search}</div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="lead-filters"
          className={cn(
            'min-h-10 shrink-0 rounded-lg border px-3 text-sm font-medium lg:hidden',
            activeCount ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line-strong bg-surface text-ink',
          )}
        >
          Filters{activeCount ? ` (${activeCount})` : ''}
        </button>
      </div>
      <div id="lead-filters" className={cn(open ? 'grid' : 'hidden', 'gap-2 sm:grid-cols-2 lg:contents')}>
        {children}
      </div>
    </form>
  );
}
