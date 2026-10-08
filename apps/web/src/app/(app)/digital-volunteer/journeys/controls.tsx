'use client';
import { useState, useTransition } from 'react';
import { Alert, Button, Select } from '@/components/ui';
import { controlJourney, startJourney } from '../journey-actions';

/** Pause / resume / stop one person's journey. */
export function EnrollmentControls({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (action: 'pause' | 'resume' | 'stop', question?: string) => {
    if (question && !confirm(question)) return;
    start(async () => setError((await controlJourney(id, action)).error ?? null));
  };
  if (status !== 'active' && status !== 'paused') return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {status === 'paused' ? (
        <Button variant="secondary" className="min-h-8 px-2.5 text-xs" disabled={pending} onClick={() => act('resume')}>
          Resume
        </Button>
      ) : (
        <Button variant="secondary" className="min-h-8 px-2.5 text-xs" disabled={pending} onClick={() => act('pause')}>
          Pause
        </Button>
      )}
      <Button variant="ghost" className="min-h-8 px-2.5 text-xs text-danger" disabled={pending} onClick={() => act('stop', 'Stop this journey for this person?')}>
        Stop
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </span>
  );
}

/** Start one or more leads on a journey (lead page, leads list). */
export function StartJourney({
  journeys,
  leadIds,
  resolveIds,
  onDone,
}: {
  journeys: { id: string; name: string }[];
  leadIds?: string[];
  /** For "all matching" selections: the ids are looked up when starting. */
  resolveIds?: () => Promise<string[]>;
  onDone?: (message: string) => void;
}) {
  const [journey, setJourney] = useState('');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok?: boolean; text: string } | null>(null);
  if (!journeys.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={journey} onChange={(e) => setJourney(e.target.value)} aria-label="Journey" className="max-w-64">
          <option value="">Choose a journey…</option>
          {journeys.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </Select>
        <Button
          disabled={!journey || pending}
          onClick={() =>
            start(async () => {
              const ids = resolveIds ? await resolveIds() : (leadIds ?? []);
              const r = await startJourney(journey, ids);
              setResult(r.error ? { text: r.error } : { ok: true, text: r.message ?? 'Started.' });
              if (r.ok) onDone?.(r.message ?? 'Started.');
            })
          }
        >
          {pending ? 'Starting…' : 'Start journey'}
        </Button>
      </div>
      {result && !onDone ? <Alert tone={result.ok ? 'ok' : 'danger'}>{result.text}</Alert> : null}
      {result && onDone && !result.ok ? <Alert>{result.text}</Alert> : null}
    </div>
  );
}
