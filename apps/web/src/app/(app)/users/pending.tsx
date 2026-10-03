'use client';
import { useState, useTransition } from 'react';
import { Alert, Button, Card, CardHeader, Select } from '@/components/ui';
import { reviewRegistration } from './actions';

export interface PendingRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  recommendedBy: string | null;
  teamId: string | null;
  registeredAt: string;
}

/** Registrations awaiting approval. Super admins pick the team; teachers approve into their own. */
export function PendingRegistrations({ rows, teams, isSuperAdmin }: { rows: PendingRow[]; teams: { id: string; name: string }[]; isSuperAdmin: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [teamFor, setTeamFor] = useState<Record<string, string>>({});

  if (rows.length === 0 && !msg) return null;

  const review = (id: string, approve: boolean, name: string) => {
    if (!approve && !confirm(`Reject ${name}'s registration?`)) return;
    start(async () => {
      const r = await reviewRegistration(id, approve, teamFor[id]);
      setMsg(r.error ? { text: r.error } : { ok: true, text: `${name}: ${r.message}` });
    });
  };

  return (
    <Card className="mb-6 border-accent/30">
      <CardHeader title={`Pending registrations (${rows.length})`} description="New volunteers who registered themselves. They have no access until approved." />
      {msg ? (
        <div className="px-5 pt-4">
          <Alert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Alert>
        </div>
      ) : null}
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{r.name}</p>
              <p className="text-ink-muted">
                {r.email}
                {r.phone ? ` · ${r.phone}` : ''}
              </p>
              <p className="text-ink-muted">
                Recommended by: {r.recommendedBy ?? 'No teacher selected'} · registered {r.registeredAt}
              </p>
            </div>
            {isSuperAdmin ? (
              <Select
                aria-label={`Team for ${r.name}`}
                className="min-h-9 w-auto py-1"
                value={teamFor[r.id] ?? r.teamId ?? ''}
                onChange={(e) => setTeamFor((t) => ({ ...t, [r.id]: e.target.value }))}
              >
                <option value="" disabled>
                  Choose team…
                </option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <div className="flex gap-2">
              <Button
                className="min-h-9"
                disabled={pending || (isSuperAdmin && !(teamFor[r.id] ?? r.teamId))}
                onClick={() => review(r.id, true, r.name)}
              >
                Approve
              </Button>
              <Button variant="danger" className="min-h-9" disabled={pending} onClick={() => review(r.id, false, r.name)}>
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
