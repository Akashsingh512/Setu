import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ASSIGNMENT_END_REASON_LABELS, CALL_OUTCOME_LABELS, formatPhone, isStaff, LEAD_SOURCE_LABELS } from '@crm/shared';
import { DeadlineBadge, StatusBadge } from '@/components/lead-bits';
import { Alert, Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { getOrgSettings, requireProfile } from '@/lib/auth';
import { getCourses, getProfileNames, getStatuses, getVisibleProfiles, statusMap } from '@/lib/data';
import { formatDate, formatDateTime, relativeTime } from '@/lib/format';
import { signPosters } from '@/lib/posters';
import { createClient } from '@/lib/supabase/server';
import type { CallAttempt, FollowUp, Lead, LeadActivity, LeadAssignment, LeadNote, MessageTemplate, UpcomingSession } from '@/lib/types';
import { AssignBox, ContactPanel, FollowUpList, NoteForm, StatusForm } from './panels';

export const metadata: Metadata = { title: 'Lead' };

const ACTIVITY_LABELS: Record<string, string> = {
  created: 'Lead created',
  assigned: 'Assigned',
  unassigned: 'Unassigned',
  status_changed: 'Status changed',
  call_logged: 'Call recorded',
  note_added: 'Note added',
  follow_up_scheduled: 'Follow-up scheduled',
  follow_up_completed: 'Follow-up done',
  follow_up_cancelled: 'Follow-up cancelled',
  updated: 'Details edited',
  archived: 'Archived',
  merged: 'Duplicate merged in',
  merged_into: 'Merged into another lead',
  whatsapp_received: 'WhatsApp message from the lead',
  whatsapp_sent: 'WhatsApp sent from the Setu number',
};

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const supabase = await createClient();
  const [{ id }, { wa }] = await Promise.all([params, searchParams]);
  // Server Component: rendered once per request, so reading the clock here is safe.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  // Round trip 1: everything that only needs the lead id.
  const [profile, { data: lead }, { data: merged }, statuses, courses, settings, names, followUps, sessions, templates] = await Promise.all([
    requireProfile(),
    supabase.from('leads').select('*').eq('id', id).maybeSingle<Lead>(),
    // History of duplicates merged into this lead is shown here too.
    supabase.from('leads').select('id').eq('merged_into_id', id),
    getStatuses(),
    getCourses(),
    getOrgSettings(),
    getProfileNames(),
    supabase.from('follow_ups').select('*').eq('lead_id', id).order('due_at'),
    supabase.from('upcoming_sessions').select('*').order('starts_at').limit(100),
    supabase.from('message_templates').select('*').eq('is_active', true),
  ]);
  if (!lead) notFound();
  const staff = isStaff(profile.role);
  const historyIds = [lead.id, ...(merged ?? []).map((m) => m.id as string)];

  // Round trip 2: history across the lead and any merged duplicates.
  const [profiles, assignments, calls, notes, activities] = await Promise.all([
    staff ? getVisibleProfiles() : Promise.resolve([]),
    supabase.from('lead_assignments').select('*').in('lead_id', historyIds).order('assigned_at', { ascending: false }),
    supabase.from('call_attempts').select('*').in('lead_id', historyIds).order('attempted_at', { ascending: false }),
    supabase.from('lead_notes').select('*').in('lead_id', historyIds).order('created_at', { ascending: false }),
    supabase.from('lead_activities').select('*').in('lead_id', historyIds).order('created_at', { ascending: false }).limit(100),
  ]);

  const upcoming = (sessions.data ?? []) as UpcomingSession[];
  const posters = await signPosters(supabase, upcoming.map((s) => s.poster_path));
  const sMap = statusMap(statuses);
  const status = sMap.get(lead.status);
  const blocked = !!status?.blocks_contact;
  const current = (assignments.data as LeadAssignment[] | null)?.find((a) => a.id === lead.current_assignment_id);
  const name = (uid: string | null | undefined, fallback = 'Someone') => (uid ? (names.get(uid) ?? fallback) : 'System');
  const canAct = staff || lead.assigned_to === profile.id;
  const course = courses.find((c) => c.id === lead.course_id);

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/leads" className="text-ink-muted hover:text-ink">
          ← {staff ? 'Leads' : 'My Leads'}
        </Link>
      </div>
      <PageHeader
        title={lead.full_name}
        description={`${lead.lead_code} · added ${formatDate(lead.created_at)}`}
        actions={staff ? <ButtonLink href={`/leads/${lead.id}/edit`} variant="secondary">Edit</ButtonLink> : undefined}
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        <StatusBadge code={lead.status} statuses={sMap} />
        <DeadlineBadge deadline={current?.contact_deadline_at} contacted={!!current?.first_contact_at || !!sMap.get(lead.status)?.is_closed} now={now} />
        {lead.needs_attention ? <Badge tone="danger">Needs attention</Badge> : null}
        {lead.archived_at ? <Badge>Archived</Badge> : null}
      </div>

      {lead.merged_into_id ? (
        <div className="mb-4">
          <Alert tone="info">
            This lead was merged into <Link className="underline" href={`/leads/${lead.merged_into_id}`}>another lead</Link>.
          </Alert>
        </div>
      ) : null}
      {blocked ? (
        <div className="mb-4">
          <Alert>This person asked not to be contacted. Calls, messages and follow-ups are disabled.</Alert>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          {canAct && !lead.archived_at ? (
            <ContactPanel
              leadId={lead.id}
              leadName={lead.full_name}
              phone={lead.phone}
              whatsapp={lead.whatsapp_phone ?? lead.phone}
              blocked={blocked}
              statuses={statuses.filter((s) => s.is_active)}
              courses={courses}
              sessions={upcoming}
              posterUrls={posters}
              templates={(templates.data ?? []) as MessageTemplate[]}
              leadCourseId={lead.course_id}
              volunteerDefaultCourseId={profile.default_course_id}
              volunteerName={profile.full_name}
              timeZone={settings.default_timezone}
              openWhatsApp={wa === '1'}
            />
          ) : null}

          <Card>
            <CardHeader title="Calls" description={`${lead.call_attempt_count} attempt(s)`} />
            {(calls.data as CallAttempt[] | null)?.length ? (
              <ul className="divide-y divide-line text-sm">
                {(calls.data as CallAttempt[]).map((c) => (
                  <li key={c.id} className="px-5 py-3">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-medium">{CALL_OUTCOME_LABELS[c.outcome]}</span>
                      <span className="text-ink-muted">{formatDateTime(c.attempted_at, settings.default_timezone)}</span>
                    </div>
                    <p className="text-ink-muted">by {name(c.caller_id, 'a volunteer')}</p>
                    {c.notes ? <p className="mt-1 whitespace-pre-wrap">{c.notes}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No calls recorded yet" />
            )}
          </Card>

          <Card>
            <CardHeader title="Notes" />
            {canAct && !lead.archived_at ? (
              <div className="border-b border-line p-5">
                <NoteForm leadId={lead.id} />
              </div>
            ) : null}
            {(notes.data as LeadNote[] | null)?.length ? (
              <ul className="divide-y divide-line text-sm">
                {(notes.data as LeadNote[]).map((n) => (
                  <li key={n.id} className="px-5 py-3">
                    <p className="whitespace-pre-wrap">{n.body}</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      {name(n.author_id)} · {formatDateTime(n.created_at, settings.default_timezone)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No notes yet" />
            )}
          </Card>

          <Card>
            <CardHeader title="Timeline" />
            <ol className="divide-y divide-line text-sm">
              {((activities.data ?? []) as LeadActivity[]).map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-2 px-5 py-2.5">
                  <span>
                    <span className="font-medium">{ACTIVITY_LABELS[a.type] ?? a.type}</span>
                    {a.type === 'status_changed' ? (
                      <span className="text-ink-muted">
                        {' '}
                        {sMap.get(String(a.data.from))?.label ?? String(a.data.from)} → {sMap.get(String(a.data.to))?.label ?? String(a.data.to)}
                      </span>
                    ) : null}
                    {a.type === 'assigned' && a.data.assignee_id ? <span className="text-ink-muted"> to {name(String(a.data.assignee_id), 'a volunteer')}</span> : null}
                    {a.type === 'call_logged' ? <span className="text-ink-muted"> · {CALL_OUTCOME_LABELS[a.data.outcome as keyof typeof CALL_OUTCOME_LABELS]}</span> : null}
                    {a.type === 'follow_up_completed' && a.data.via === 'whatsapp' ? <span className="text-ink-muted"> · confirmed from WhatsApp</span> : null}
                    <span className="text-ink-muted"> · {name(a.actor_id)}</span>
                    {a.type === 'whatsapp_sent' ? (
                      <span className="mt-0.5 block whitespace-pre-wrap text-ink-muted">
                        {a.data.poster ? '[poster] ' : ''}
                        {a.data.preview ? `“${String(a.data.preview)}”` : null}
                      </span>
                    ) : null}
                    {a.type === 'whatsapp_received' ? (
                      <span className="mt-0.5 block whitespace-pre-wrap text-ink-muted">
                        {a.data.preview ? `“${String(a.data.preview)}”` : `[${String(a.data.media_type ?? 'attachment')}]`}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-ink-muted" title={formatDateTime(a.created_at, settings.default_timezone)}>
                    {relativeTime(a.created_at)}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card className="p-5 text-sm">
            <h2 className="mb-3 font-semibold">Details</h2>
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
              <dt className="text-ink-muted">Mobile</dt>
              <dd>{formatPhone(lead.phone)}</dd>
              {lead.whatsapp_phone ? (
                <>
                  <dt className="text-ink-muted">WhatsApp</dt>
                  <dd>{formatPhone(lead.whatsapp_phone)}</dd>
                </>
              ) : null}
              {lead.email ? (
                <>
                  <dt className="text-ink-muted">Email</dt>
                  <dd className="break-all">{lead.email}</dd>
                </>
              ) : null}
              <dt className="text-ink-muted">Course</dt>
              <dd>{course?.name ?? '—'}</dd>
              <dt className="text-ink-muted">Source</dt>
              <dd>
                {LEAD_SOURCE_LABELS[lead.source]}
                {lead.source_detail ? ` · ${lead.source_detail}` : ''}
              </dd>
              <dt className="text-ink-muted">Met by</dt>
              <dd>{lead.met_by_name ?? '—'}</dd>
              <dt className="text-ink-muted">Met on</dt>
              <dd>
                {formatDate(lead.met_on)}
                {lead.met_at_time ? ` ${lead.met_at_time.slice(0, 5)}` : ''}
              </dd>
              <dt className="text-ink-muted">Assigned to</dt>
              <dd>{lead.assigned_to ? name(lead.assigned_to, 'a volunteer') : 'Unassigned'}</dd>
              <dt className="text-ink-muted">Last contact</dt>
              <dd>{lead.last_contact_at ? formatDateTime(lead.last_contact_at, settings.default_timezone) : 'Never'}</dd>
            </dl>
            {lead.meeting_notes ? (
              <p className="mt-3 border-t border-line pt-3 whitespace-pre-wrap">
                <span className="block text-ink-muted">Meeting notes</span>
                {lead.meeting_notes}
              </p>
            ) : null}
            {lead.notes ? (
              <p className="mt-3 border-t border-line pt-3 whitespace-pre-wrap">
                <span className="block text-ink-muted">Additional notes</span>
                {lead.notes}
              </p>
            ) : null}
          </Card>

          {canAct && !lead.archived_at ? (
            <Card className="p-5">
              <h2 className="mb-3 font-semibold">Status</h2>
              <StatusForm key={lead.status} leadId={lead.id} current={lead.status} statuses={statuses.filter((s) => s.is_active)} />
            </Card>
          ) : null}

          <FollowUpList
            leadId={lead.id}
            canAct={canAct && !lead.archived_at && !blocked}
            timeZone={settings.default_timezone}
            followUps={((followUps.data ?? []) as FollowUp[]).map((f) => ({
              ...f,
              dueLabel: formatDateTime(f.due_at, settings.default_timezone),
              relative: relativeTime(f.due_at),
              owner: f.owner_id ? name(f.owner_id, 'a volunteer') : null,
            }))}
          />

          {staff && !lead.archived_at ? (
            <AssignBox
              leadId={lead.id}
              currentAssignee={lead.assigned_to}
              blocked={blocked}
              registered={lead.status === 'registered' || lead.status === 'converted'}
              volunteers={profiles
                .filter((p) => p.role === 'volunteer' && p.status === 'active')
                .map((p) => ({ id: p.id, name: p.full_name || p.email || 'Volunteer' }))}
            />
          ) : null}

          <Card>
            <CardHeader title="Assignment history" />
            {(assignments.data as LeadAssignment[] | null)?.length ? (
              <ol className="divide-y divide-line text-sm">
                {(assignments.data as LeadAssignment[]).map((a) => (
                  <li key={a.id} className="px-5 py-3">
                    <p className="font-medium">
                      {name(a.assignee_id, 'Another volunteer')}
                      {!a.ended_at ? <Badge tone="info" className="ml-2">Current</Badge> : null}
                    </p>
                    <p className="text-ink-muted">
                      {formatDateTime(a.assigned_at, settings.default_timezone)} · {a.kind === 'auto_reassign' ? 'auto-reassigned' : a.kind === 'auto_assign' ? 'auto-assigned' : `by ${name(a.assigned_by)}`}
                    </p>
                    <p className="text-ink-muted">
                      {a.first_contact_at
                        ? `First call ${formatDateTime(a.first_contact_at, settings.default_timezone)}`
                        : a.ended_at
                          ? 'Not called'
                          : `Call by ${formatDateTime(a.contact_deadline_at, settings.default_timezone)}`}
                    </p>
                    {a.end_reason ? <p className="text-ink-muted">Ended: {ASSIGNMENT_END_REASON_LABELS[a.end_reason]}</p> : null}
                    {a.note ? <p className="mt-1">“{a.note}”</p> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState title="Never assigned" />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
