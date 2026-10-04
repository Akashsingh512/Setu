'use client';
import { useActionState, useState, useTransition } from 'react';
import { SESSION_MODE_LABELS, SESSION_MODES } from '@crm/shared';
import { FormMessage, SubmitButton, type ActionState } from '@/components/form';
import { PosterInput } from '@/components/poster-input';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { toLocalInputValue } from '@/lib/format';
import type { Course, CourseSession, Team } from '@/lib/types';
import { cancelSession, completeSession, saveSession } from '../courses/actions';

/** Publish a new session, or edit `session` when given. */
export function SessionForm({
  courses,
  teams,
  lockedTeamId,
  defaultTimeZone,
  session,
  posterUrl = null,
}: {
  courses: Course[];
  teams: Team[];
  lockedTeamId: string | null;
  defaultTimeZone: string;
  session?: CourseSession;
  /** Signed URL of the session's poster, for the preview. */
  posterUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(async (prev: ActionState | undefined, formData: FormData) => {
    const result = await saveSession(session?.id ?? null, prev, formData);
    if (result.ok) setOpen(false);
    return result;
  }, undefined);
  const [mode, setMode] = useState<string>(session?.mode ?? 'in_person');
  const fe = state?.fieldErrors ?? {};
  const tz = session?.timezone ?? defaultTimeZone;
  const key = session?.id ?? 'new';

  if (!open) {
    if (session) {
      return (
        <button type="button" className="text-ink hover:underline" onClick={() => setOpen(true)}>
          Edit
        </button>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen(true)} disabled={courses.length === 0}>
          Publish a session
        </Button>
        {courses.length === 0 ? <span className="text-sm text-ink-muted">Create a course first.</span> : null}
        {state?.ok ? <span className="text-sm text-ok">{state.message}</span> : null}
      </div>
    );
  }

  const form = (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {session ? <h3 className="font-semibold sm:col-span-2">Edit session</h3> : null}
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
      <Field label="Course *" htmlFor={`s-course-${key}`} error={fe.course_id}>
        <Select id={`s-course-${key}`} name="course_id" required defaultValue={session?.course_id ?? ''}>
          <option value="" disabled>
            Choose…
          </option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Title (optional)" htmlFor={`s-title-${key}`} hint="Defaults to the course name.">
        <Input id={`s-title-${key}`} name="title" defaultValue={session?.title ?? ''} />
      </Field>
      <Field label="Starts *" htmlFor={`s-start-${key}`} error={fe.starts_at}>
        <Input
          id={`s-start-${key}`}
          name="starts_at"
          type="datetime-local"
          required
          defaultValue={session ? toLocalInputValue(new Date(session.starts_at), tz) : undefined}
        />
      </Field>
      <Field label="Ends *" htmlFor={`s-end-${key}`} error={fe.ends_at} hint="Last day's end time for multi-day courses.">
        <Input
          id={`s-end-${key}`}
          name="ends_at"
          type="datetime-local"
          required
          defaultValue={session ? toLocalInputValue(new Date(session.ends_at), tz) : undefined}
        />
      </Field>
      <Field label="Daily schedule note" htmlFor={`s-note-${key}`}>
        <Input id={`s-note-${key}`} name="schedule_note" placeholder="e.g. Daily 6–8 pm" defaultValue={session?.schedule_note ?? ''} />
      </Field>
      <Field label="Format" htmlFor={`s-mode-${key}`}>
        <Select id={`s-mode-${key}`} name="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          {SESSION_MODES.map((m) => (
            <option key={m} value={m}>
              {SESSION_MODE_LABELS[m]}
            </option>
          ))}
        </Select>
      </Field>
      {mode !== 'online' ? (
        <>
          <Field label="Venue *" htmlFor={`s-venue-${key}`} error={fe.venue}>
            <Input id={`s-venue-${key}`} name="venue" defaultValue={session?.venue ?? ''} />
          </Field>
          <Field label="City" htmlFor={`s-city-${key}`}>
            <Input id={`s-city-${key}`} name="city" defaultValue={session?.city ?? ''} />
          </Field>
        </>
      ) : null}
      {mode !== 'in_person' ? (
        <Field label="Meeting link *" htmlFor={`s-meet-${key}`} error={fe.meeting_url}>
          <Input id={`s-meet-${key}`} name="meeting_url" type="url" placeholder="https://" defaultValue={session?.meeting_url ?? ''} />
        </Field>
      ) : null}
      <Field label="Registration link" htmlFor={`s-reg-${key}`} error={fe.registration_url} hint="Overrides the course link.">
        <Input id={`s-reg-${key}`} name="registration_url" type="url" placeholder="https://" defaultValue={session?.registration_url ?? ''} />
      </Field>
      <Field label="Instructor" htmlFor={`s-inst-${key}`}>
        <Input id={`s-inst-${key}`} name="instructor_name" defaultValue={session?.instructor_name ?? ''} />
      </Field>
      {lockedTeamId ? (
        <Field label="Visible to" htmlFor={`s-team-${key}`}>
          <Select id={`s-team-${key}`} name="team_id" defaultValue={session ? (session.team_id ?? '') : lockedTeamId}>
            <option value={lockedTeamId}>My team</option>
            <option value="">Everyone</option>
          </Select>
        </Field>
      ) : (
        <Field label="Visible to" htmlFor={`s-team-${key}`}>
          <Select id={`s-team-${key}`} name="team_id" defaultValue={session?.team_id ?? ''}>
            <option value="">Everyone</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Additional instructions" htmlFor={`s-instr-${key}`} className="sm:col-span-2">
        <Textarea id={`s-instr-${key}`} name="instructions" defaultValue={session?.instructions ?? ''} />
      </Field>
      <Field
        label="Poster (optional)"
        htmlFor={`s-poster-${key}`}
        hint="JPG, PNG or WebP, up to 5 MB. Sent with the bot's reply about this program and from a lead's page (Send from Setu number)."
        className="sm:col-span-2"
      >
        <PosterInput id={`s-poster-${key}`} folder="programs" name="poster_path" currentPath={session?.poster_path ?? null} currentUrl={posterUrl} />
      </Field>
      <input type="hidden" name="timezone" value={tz} />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <SubmitButton>{session ? 'Save changes' : 'Publish'}</SubmitButton>
      </div>
    </form>
  );

  // Editing happens in a dialog so the card layout stays intact.
  return session ? (
    <div className="fixed inset-0 z-30 flex items-end justify-center overflow-y-auto bg-scrim p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Edit session">
      <Card className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto p-5">{form}</Card>
    </div>
  ) : (
    <Card className="p-5">{form}</Card>
  );
}

export function CancelSessionButton({ sessionId }: { sessionId: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="text-danger hover:underline disabled:opacity-50"
      disabled={pending}
      onClick={() => {
        if (confirm('Cancel this session? Volunteers will be notified.')) start(async () => void (await cancelSession(sessionId)));
      }}
    >
      {pending ? 'Cancelling…' : 'Cancel session'}
    </button>
  );
}

export function CompleteSessionButton({ sessionId }: { sessionId: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="text-ok hover:underline disabled:opacity-50"
      disabled={pending}
      onClick={() => {
        if (confirm('Mark this program as completed? It leaves the Upcoming list.')) start(async () => void (await completeSession(sessionId)));
      }}
    >
      {pending ? 'Saving…' : 'Mark completed'}
    </button>
  );
}
