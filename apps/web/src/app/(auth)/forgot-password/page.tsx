'use client';
import Link from 'next/link';
import { useActionState } from 'react';
import { FormMessage, SubmitButton } from '@/components/form';
import { Field, Input } from '@/components/ui';
import { requestPasswordReset } from '../actions';
import { AuthShell } from '../auth-shell';

export default function ForgotPasswordPage() {
  const [state, action] = useActionState(requestPasswordReset, undefined);
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new password.">
      <form action={action} className="flex flex-col gap-4">
        <FormMessage state={state} />
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <SubmitButton pendingText="Sending…">Send reset link</SubmitButton>
        <Link href="/login" className="text-center text-sm text-ink-muted hover:text-ink">
          Back to sign in
        </Link>
      </form>
    </AuthShell>
  );
}
