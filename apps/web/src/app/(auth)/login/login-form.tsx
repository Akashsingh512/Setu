'use client';
import Link from 'next/link';
import { useActionState } from 'react';
import { FormMessage, SubmitButton } from '@/components/form';
import { PasswordInput } from '@/components/password-input';
import { Field, Input } from '@/components/ui';
import { signIn } from '../actions';

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(signIn, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next ?? ''} />
      <Field label="Email or mobile number" htmlFor="email">
        <Input id="email" name="email" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </Field>
      <Field label="Password" htmlFor="password">
        <PasswordInput id="password" name="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton pendingText="Signing in…">Sign in</SubmitButton>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-ink-muted hover:text-ink">
          Forgot password?
        </Link>
        <Link href="/register" className="font-medium text-accent hover:underline">
          New volunteer? Register
        </Link>
      </div>
    </form>
  );
}
