'use client';
import { useActionState, useState, useTransition } from 'react';
import { ROLE_LABELS, ROLES, type Role } from '@crm/shared';
import { FormMessage, SubmitButton } from '@/components/form';
import { PasswordInput } from '@/components/password-input';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select } from '@/components/ui';
import { createTeam, createUser, setUserActive, updateUserSettings } from './actions';

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  status: 'active' | 'inactive';
  team_id: string | null;
  teamName: string | null;
  accepting_leads: boolean;
  max_open_leads: number | null;
  openLeads: number;
  lastLogin: string | null;
}

export function CreateUserForm({ mode, teams, myTeamId }: { mode: 'volunteers' | 'users'; teams: { id: string; name: string }[]; myTeamId: string | null }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(createUser, undefined);
  const [role, setRole] = useState<Role>('volunteer');

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen(true)}>{mode === 'volunteers' ? 'Add volunteer' : 'Add user'}</Button>
        {state?.ok ? <span className="text-sm text-ok">{state.message}</span> : null}
      </div>
    );
  }
  return (
    <Card className="p-5">
      <form action={action} className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormMessage state={state} />
        </div>
        <Field label="Full name *" htmlFor="u-name">
          <Input id="u-name" name="full_name" required />
        </Field>
        <Field label="Email *" htmlFor="u-email">
          <Input id="u-email" name="email" type="email" required autoComplete="off" />
        </Field>
        <Field label="Phone" htmlFor="u-phone">
          <Input id="u-phone" name="phone" type="tel" />
        </Field>
        <Field label="Temporary password *" htmlFor="u-pass" hint="8+ characters with letters and numbers. They can change it via 'Forgot password'.">
          <PasswordInput id="u-pass" name="password" required autoComplete="new-password" />
        </Field>
        {mode === 'users' ? (
          <Field label="Role *" htmlFor="u-role">
            <Select id="u-role" name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <input type="hidden" name="role" value="volunteer" />
        )}
        {mode === 'users' && role !== 'super_admin' ? (
          <Field label="Team *" htmlFor="u-team">
            <Select id="u-team" name="team_id" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : mode === 'volunteers' ? (
          myTeamId ? (
            <input type="hidden" name="team_id" value={myTeamId} />
          ) : (
            <Field label="Team *" htmlFor="u-team">
              <Select id="u-team" name="team_id" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )
        ) : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <SubmitButton pendingText="Creating…">Create account</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

export function UserTable({
  rows,
  mode,
  teams,
  currentUserId,
}: {
  rows: UserRow[];
  mode: 'volunteers' | 'users';
  teams: { id: string; name: string }[];
  currentUserId: string;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok?: boolean; text: string } | null>(null);

  const run = (fn: () => Promise<{ ok?: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { text: r.error } : { ok: true, text: r.message ?? 'Saved.' });
    });

  return (
    <>
      {msg ? (
        <div className="mb-3">
          <Alert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Alert>
        </div>
      ) : null}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-line text-left text-ink-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              {mode === 'users' ? <th className="px-2 py-3 font-medium">Role</th> : null}
              <th className="px-2 py-3 font-medium">Team</th>
              <th className="px-2 py-3 font-medium">Open leads</th>
              <th className="px-2 py-3 font-medium">Availability</th>
              <th className="px-2 py-3 font-medium">Last sign-in</th>
              <th className="px-4 py-3 text-right font-medium">Account</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((u) => (
              <tr key={u.id} className={u.status === 'inactive' ? 'text-ink-muted' : undefined}>
                <td className="px-4 py-3">
                  <p className="font-medium">{u.name}</p>
                  <p className="text-xs text-ink-muted">
                    {u.email}
                    {u.phone ? ` · ${u.phone}` : ''}
                  </p>
                </td>
                {mode === 'users' ? (
                  <td className="px-2 py-3">
                    <Select
                      aria-label={`Role for ${u.name}`}
                      defaultValue={u.role}
                      disabled={pending || u.id === currentUserId}
                      onChange={(e) => {
                        const role = e.target.value as Role;
                        if (confirm(`Change ${u.name}'s role to ${ROLE_LABELS[role]}?`)) run(() => updateUserSettings(u.id, { role }));
                        else e.target.value = u.role;
                      }}
                      className="min-h-9 py-1"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                ) : null}
                <td className="px-2 py-3">
                  {mode === 'users' && u.role !== 'super_admin' ? (
                    <Select
                      aria-label={`Team for ${u.name}`}
                      defaultValue={u.team_id ?? ''}
                      disabled={pending}
                      onChange={(e) => run(() => updateUserSettings(u.id, { team_id: e.target.value }))}
                      className="min-h-9 py-1"
                    >
                      <option value="" disabled>
                        No team
                      </option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    (u.teamName ?? '—')
                  )}
                </td>
                <td className="px-2 py-3 tabular-nums">{u.role === 'volunteer' ? u.openLeads : '—'}</td>
                <td className="px-2 py-3">
                  {u.role === 'volunteer' ? (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        defaultChecked={u.accepting_leads}
                        disabled={pending || u.status === 'inactive'}
                        onChange={(e) => run(() => updateUserSettings(u.id, { accepting_leads: e.target.checked }))}
                      />
                      <span>Accepting leads</span>
                    </label>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-2 py-3 text-ink-muted">{u.lastLogin ?? 'Never'}</td>
                <td className="px-4 py-3 text-right">
                  {u.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge tone="danger">Inactive</Badge>}{' '}
                  {u.id !== currentUserId ? (
                    <button
                      type="button"
                      className="ml-2 text-sm text-ink-muted underline hover:text-ink disabled:opacity-50"
                      disabled={pending}
                      onClick={() => {
                        const activate = u.status !== 'active';
                        if (confirm(activate ? `Reactivate ${u.name}?` : `Deactivate ${u.name}? They will lose access immediately and receive no new leads.`)) {
                          run(() => setUserActive(u.id, activate));
                        }
                      }}
                    >
                      {u.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

export function TeamsCard({ teams }: { teams: { id: string; name: string }[] }) {
  const [state, action] = useActionState(createTeam, undefined);
  return (
    <Card>
      <CardHeader title="Teams" description="Every teacher and volunteer belongs to one team. Leads belong to a team." />
      <div className="flex flex-wrap gap-2 px-5 pt-4">
        {teams.length ? teams.map((t) => <Badge key={t.id}>{t.name}</Badge>) : <span className="text-sm text-ink-muted">No teams yet.</span>}
      </div>
      <form action={action} className="flex flex-wrap items-start gap-2 p-5">
        <Input name="name" placeholder="New team name" aria-label="New team name" className="max-w-xs" required />
        <SubmitButton variant="secondary">Add team</SubmitButton>
        <div className="w-full">
          <FormMessage state={state} />
        </div>
      </form>
    </Card>
  );
}
