'use client';
import { useActionState, useTransition } from 'react';
import { FormMessage, SubmitButton } from '@/components/form';
import { Button, ButtonLink, Field, Input } from '@/components/ui';
import { deleteIntroTalk, saveIntroTalk } from '../intro-talk-actions';

export type IntroTalkFormValues = {
  id: string;
  name: string;
  location: string;
  startsAtLocal: string; // datetime-local value in the organisation's timezone
  organised_by: string;
  location_url: string;
};

export function IntroTalkForm({ talk }: { talk: IntroTalkFormValues }) {
  const [state, action] = useActionState(saveIntroTalk, undefined);
  return (
    <form action={action} className="space-y-4 p-5 text-sm">
      <input type="hidden" name="id" value={talk.id} />
      <Field label="Intro talk name *" htmlFor="it-name">
        <Input id="it-name" name="name" maxLength={150} defaultValue={talk.name} placeholder="e.g. Happiness Program intro talk" required />
      </Field>
      <Field label="Location *" htmlFor="it-loc">
        <Input id="it-loc" name="location" maxLength={300} defaultValue={talk.location} placeholder="e.g. Community hall, Sector 5, Noida" required />
      </Field>
      <Field label="Date and time *" htmlFor="it-at">
        <Input id="it-at" name="starts_at" type="datetime-local" defaultValue={talk.startsAtLocal} className="max-w-xs" required />
      </Field>
      <Field label="Organised by" htmlFor="it-org">
        <Input id="it-org" name="organised_by" maxLength={150} defaultValue={talk.organised_by} placeholder="e.g. Noida Art of Living centre" />
      </Field>
      <Field label="Location link" htmlFor="it-url" hint="Google Maps link, so people can find the place.">
        <Input id="it-url" name="location_url" type="url" maxLength={500} defaultValue={talk.location_url} placeholder="https://maps.app.goo.gl/…" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton>{talk.id ? 'Save changes' : 'Add intro talk'}</SubmitButton>
        {talk.id ? (
          <ButtonLink href="/digital-volunteer/intro-talks" variant="ghost">
            Cancel
          </ButtonLink>
        ) : null}
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function DeleteIntroTalkButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (confirm(`Delete "${name}"? Announcements already sent are not affected.`)) start(async () => void (await deleteIntroTalk(id)));
      }}
    >
      Delete
    </Button>
  );
}
