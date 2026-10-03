'use client';
import { useActionState } from 'react';
import { FormMessage, SubmitButton } from '@/components/form';
import { PasswordInput } from '@/components/password-input';
import { Field, Input, Select } from '@/components/ui';
import type { Course, Profile } from '@/lib/types';
import { updatePassword } from '../../(auth)/actions';
import { saveProfile } from './actions';

export function ProfileForm({ profile, courses }: { profile: Profile; courses: Course[] }) {
  const [state, action] = useActionState(saveProfile, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormMessage state={state} />
      <Field label="Full name" htmlFor="p-name">
        <Input id="p-name" name="full_name" defaultValue={profile.full_name} required />
      </Field>
      <Field label="Phone" htmlFor="p-phone">
        <Input id="p-phone" name="phone" type="tel" defaultValue={profile.phone ?? ''} />
      </Field>
      <Field label="Default course" htmlFor="p-course" hint="Used in WhatsApp messages when a lead has no course selected.">
        <Select id="p-course" name="default_course_id" defaultValue={profile.default_course_id ?? ''}>
          <option value="">None</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {profile.role === 'volunteer' ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="accepting_leads" defaultChecked={profile.accepting_leads} className="mt-0.5 size-4 accent-accent" />
          <span>
            I&apos;m available for new leads
            <span className="block text-ink-muted">Turn off while you&apos;re away; you won&apos;t receive automatic reassignments.</span>
          </span>
        </label>
      ) : (
        <input type="hidden" name="accepting_leads" value={profile.accepting_leads ? 'on' : ''} />
      )}
      <SubmitButton>Save</SubmitButton>
    </form>
  );
}

export function PasswordForm() {
  const [state, action] = useActionState(updatePassword, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormMessage state={state} />
      <Field label="New password" htmlFor="pw" hint="At least 8 characters with letters and numbers.">
        <PasswordInput id="pw" name="password" autoComplete="new-password" required />
      </Field>
      <Field label="Confirm new password" htmlFor="pw2">
        <PasswordInput id="pw2" name="confirm" autoComplete="new-password" required />
      </Field>
      <SubmitButton variant="secondary">Update password</SubmitButton>
    </form>
  );
}
