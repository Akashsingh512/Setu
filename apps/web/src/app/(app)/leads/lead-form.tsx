'use client';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { LEAD_SOURCE_LABELS, LEAD_SOURCES } from '@crm/shared';
import { FormMessage, SubmitButton, type ActionState } from '@/components/form';
import { Alert, ButtonLink, Card, Field, Input, Select, Textarea } from '@/components/ui';
import type { Course, Lead, Team } from '@/lib/types';
import { checkDuplicates, type DuplicateCheck } from './actions';

export function LeadForm({
  action,
  lead,
  courses,
  teams,
  fixedTeamId,
  volunteers,
}: {
  action: (state: ActionState | undefined, formData: FormData) => Promise<ActionState>;
  lead?: Lead;
  courses: Course[];
  teams: Team[];
  fixedTeamId: string | null;
  volunteers?: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState(action, undefined);
  const [dupes, setDupes] = useState<DuplicateCheck | null>(null);
  const fe = state?.fieldErrors ?? {};

  async function onPhoneBlur(e: React.FocusEvent<HTMLInputElement>) {
    const value = e.target.value.trim();
    setDupes(value.length >= 6 ? await checkDuplicates(value, lead?.id) : null);
  }

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <FormMessage state={state} />
      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Contact</h2>
        <Field label="Full name *" htmlFor="full_name" error={fe.full_name}>
          <Input id="full_name" name="full_name" defaultValue={lead?.full_name} required aria-invalid={!!fe.full_name} />
        </Field>
        <Field label="Mobile number *" htmlFor="phone" error={fe.phone} hint="Without a country code, the default country is used.">
          <Input id="phone" name="phone" type="tel" inputMode="tel" defaultValue={lead?.phone} required onBlur={onPhoneBlur} aria-invalid={!!fe.phone} />
        </Field>
        {dupes && dupes.total > 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="warn">
              This number already belongs to {dupes.total} lead(s).
              {dupes.visible.length ? (
                <>
                  {' '}
                  {dupes.visible.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 ? ', ' : ''}
                      <Link className="underline" href={`/leads/${d.id}`} target="_blank">
                        {d.full_name} ({d.lead_code})
                      </Link>
                    </span>
                  ))}
                  .
                </>
              ) : (
                ' (in another team).'
              )}{' '}
              You can still save if this is a different person.
            </Alert>
          </div>
        ) : null}
        <Field label="WhatsApp number" htmlFor="whatsapp_phone" error={fe.whatsapp_phone} hint="Only if different from the mobile number.">
          <Input id="whatsapp_phone" name="whatsapp_phone" type="tel" defaultValue={lead?.whatsapp_phone ?? ''} />
        </Field>
        <Field label="Email" htmlFor="email" error={fe.email}>
          <Input id="email" name="email" type="email" defaultValue={lead?.email ?? ''} />
        </Field>
      </Card>

      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Where you met</h2>
        <Field label="Source" htmlFor="source">
          <Select id="source" name="source" defaultValue={lead?.source ?? 'event'}>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {LEAD_SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Event / place" htmlFor="source_detail" error={fe.source_detail}>
          <Input id="source_detail" name="source_detail" defaultValue={lead?.source_detail ?? ''} placeholder="e.g. Sunday satsang, City mall stall" />
        </Field>
        <Field label="Met by" htmlFor="met_by_name">
          <Input id="met_by_name" name="met_by_name" defaultValue={lead?.met_by_name ?? ''} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date met" htmlFor="met_on" error={fe.met_on}>
            <Input id="met_on" name="met_on" type="date" defaultValue={lead?.met_on ?? ''} />
          </Field>
          <Field label="Time" htmlFor="met_at_time" error={fe.met_at_time}>
            <Input id="met_at_time" name="met_at_time" type="time" defaultValue={lead?.met_at_time?.slice(0, 5) ?? ''} />
          </Field>
        </div>
        <Field label="Meeting notes" htmlFor="meeting_notes" className="sm:col-span-2">
          <Textarea id="meeting_notes" name="meeting_notes" defaultValue={lead?.meeting_notes ?? ''} />
        </Field>
      </Card>

      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Interest &amp; ownership</h2>
        <Field label="Course of interest" htmlFor="course_id">
          <Select id="course_id" name="course_id" defaultValue={lead?.course_id ?? ''}>
            <option value="">Not specified</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {fixedTeamId ? (
          <input type="hidden" name="team_id" value={lead?.team_id ?? fixedTeamId} />
        ) : (
          <Field label="Team *" htmlFor="team_id" error={fe.team_id}>
            <Select id="team_id" name="team_id" defaultValue={lead?.team_id ?? teams[0]?.id ?? ''} required>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {volunteers ? (
          <Field label="Assign to (optional)" htmlFor="assign_to">
            <Select id="assign_to" name="assign_to" defaultValue="">
              <option value="">Leave unassigned</option>
              {volunteers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Additional notes" htmlFor="notes" className="sm:col-span-2">
          <Textarea id="notes" name="notes" defaultValue={lead?.notes ?? ''} />
        </Field>
      </Card>

      <div className="flex justify-end gap-2">
        <ButtonLink href={lead ? `/leads/${lead.id}` : '/leads'} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton>{lead ? 'Save changes' : 'Create lead'}</SubmitButton>
      </div>
    </form>
  );
}
