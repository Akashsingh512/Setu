'use client';
import { useState, useTransition } from 'react';
import { DV_MODE_LABELS, type DvMode } from '@crm/shared';
import { FormMessage, type ActionState } from '@/components/form';
import { Button, Field, Input, Select } from '@/components/ui';
import { requestCommand, saveGroup } from '../actions';

export interface GroupSettings {
  id: string;
  enabled: boolean;
  mode: DvMode;
  allow_read: boolean;
  allow_course_info: boolean;
  allow_seva_requests: boolean;
  allow_lead_assignment: boolean;
  allow_announcements: boolean;
  allow_media: boolean;
  responsible_admin_id: string | null;
  max_leads_per_request: number | null;
}

const PERMS: { key: keyof GroupSettings; label: string; hint: string }[] = [
  { key: 'allow_read', label: 'Read messages', hint: 'Needed for everything below except announcements' },
  { key: 'allow_course_info', label: 'Answer course questions', hint: 'Dates, venue, timings, registration link' },
  { key: 'allow_seva_requests', label: 'Accept seva requests', hint: '"I want to do seva, share numbers"' },
  { key: 'allow_lead_assignment', label: 'Assign lead numbers', hint: 'Numbers go privately to the verified volunteer, never into the group' },
  { key: 'allow_announcements', label: 'Scheduled announcements', hint: 'Post approved announcements here' },
  { key: 'allow_media', label: 'Posters and links', hint: 'Allow images and registration links in posts' },
];

export function GroupEditor({ group, admins, canEdit }: { group: GroupSettings; admins: { id: string; name: string }[]; canEdit: boolean }) {
  const [g, setG] = useState(group);
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  const set = <K extends keyof GroupSettings>(k: K, v: GroupSettings[K]) => setG((s) => ({ ...s, [k]: v }));
  const dirty = JSON.stringify(g) !== JSON.stringify(group);

  return (
    <div className="space-y-4 p-5 text-sm">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" className="size-4 accent-accent" checked={g.enabled} disabled={!canEdit} onChange={(e) => set('enabled', e.target.checked)} />
        Enable Digital Volunteer in this group
      </label>

      <fieldset disabled={!canEdit || !g.enabled} className="space-y-4 disabled:opacity-60">
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {PERMS.map((p) => (
            <label key={p.key} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-accent"
                checked={g[p.key] as boolean}
                disabled={p.key !== 'allow_read' && p.key !== 'allow_announcements' && p.key !== 'allow_media' && !g.allow_read}
                onChange={(e) => set(p.key, e.target.checked as never)}
              />
              <span>
                {p.label}
                <span className="block text-xs text-ink-muted">{p.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Reply mode" htmlFor={`mode-${g.id}`}>
            <Select id={`mode-${g.id}`} value={g.mode} onChange={(e) => set('mode', e.target.value as DvMode)}>
              {(Object.keys(DV_MODE_LABELS) as DvMode[]).map((m) => (
                <option key={m} value={m}>
                  {DV_MODE_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Responsible admin" htmlFor={`admin-${g.id}`}>
            <Select id={`admin-${g.id}`} value={g.responsible_admin_id ?? ''} onChange={(e) => set('responsible_admin_id', e.target.value || null)}>
              <option value="">Not set</option>
              {admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Max leads per seva request" htmlFor={`max-${g.id}`} hint="Blank = use the person's own limit">
            <Input
              id={`max-${g.id}`}
              type="number"
              min={1}
              max={50}
              value={g.max_leads_per_request ?? ''}
              onChange={(e) => set('max_leads_per_request', e.target.value ? Math.min(50, Math.max(1, Number(e.target.value))) : null)}
            />
          </Field>
        </div>
      </fieldset>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button disabled={!dirty || pending} onClick={() => start(async () => setState(await saveGroup(g)))}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          {dirty ? (
            <button type="button" className="text-ink-muted hover:text-ink" onClick={() => setG(group)}>
              Undo changes
            </button>
          ) : null}
          <FormMessage state={state} />
        </div>
      ) : null}
    </div>
  );
}

export function RefreshGroupsButton() {
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3">
      {state?.message ? <span className="text-sm text-ink-muted">{state.message}</span> : null}
      {state?.error ? <span className="text-sm text-danger">{state.error}</span> : null}
      <Button variant="secondary" disabled={pending} onClick={() => start(async () => setState(await requestCommand('sync_groups')))}>
        Refresh groups
      </Button>
    </div>
  );
}
