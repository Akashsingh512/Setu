'use client';
import { useState, useTransition } from 'react';
import { DV_PERMISSION_INFO, DV_PERMISSIONS, type DvPermission } from '@crm/shared';
import { Button } from '@/components/ui';
import { setOperatorPermissions } from '../actions';

export function OperatorRow({ profileId, name, role, granted }: { profileId: string; name: string; role: string; granted: DvPermission[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(new Set(granted));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = selected.size !== granted.length || granted.some((g) => !selected.has(g));

  const toggle = (p: DvPermission) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{name}</p>
          <p className="text-xs text-ink-muted">
            {role} · {granted.length ? `${granted.length} permission${granted.length === 1 ? '' : 's'}` : 'no access'}
          </p>
        </div>
        <Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close' : granted.length ? 'Edit access' : 'Give access'}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {DV_PERMISSIONS.map((p) => (
              <label key={p} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-accent" checked={selected.has(p)} onChange={() => toggle(p)} />
                <span>
                  {DV_PERMISSION_INFO[p].label}
                  <span className="block text-xs text-ink-muted">{DV_PERMISSION_INFO[p].description}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!dirty || pending}
              onClick={() =>
                start(async () => {
                  const r = await setOperatorPermissions(profileId, [...selected]);
                  setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? 'Saved.' });
                })
              }
            >
              {pending ? 'Saving…' : 'Save access'}
            </Button>
            {selected.size ? (
              <button type="button" className="text-ink-muted hover:text-ink" onClick={() => setSelected(new Set())}>
                Remove all
              </button>
            ) : null}
            {msg ? <span className={msg.ok ? 'text-ok' : 'text-danger'}>{msg.text}</span> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
