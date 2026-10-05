'use client';
import { useState, useTransition } from 'react';
import { DEFAULT_FEATURES, FEATURE_INFO, FEATURES, type Feature } from '@crm/shared';
import { Alert, Badge, Button, Card, cn } from '@/components/ui';
import { setRoleFeature } from './actions';

type RoleKey = 'teacher' | 'volunteer';
const ROLES: { key: RoleKey; label: string }[] = [
  { key: 'teacher', label: 'Teachers' },
  { key: 'volunteer', label: 'Volunteers' },
];
const GROUPS = [...new Set(FEATURES.map((f) => FEATURE_INFO[f].group))];

export function AccessMatrix({ teacher, volunteer }: { teacher: Feature[]; volunteer: Feature[] }) {
  const [on, setOn] = useState<Record<RoleKey, Set<Feature>>>({ teacher: new Set(teacher), volunteer: new Set(volunteer) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  function apply(role: RoleKey, feature: Feature, enabled: boolean) {
    const info = FEATURE_INFO[feature];
    if (enabled && role === 'volunteer' && info.teamWide) {
      const ok = confirm(
        `"${info.label}" lets volunteers see the leads of their whole team, not only their own. Switch it on for all volunteers?`,
      );
      if (!ok) return;
    }
    if (!enabled && feature === 'team_leads') {
      const ok = confirm(
        `${role === 'teacher' ? 'Teachers' : 'Volunteers'} will only see the leads assigned to them. Importing, editing and assigning leads stop working for them. Continue?`,
      );
      if (!ok) return;
    }
    setError(null);
    setBusy(`${role}:${feature}`);
    const before = on[role];
    setOn((s) => {
      const next = new Set(s[role]);
      if (enabled) next.add(feature);
      else next.delete(feature);
      return { ...s, [role]: next };
    });
    start(async () => {
      const r = await setRoleFeature(role, feature, enabled);
      if (r.error) {
        setError(r.error);
        setOn((s) => ({ ...s, [role]: before }));
      }
      setBusy(null);
    });
  }

  function reset(role: RoleKey) {
    if (!confirm(`Put ${role === 'teacher' ? 'teachers' : 'volunteers'} back to the standard features?`)) return;
    for (const f of FEATURES) {
      const want = DEFAULT_FEATURES[role].includes(f);
      if (on[role].has(f) !== want) {
        setOn((s) => {
          const next = new Set(s[role]);
          if (want) next.add(f);
          else next.delete(f);
          return { ...s, [role]: next };
        });
        start(async () => {
          const r = await setRoleFeature(role, f, want);
          if (r.error) setError(r.error);
        });
      }
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {error ? <Alert>{error}</Alert> : null}
      {GROUPS.map((group) => (
        <Card key={group} className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-line text-left text-ink-muted">
              <tr>
                <th className="px-5 py-3 font-semibold text-ink">{group}</th>
                {ROLES.map((r) => (
                  <th key={r.key} className="w-32 px-3 py-3 text-center font-medium">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {FEATURES.filter((f) => FEATURE_INFO[f].group === group).map((f) => {
                const info = FEATURE_INFO[f];
                return (
                  <tr key={f}>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{info.label}</span>
                        {info.teamWide ? <Badge tone="warn">Shows the whole team&apos;s leads</Badge> : null}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">{info.description}</p>
                    </td>
                    {ROLES.map((r) => {
                      const checked = on[r.key].has(f);
                      const blocked = info.needsTeamLeads && !on[r.key].has('team_leads');
                      return (
                        <td key={r.key} className="px-3 py-3 text-center">
                          <label className={cn('inline-flex cursor-pointer flex-col items-center gap-1', blocked && 'cursor-not-allowed opacity-60')}>
                            <input
                              type="checkbox"
                              className="size-5 accent-accent"
                              checked={checked && !blocked}
                              disabled={blocked || busy === `${r.key}:${f}`}
                              onChange={(e) => apply(r.key, f, e.target.checked)}
                              aria-label={`${info.label} for ${r.label}`}
                            />
                            {blocked ? <span className="text-xs text-ink-muted">Needs team&apos;s leads</span> : null}
                          </label>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <span>Undo all changes for a role:</span>
        {ROLES.map((r) => (
          <Button key={r.key} variant="secondary" className="min-h-9 px-3" onClick={() => reset(r.key)}>
            Standard for {r.label.toLowerCase()}
          </Button>
        ))}
      </div>
      <p className="text-xs text-ink-muted">
        Digital Volunteer access is given per person, in Digital Volunteer → Operators. Teachers / Users, Feature access and Settings stay with super
        admins.
      </p>
    </div>
  );
}
