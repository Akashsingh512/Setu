'use client';
import Link from 'next/link';
import { useActionState } from 'react';
import { FormMessage, SubmitButton } from '@/components/form';
import { PasswordInput } from '@/components/password-input';
import { Field, Input } from '@/components/ui';
import { AuthShell } from '../auth-shell';
import { register } from './actions';
import { TeacherPicker } from './teacher-picker';

export default function RegisterPage() {
  const [state, action] = useActionState(register, undefined);
  const fe = state?.fieldErrors ?? {};
  return (
    <AuthShell title="Volunteer registration" subtitle="Your account becomes active once your teacher or an administrator approves it.">
      <form action={action} className="flex flex-col gap-4" noValidate>
        <FormMessage state={state} />
        <Field label="Full name *" htmlFor="r-name" error={fe.full_name}>
          <Input id="r-name" name="full_name" autoComplete="name" required aria-invalid={!!fe.full_name} />
        </Field>
        <Field label="Email *" htmlFor="r-email" error={fe.email}>
          <Input id="r-email" name="email" type="email" autoComplete="email" required aria-invalid={!!fe.email} />
        </Field>
        <Field label="Mobile number" htmlFor="r-phone" error={fe.phone}>
          <Input id="r-phone" name="phone" type="tel" autoComplete="tel" aria-invalid={!!fe.phone} />
        </Field>
        <Field label="Password *" htmlFor="r-pass" error={fe.password} hint="At least 8 characters with letters and numbers.">
          <PasswordInput id="r-pass" name="password" autoComplete="new-password" required aria-invalid={!!fe.password} />
        </Field>
        <Field label="Confirm password *" htmlFor="r-confirm" error={fe.confirm}>
          <PasswordInput id="r-confirm" name="confirm" autoComplete="new-password" required aria-invalid={!!fe.confirm} />
        </Field>
        <Field label="Recommending teacher" htmlFor="r-teacher" hint="Optional. They will be asked to approve your account; otherwise an administrator will.">
          <TeacherPicker name="recommended_by" />
        </Field>
        <SubmitButton pendingText="Registering…">Register</SubmitButton>
        <p className="text-center text-sm text-ink-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
