'use client';
import { useActionState, useState } from 'react';
import type { ActionState } from '@/components/form';
import { FormMessage, SubmitButton } from '@/components/form';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import type { Course, Team } from '@/lib/types';
import { saveCourse } from './actions';

export function CourseEditor({ course, teams, lockedTeamId }: { course?: Course; teams: Team[]; lockedTeamId: string | null }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(async (prev: ActionState | undefined, formData: FormData) => {
    const result = await saveCourse(course?.id ?? null, prev, formData);
    if (result.ok) setOpen(false);
    return result;
  }, undefined);
  const fe = state?.fieldErrors ?? {};

  if (!open) {
    return (
      <>
        {state?.ok ? <p className="mb-2 text-sm text-ok">{state.message}</p> : null}
        <Button variant={course ? 'secondary' : 'primary'} onClick={() => setOpen(true)}>
          {course ? 'Edit' : 'New course'}
        </Button>
      </>
    );
  }

  const Wrapper = course ? 'div' : Card;
  return (
    <Wrapper className={course ? 'flex flex-col gap-3' : 'p-5'}>
      <form action={action} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormMessage state={state} />
        </div>
        <Field label="Course name *" htmlFor={`name-${course?.id ?? 'new'}`} error={fe.name}>
          <Input id={`name-${course?.id ?? 'new'}`} name="name" defaultValue={course?.name} required />
        </Field>
        <Field label="Category" htmlFor={`cat-${course?.id ?? 'new'}`}>
          <Input id={`cat-${course?.id ?? 'new'}`} name="category" defaultValue={course?.category ?? ''} placeholder="e.g. Beginner, Youth, Advanced" />
        </Field>
        <Field label="Short description" htmlFor={`sd-${course?.id ?? 'new'}`} className="sm:col-span-2" hint="Used in WhatsApp messages.">
          <Textarea id={`sd-${course?.id ?? 'new'}`} name="short_description" defaultValue={course?.short_description ?? ''} maxLength={500} />
        </Field>
        <Field label="Full details" htmlFor={`d-${course?.id ?? 'new'}`} className="sm:col-span-2">
          <Textarea id={`d-${course?.id ?? 'new'}`} name="details" defaultValue={course?.details ?? ''} rows={4} />
        </Field>
        <Field label="Target audience" htmlFor={`ta-${course?.id ?? 'new'}`}>
          <Input id={`ta-${course?.id ?? 'new'}`} name="target_audience" defaultValue={course?.target_audience ?? ''} />
        </Field>
        <Field label="Registration link" htmlFor={`url-${course?.id ?? 'new'}`} error={fe.registration_url}>
          <Input id={`url-${course?.id ?? 'new'}`} name="registration_url" type="url" defaultValue={course?.registration_url ?? ''} placeholder="https://" />
        </Field>
        {lockedTeamId ? (
          <Field label="Visible to" htmlFor={`team-${course?.id ?? 'new'}`}>
            <Select id={`team-${course?.id ?? 'new'}`} name="team_id" defaultValue={course ? (course.team_id ?? '') : lockedTeamId}>
              <option value={lockedTeamId}>My team</option>
              <option value="">Everyone (all teams)</option>
            </Select>
          </Field>
        ) : (
          <Field label="Visible to" htmlFor={`team-${course?.id ?? 'new'}`}>
            <Select id={`team-${course?.id ?? 'new'}`} name="team_id" defaultValue={course?.team_id ?? ''}>
              <option value="">Everyone (all teams)</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" name="is_active" defaultChecked={course?.is_active ?? true} className="size-4 accent-accent" />
          Active (shown to volunteers)
        </label>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <SubmitButton>{course ? 'Save' : 'Create course'}</SubmitButton>
        </div>
      </form>
    </Wrapper>
  );
}
