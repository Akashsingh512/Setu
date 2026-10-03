'use client';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import {
  buildCourseMessage,
  CALL_OUTCOME_LABELS,
  CALL_OUTCOMES,
  chooseMessageCourseId,
  telUrl,
  whatsAppUrl,
} from '@crm/shared';
import { FormMessage, SubmitButton, type ActionState } from '@/components/form';
import { Alert, Button, Card, CardHeader, cn, Field, Input, Select, Textarea } from '@/components/ui';
import { toLocalInputValue } from '@/lib/format';
import type { Course, FollowUp, LeadStatus, MessageTemplate, UpcomingSession } from '@/lib/types';
import { addNote, assignLeads, completeFollowUp, logCall, scheduleFollowUp, unassignLeads, updateStatus } from '../actions';

// ---------------------------------------------------------------------------
// Call + WhatsApp
// ---------------------------------------------------------------------------
export function ContactPanel(props: {
  leadId: string;
  leadName: string;
  phone: string;
  whatsapp: string;
  blocked: boolean;
  statuses: LeadStatus[];
  courses: Course[];
  sessions: UpcomingSession[];
  templates: MessageTemplate[];
  leadCourseId: string | null;
  volunteerDefaultCourseId: string | null;
  volunteerName: string;
  timeZone: string;
  openWhatsApp?: boolean;
}) {
  const [showLog, setShowLog] = useState(false);
  const [showWa, setShowWa] = useState(!!props.openWhatsApp);

  if (props.blocked) return null;

  return (
    <Card>
      <CardHeader title="Contact" description="Tapping Call opens your phone. Then record what happened. Only recorded calls count." />
      <div className="flex flex-wrap gap-2 p-5">
        <a
          href={telUrl(props.phone)}
          onClick={() => setShowLog(true)}
          className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-5 font-medium text-on-accent hover:bg-accent-hover sm:flex-none"
        >
          <span aria-hidden>📞</span> Call
        </a>
        <Button variant="secondary" className="min-h-12 flex-1 sm:flex-none" onClick={() => setShowWa((v) => !v)} aria-expanded={showWa}>
          <span aria-hidden>💬</span> WhatsApp
        </Button>
        <Button variant="secondary" className="min-h-12 flex-1 sm:flex-none" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
          Record call outcome
        </Button>
      </div>
      {showLog ? (
        <div className="border-t border-line p-5">
          <CallLogForm leadId={props.leadId} statuses={props.statuses} timeZone={props.timeZone} onDone={() => setShowLog(false)} />
        </div>
      ) : null}
      {showWa ? (
        <div id="whatsapp" className="border-t border-line p-5">
          <WhatsAppComposer {...props} />
        </div>
      ) : null}
    </Card>
  );
}

