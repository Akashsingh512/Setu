'use client';
import { useFormStatus } from 'react-dom';
import type { ComponentProps } from 'react';
import { Alert, Button } from './ui';

export function SubmitButton({ children, pendingText, ...props }: ComponentProps<typeof Button> & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} aria-busy={pending} {...props}>
      {pending ? (pendingText ?? 'Saving…') : children}
    </Button>
  );
}

export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

export function FormMessage({ state }: { state: ActionState | undefined }) {
  if (!state) return null;
  if (state.error) return <Alert>{state.error}</Alert>;
  if (state.ok && state.message) return <Alert tone="ok">{state.message}</Alert>;
  return null;
}
