import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, CardHeader } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { getCourses, getStatuses } from '@/lib/data';
import { requireDv } from '@/lib/dv';
import { formatDateTime } from '@/lib/format';
import { signPosters } from '@/lib/posters';
import { createClient } from '@/lib/supabase/server';
import { EnrollmentControls } from '../controls';
import { JOURNEY_STATUS } from '../status';
import { JourneyEditor } from '../editor';

export const metadata: Metadata = { title: 'Journey' };

type Step = {
  position: number;
  kind: 'message' | 'call_task' | 'program_invite';
  delay_days: number;
  send_time: string;
  body: string | null;
  poster_path: string | null;
  course_id: string | null;
};
type Person = {
  id: string;
  status: string;
  status_reason: string | null;
  next_position: number;
  next_at: string | null;
  started_at: string;
  last_reply_at: string | null;
  lead: { id: string; full_name: string; lead_code: string } | null;
};

export default async function JourneyPage({ params }: { params: Promise<{ id: string }> }) {
  await requireDv('schedule_announcements');
  const { id } = await params;
  const supabase = await createClient();
  const [settings, statuses, courses, { data: j }, { data: steps }, { data: people }] = await Promise.all([
    getOrgSettings(),
    getStatuses(),
    getCourses(),
    supabase.from('dv_journeys').select('*').eq('id', id).maybeSingle(),
    supabase.from('dv_journey_steps').select('position, kind, delay_days, send_time, body, poster_path, course_id').eq('journey_id', id).order('position'),
    supabase
      .from('dv_journey_enrollments')
      .select('id, status, status_reason, next_position, next_at, started_at, last_reply_at, lead:leads(id, full_name, lead_code)')
      .eq('journey_id', id)
      .order('started_at', { ascending: false })
      .limit(300),
  ]);
  if (!j) notFound();
  const posters = await signPosters(
    supabase,
    ((steps ?? []) as Step[]).map((s) => s.poster_path),
  );
  const tz = settings.default_timezone;
  const total = (steps ?? []).length;

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/digital-volunteer/journeys" className="text-accent hover:underline">
          ← All journeys
        </Link>
      </p>
      <JourneyEditor
        id={j.id as string}
        initial={{
          name: j.name as string,
          description: (j.description as string | null) ?? '',
          active: j.active as boolean,
          ai_auto_reply: j.ai_auto_reply as boolean,
          forward_replies: j.forward_replies as boolean,
          pause_on_reply: j.pause_on_reply as boolean,
          resume_after_hours: j.resume_after_hours as number,
          stop_statuses: (j.stop_statuses as string[]) ?? [],
        }}
        initialSteps={((steps ?? []) as Step[]).map((s) => ({
          kind: s.kind,
          delay_days: s.delay_days,
          send_time: s.send_time.slice(0, 5),
          body: s.body ?? '',
          poster_path: s.poster_path,
          course_id: s.course_id,
          posterUrl: s.poster_path ? (posters[s.poster_path] ?? null) : null,
        }))}
        statuses={statuses.filter((s) => s.is_active && !s.blocks_contact).map((s) => ({ id: s.code, label: s.label }))}
        courses={courses.map((c) => ({ id: c.id, label: c.name }))}
      />

      <Card>
        <CardHeader title={`People (${(people ?? []).length})`} description="Start people from Leads: tick them, then Start journey." />
        {(people ?? []).length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink-muted">Nobody yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {((people ?? []) as unknown as Person[]).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-56 flex-1">
                  {p.lead ? (
                    <Link href={`/leads/${p.lead.id}`} className="font-medium hover:underline">
                      {p.lead.full_name}
                    </Link>
                  ) : (
                    '—'
                  )}{' '}
                  <span className="text-xs text-ink-muted">{p.lead?.lead_code}</span>{' '}
                  <Badge tone={JOURNEY_STATUS[p.status]?.tone ?? 'neutral'}>{JOURNEY_STATUS[p.status]?.label ?? p.status}</Badge>
                  <p className="text-xs text-ink-muted">
                    Started {formatDateTime(p.started_at, tz)}
                    {p.status === 'active' && p.next_at ? ` · step ${Math.min(p.next_position, total)} of ${total} around ${formatDateTime(p.next_at, tz)}` : ''}
                    {p.last_reply_at ? ` · last replied ${formatDateTime(p.last_reply_at, tz)}` : ''}
                    {p.status_reason ? ` · ${p.status_reason}` : ''}
                  </p>
                </div>
                <EnrollmentControls id={p.id} status={p.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
