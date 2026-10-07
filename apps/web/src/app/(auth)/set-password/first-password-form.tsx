'use client';
import { useActionState } from 'react';
import { FormMessage, SubmitButton } from '@/components/form';
import { PasswordInput } from '@/components/password-input';
import { Field } from '@/components/ui';
import { updatePassword } from '../actions';

export function FirstPasswordForm() {
  const [state, action] = useActionState(updatePassword, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormMessage state={state} />
      <input type="hidden" name="first_time" value="1" />
      <Field label="New password" htmlFor="pw" hint="At least 8 characters with letters and numbers.">
        <PasswordInput id="pw" name="password" autoComplete="new-password" required />
      </Field>
      <Field label="Confirm new password" htmlFor="pw2">
        <PasswordInput id="pw2" name="confirm" autoComplete="new-password" required />
      </Field>
      <SubmitButton pendingText="Saving…">Save and continue</SubmitButton>
    </form>
  );
}
