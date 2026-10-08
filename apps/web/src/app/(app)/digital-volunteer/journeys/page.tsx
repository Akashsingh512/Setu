import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, ButtonLink, Card, CardHeader, EmptyState } from '@/components/ui';
import { requireDv } from '@/lib/dv';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Journeys' };

type Journey = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  dv_journey_steps: { kind: string; delay_days: number; position: number }[];
};

const KIND: Record<string, string> = { message: 'message', call_task: 'call', program_invite: 'program invite' };

export default async function JourneysPage() {
  await requireDv('schedule_announcements');
  const supabase = await createClient();
  const [{ data: journeys, error }, { data: people }] = await Promise.all([
    supabase.from('dv_journeys').select('id, name, description, active, dv_journey_steps(kind, delay_days, position)').order('created_at', { ascending: false }),
    supabase.from('dv_journey_enrollments').select('journey_id, status'),
  ]);
  if (error) return <Alert>Run the latest database migration to use journeys.</Alert>;
  const counts = new Map<string, Record<string, number>>();
  for (const p of people ?? []) {
    const c = counts.get(p.journey_id as string) ?? {};
    c[p.status as string] = (c[p.status as string] ?? 0) + 1;
    counts.set(p.journey_id as string, c);
  }

  return (
    <Card>
      <CardHeader
        title="Follow-up journeys"
        description="Keep people connected after they meet the Art of Living: messages, calls by their volunteer and program invites over days and weeks. Start people from Leads (tick them, then Start journey) or from a lead's page."
        action={<ButtonLink href="/digital-volunteer/journeys/new">New journey</ButtonLink>}
      />
      {(journeys ?? []).length === 0 ? (
        <EmptyState title="No journeys yet" description="Create one, e.g. “After the Happiness Program”: Day 0 a welcome, Day 2 a call, Day 7 a program invite." />
      ) : (
        <ul className="divide-y divide-line">
          {((journeys ?? []) as Journey[]).map((j) => {
            const c = counts.get(j.id) ?? {};
            let day = 0;
            const path = [...j.dv_journey_steps]
              .sort((a, b) => a.position - b.position)
              .map((s) => `Day ${(day += s.delay_days)} ${KIND[s.kind] ?? s.kind}`)
              .join(' → ');
            return (
              <li key={j.id} className="flex flex-wrap items-center gap-4 px-5 py-4 text-sm">
                <div className="min-w-56 flex-1">
                  <Link href={`/digital-volunteer/journeys/${j.id}`} className="font-medium hover:underline">
                    {j.name}
                  </Link>{' '}
                  {j.active ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
                  {j.description ? <p className="text-xs text-ink-muted">{j.description}</p> : null}
                  <p className="mt-1 text-xs text-ink-muted">{path}</p>
                </div>
                <p className="text-xs text-ink-muted tabular-nums">
                  {c.active ?? 0} on it · {c.paused ?? 0} paused · {c.completed ?? 0} finished
                  {c.stopped ? ` · ${c.stopped} stopped` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
