'use client';
import { useState, type ComponentProps } from 'react';
import { Input } from './ui';

/** Password field with a show/hide toggle. */
export function PasswordInput(props: Omit<ComponentProps<typeof Input>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className="pr-16" />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        aria-controls={props.id}
        className="absolute inset-y-0 right-0 flex min-w-14 items-center justify-center rounded-r-lg px-3 text-xs font-medium text-ink-muted hover:text-ink"
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