function CallLogForm({ leadId, statuses, timeZone, onDone }: { leadId: string; statuses: LeadStatus[]; timeZone: string; onDone: () => void }) {
  const [state, action] = useActionState(logCall.bind(null, leadId), undefined);
  const [outcome, setOutcome] = useState('');
  useEffect(() => {
    if (state?.ok) {
      const t = setTimeout(onDone, 1500);
      return () => clearTimeout(t);
    }
  }, [state, onDone]);

  return (
    <form action={action} className="flex flex-col gap-4">
      <FormMessage state={state} />
      <fieldset>
        <legend className="mb-2 text-sm font-medium">What happened? *</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CALL_OUTCOMES.map((o) => (
            <label
              key={o}
              className={cn(
                'flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-3 text-center text-sm',
                outcome === o ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line-strong hover:bg-canvas',
              )}
            >
              <input type="radio" name="outcome" value={o} className="sr-only" checked={outcome === o} onChange={() => setOutcome(o)} required />
              {CALL_OUTCOME_LABELS[o]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Notes" htmlFor="call-notes">
        <Textarea id="call-notes" name="notes" placeholder="What did you talk about?" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Update status (optional)" htmlFor="call-status">
          <Select id="call-status" name="new_status" defaultValue="">
            <option value="">Keep current status</option>
            {statuses.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Follow up on (optional)" htmlFor="call-fu">
          <Input id="call-fu" name="follow_up_at" type="datetime-local" min={toLocalInputValue(new Date(), timeZone)} />
        </Field>
      </div>
      <input type="hidden" name="follow_up_note" value="" />
      <div className="flex justify-end">
        <SubmitButton disabled={!outcome}>Save call</SubmitButton>
      </div>
    </form>
  );
}

function WhatsAppComposer(props: Parameters<typeof ContactPanel>[0]) {
  const initialCourse = chooseMessageCourseId({ leadCourseId: props.leadCourseId, volunteerDefaultCourseId: props.volunteerDefaultCourseId }) ?? '';
  const [courseId, setCourseId] = useState(initialCourse);
  const course = props.courses.find((c) => c.id === courseId) ?? null;
  const session = useMemo(() => props.sessions.find((s) => s.course_id === courseId) ?? null, [props.sessions, courseId]);
  const template =
    props.templates.find((t) => t.course_id === courseId && t.is_default) ?? props.templates.find((t) => !t.course_id && t.is_default) ?? null;

  const generated = useMemo(
    () =>
      buildCourseMessage({
        template: template?.body,
        leadName: props.leadName,
        volunteerName: props.volunteerName,
        course,
        session: session ? { ...session, registration_url: session.effective_registration_url } : null,
        timeZone: props.timeZone,
      }),
    [template, props.leadName, props.volunteerName, course, session, props.timeZone],
  );
  // Keep the volunteer's edits until the generated message changes (e.g. another course is chosen).
  const [edited, setEdited] = useState<{ base: string; text: string } | null>(null);
  const text = edited && edited.base === generated ? edited.text : generated;

  return (
    <div className="flex flex-col gap-3">
      <Field label="Course to share" htmlFor="wa-course" hint={session ? `Next session included: ${session.display_title}` : course ? 'No upcoming session for this course.' : undefined}>
        <Select id="wa-course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
          <option value="">No specific course</option>
          {props.courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Message (you can edit before sending)" htmlFor="wa-text">
        <Textarea id="wa-text" rows={10} value={text} onChange={(e) => setEdited({ base: generated, text: e.target.value })} />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">WhatsApp opens with this message. Nothing is sent until you press send there.</p>
        <a
          href={whatsAppUrl(props.whatsapp, text)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center rounded-lg bg-whatsapp px-4 text-sm font-medium text-white hover:bg-whatsapp-hover"
        >
          Open WhatsApp
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status / notes / follow-ups
// ---------------------------------------------------------------------------
export function StatusForm({ leadId, current, statuses }: { leadId: string; current: string; statuses: LeadStatus[] }) {
  const [state, action] = useActionState(updateStatus.bind(null, leadId), undefined);
  const [value, setValue] = useState(current);
  const target = statuses.find((s) => s.code === value);
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormMessage state={state} />
      <Select name="status" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Status">
        {statuses.map((s) => (
          <option key={s.code} value={s.code}>
            {s.label}
          </option>
        ))}
      </Select>
      {target?.blocks_contact && value !== current ? (
        <Alert tone="warn">Do Not Contact stops all calls, messages and follow-ups for this person.</Alert>
      ) : null}
      <Input name="note" placeholder="Reason (optional)" />
      <SubmitButton variant="secondary" disabled={value === current}>
        Update status
      </SubmitButton>
    </form>
  );
}

export function NoteForm({ leadId }: { leadId: string }) {
  const [key, setKey] = useState(0);
  const [state, action] = useActionState(async (prev: ActionState | undefined, formData: FormData) => {
    const result = await addNote(leadId, prev, formData);
    if (result.ok) setKey((k) => k + 1); // clears the textarea
    return result;
  }, undefined);
  return (
    <form key={key} action={action} className="flex flex-col gap-2">
      {state?.error ? <Alert>{state.error}</Alert> : null}
      <Textarea name="body" placeholder="Add a note…" aria-label="New note" required />
      <div className="flex justify-end">
        <SubmitButton variant="secondary">Add note</SubmitButton>
      </div>
    </form>
  );
}

export function FollowUpList({
  leadId,
  followUps,
  canAct,
  timeZone,
}: {
  leadId: string;
  followUps: (FollowUp & { dueLabel: string; relative: string; owner: string | null })[];
  canAct: boolean;
  timeZone: string;
}) {
  const [state, action] = useActionState(scheduleFollowUp.bind(null, leadId), undefined);
  const [pending, start] = useTransition();
  const open = followUps.filter((f) => f.status === 'open');
  const past = followUps.filter((f) => f.status !== 'open').slice(-5);

  return (
    <Card>
      <CardHeader title="Follow-ups" />
      {open.length ? (
        <ul className="divide-y divide-line text-sm">
          {open.map((f) => (
            <li key={f.id} className="flex items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className={cn('font-medium', new Date(f.due_at) < new Date() && 'text-danger')}>
                  {f.dueLabel} <span className="font-normal text-ink-muted">({f.relative})</span>
                </p>
                {f.note ? <p className="text-ink-muted">{f.note}</p> : null}
                {f.owner ? <p className="text-xs text-ink-muted">Owner: {f.owner}</p> : null}
              </div>
              {canAct ? (
                <div className="flex gap-1">
                  <Button variant="secondary" className="min-h-9 px-3" disabled={pending} onClick={() => start(async () => void (await completeFollowUp(leadId, f.id)))}>
                    Done
                  </Button>
                  <Button variant="ghost" className="min-h-9 px-2" disabled={pending} aria-label="Cancel follow-up" onClick={() => start(async () => void (await completeFollowUp(leadId, f.id, true)))}>
                    ✕
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-ink-muted">No open follow-ups.</p>
      )}
      {past.length ? (
        <p className="border-t border-line px-5 py-2 text-xs text-ink-muted">
          {past.length} completed or cancelled recently
        </p>
      ) : null}
      {canAct ? (
        <form action={action} className="flex flex-col gap-2 border-t border-line p-5">
          <FormMessage state={state} />
          <Input name="due_at" type="datetime-local" required min={toLocalInputValue(new Date(), timeZone)} aria-label="Follow-up date and time" />
          <Input name="note" placeholder="What to follow up on (optional)" />
          <SubmitButton variant="secondary">Schedule follow-up</SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Staff: single-lead assignment
// ---------------------------------------------------------------------------
export function AssignBox({
  leadId,
  currentAssignee,
  volunteers,
  blocked,
}: {
  leadId: string;
  currentAssignee: string | null;
  volunteers: { id: string; name: string }[];
  blocked: boolean;
}) {
  const [assignee, setAssignee] = useState('');
  const [msg, setMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const options = volunteers.filter((v) => v.id !== currentAssignee);

  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold">{currentAssignee ? 'Reassign' : 'Assign'}</h2>
      {blocked ? (
        <p className="text-sm text-ink-muted">Do Not Contact leads cannot be assigned.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {msg ? <Alert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Alert> : null}
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Volunteer">
            <option value="">Choose a volunteer…</option>
            {options.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
          <Button
            disabled={!assignee || pending}
            onClick={() =>
              start(async () => {
                const r = await assignLeads({ leadIds: [leadId], assigneeId: assignee });
                setMsg(r.error ? { text: r.error } : { ok: true, text: r.assigned ? 'Assigned. A new 24-hour deadline has started.' : 'No change.' });
                setAssignee('');
              })
            }
          >
            {pending ? 'Saving…' : currentAssignee ? 'Reassign' : 'Assign'}
          </Button>
          {currentAssignee ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (!confirm('Return this lead to the unassigned pool?')) return;
                start(async () => {
                  const r = await unassignLeads([leadId]);
                  setMsg(r.error ? { text: r.error } : { ok: true, text: 'Unassigned.' });
                });
              }}
            >
              Unassign
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
