'use client';
import { useSyncExternalStore } from 'react';
import { cn } from './ui';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'theme';
const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Runs in <head> before first paint so a saved choice never flashes the
 * wrong theme. "system" leaves data-theme unset and the CSS media query decides.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

const listeners = new Set<() => void>();
function read(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  listeners.forEach((l) => l());
}

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, read, () => 'system' as ThemeChoice);
  return (
    <div role="radiogroup" aria-label="Theme" className={cn('inline-flex rounded-lg border border-line-strong p-0.5 text-xs', className)}>
      {CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={theme === c.value}
          onClick={() => apply(c.value)}
          className={cn('rounded-md px-2 py-1', theme === c.value ? 'bg-ink font-medium text-on-ink' : 'text-ink-muted hover:text-ink')}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
