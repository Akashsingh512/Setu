'use client';
import { useActionState } from 'react';
import { SEVA_DAY_LABELS, SEVA_DAYS, SEVA_INTEREST_SUGGESTIONS, SEVA_TIME_LABELS, SEVA_TIMES } from '@crm/shared';
import { FormMessage, SubmitButton } from '@/components/form';
import { PasswordInput } from '@/components/password-input';
import { Field, Input, Select, Textarea } from '@/components/ui';
import type { Course, Profile } from '@/lib/types';
import { updatePassword } from '../../(auth)/actions';
import { saveProfile, saveSevaProfile } from './actions';

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

function CheckChip({ name, value, label, checked }: { name: string; value: string; label: string; checked: boolean }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line-strong px-3 py-1 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent">
      <input type="checkbox" name={name} value={value} defaultChecked={checked} className="size-3.5 accent-accent" />
      {label}
    </label>
  );
}

/** How this person serves. Shown to every member in the Sevak Directory. */
export function SevaProfileForm({ profile, centres }: { profile: Profile; centres: string[] }) {
  const [state, action] = useActionState(saveSevaProfile, undefined);
  const suggested = new Set<string>(SEVA_INTEREST_SUGGESTIONS);
  const other = profile.seva_interests.filter((i) => !suggested.has(i));
  return (
    <form action={action} className="flex flex-col gap-5">
      <FormMessage state={state} />
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Days available for seva</legend>
        <div className="flex flex-wrap gap-2">
          {SEVA_DAYS.map((d) => (
            <CheckChip key={d} name="seva_days" value={d} label={SEVA_DAY_LABELS[d]} checked={profile.seva_days.includes(d)} />
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Time of day</legend>
        <div className="flex flex-wrap gap-2">
          {SEVA_TIMES.map((t) => (
            <CheckChip key={t} name="seva_times" value={t} label={SEVA_TIME_LABELS[t]} checked={profile.seva_times.includes(t)} />
          ))}
        </div>
      </fieldset>
      <Field label="Availability note" htmlFor="s-note" hint="e.g. After 7 pm on weekdays, full day on Sundays">
        <Input id="s-note" name="seva_note" maxLength={300} defaultValue={profile.seva_note ?? ''} />
      </Field>
      <Field label="Nearest centre" htmlFor="s-centre">
        <Input id="s-centre" name="nearest_centre" maxLength={120} list="centre-options" defaultValue={profile.nearest_centre ?? ''} />
        <datalist id="centre-options">
          {centres.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Field>
      <Field label="Address / area" htmlFor="s-address" hint="Visible to everyone in Setu. An area or locality is enough.">
        <Textarea id="s-address" name="address" rows={2} maxLength={300} defaultValue={profile.address ?? ''} />
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Seva I&apos;m interested in</legend>
        <div className="flex flex-wrap gap-2">
          {SEVA_INTEREST_SUGGESTIONS.map((i) => (
            <CheckChip key={i} name="seva_interests" value={i} label={i} checked={profile.seva_interests.includes(i)} />
          ))}
        </div>
      </fieldset>
      <Field label="Other seva interests" htmlFor="s-other" hint="Separate with commas.">
        <Input id="s-other" name="seva_interests_other" defaultValue={other.join(', ')} />
      </Field>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="show_phone_in_directory"
          defaultChecked={!!profile.show_phone_in_directory}
          className="mt-0.5 size-4 accent-accent"
        />
        <span>
          Show my phone number to other members in the Sevak Directory
          <span className="block text-xs text-ink-muted">
            {profile.phone ? 'So people can call or WhatsApp you for seva. Off: only your seva details are shown.' : 'Add your phone number above first.'}
          </span>
        </span>
      </label>
      <SubmitButton>Save seva profile</SubmitButton>
    </form>
  );
}
