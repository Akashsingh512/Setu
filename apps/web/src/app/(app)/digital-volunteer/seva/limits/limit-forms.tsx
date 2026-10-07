'use client';
import { useState, useTransition } from 'react';
import { FormMessage, type ActionState } from '@/components/form';
import { Badge, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { saveAllotMessages, saveSevaLimit, saveSevaSettings, setLeadAllotter, setWhatsAppApprover } from '../../seva-actions';

const toNum = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const show = (v: number | null) => (v === null ? '' : String(v));

export function DefaultsForm({ perRequest, maxActive, daily, weekly }: { perRequest: number; maxActive: number | null; daily: number | null; weekly: number | null }) {
  const [v, setV] = useState({ perRequest: String(perRequest), maxActive: show(maxActive), daily: show(daily), weekly: show(weekly) });
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Leads per request" htmlFor="d-per" hint="1 to 50">
          <Input id="d-per" type="number" min={1} max={50} value={v.perRequest} onChange={set('perRequest')} />
        </Field>
        <Field label="Max open leads" htmlFor="d-max" hint="Most they can hold at once">
          <Input id="d-max" type="number" min={1} value={v.maxActive} onChange={set('maxActive')} placeholder="No limit" />
        </Field>
        <Field label="Per day" htmlFor="d-day" hint="Leads given by seva per day">
          <Input id="d-day" type="number" min={1} value={v.daily} onChange={set('daily')} placeholder="No limit" />
        </Field>
        <Field label="Per week" htmlFor="d-week">
          <Input id="d-week" type="number" min={1} value={v.weekly} onChange={set('weekly')} placeholder="No limit" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          disabled={pending}
          onClick={() => start(async () => setState(await saveSevaSettings({ perRequest: Number(v.perRequest), maxActive: toNum(v.maxActive), daily: toNum(v.daily), weekly: toNum(v.weekly) })))}
        >
          {pending ? 'Saving…' : 'Save defaults'}
        </Button>
        <FormMessage state={state} />
      </div>
    </div>
  );
}

export interface LimitRow {
  profileId: string;
  name: string;
  team: string | null;
  perRequest: number | null;
  maxActive: number | null;
  daily: number | null;
  weekly: number | null;
  exceptionPerRequest: number | null;
  exceptionDaysLeft: number | null;
  note: string;
}

export function VolunteerLimitRow({ row }: { row: LimitRow }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({
    perRequest: show(row.perRequest),
    maxActive: show(row.maxActive),
    daily: show(row.daily),
    weekly: show(row.weekly),
    exceptionPerRequest: show(row.exceptionPerRequest),
    exceptionDays: show(row.exceptionDaysLeft),
    note: row.note,
  });
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const exceptionLabel = row.exceptionPerRequest && row.exceptionDaysLeft ? `up to ${row.exceptionPerRequest} for ${row.exceptionDaysLeft} more day(s)` : null;
  const custom = [row.perRequest && `${row.perRequest}/request`, row.maxActive && `max ${row.maxActive} open`, row.daily && `${row.daily}/day`, row.weekly && `${row.weekly}/week`].filter(Boolean);

  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">
            {row.name} {row.team ? <span className="font-normal text-ink-muted">· {row.team}</span> : null}
          </p>
          <p className="text-xs text-ink-muted">
            {custom.length || exceptionLabel ? custom.join(' · ') : 'Uses the defaults'}
            {exceptionLabel ? <Badge tone="accent" className="ml-2">Exception: {exceptionLabel}</Badge> : null}
          </p>
        </div>
        <Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close' : 'Edit'}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Per request" htmlFor={`p-${row.profileId}`}>
              <Input id={`p-${row.profileId}`} type="number" min={1} max={50} value={v.perRequest} onChange={set('perRequest')} placeholder="Default" />
            </Field>
            <Field label="Max open leads" htmlFor={`m-${row.profileId}`}>
              <Input id={`m-${row.profileId}`} type="number" min={1} value={v.maxActive} onChange={set('maxActive')} placeholder="Default" />
            </Field>
            <Field label="Per day" htmlFor={`d-${row.profileId}`}>
              <Input id={`d-${row.profileId}`} type="number" min={1} value={v.daily} onChange={set('daily')} placeholder="Default" />
            </Field>
            <Field label="Per week" htmlFor={`w-${row.profileId}`}>
              <Input id={`w-${row.profileId}`} type="number" min={1} value={v.weekly} onChange={set('weekly')} placeholder="Default" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Temporary exception: leads per request" htmlFor={`xe-${row.profileId}`} hint="Replaces the per-request limit for a while">
              <Input id={`xe-${row.profileId}`} type="number" min={1} max={50} value={v.exceptionPerRequest} onChange={set('exceptionPerRequest')} placeholder="None" />
            </Field>
            <Field label="…for how many days" htmlFor={`xd-${row.profileId}`} hint="1 to 31 days from now">
              <Input id={`xd-${row.profileId}`} type="number" min={1} max={31} value={v.exceptionDays} onChange={set('exceptionDays')} placeholder="None" />
            </Field>
            <Field label="Note" htmlFor={`n-${row.profileId}`}>
              <Input id={`n-${row.profileId}`} value={v.note} onChange={set('note')} maxLength={300} placeholder="Why" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending}
              onClick={() =>
                start(async () =>
                  setState(
                    await saveSevaLimit({
                      profileId: row.profileId,
                      perRequest: toNum(v.perRequest),
                      maxActive: toNum(v.maxActive),
                      daily: toNum(v.daily),
                      weekly: toNum(v.weekly),
                      exceptionPerRequest: toNum(v.exceptionPerRequest),
                      exceptionDays: toNum(v.exceptionDays),
                      note: v.note,
                    }),
                  ),
                )
              }
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <p className="text-xs text-ink-muted">Saving replaces this person&apos;s settings. Empty the exception boxes to remove an exception.</p>
            <FormMessage state={state} />
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function ApproverToggle({ id, name, hasPhone, canApprove, on }: { id: string; name: string; hasPhone: boolean; canApprove: boolean; on: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const blocked = !on && (!hasPhone || !canApprove);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
      <div>
        <p className="font-medium">
          {name} {on ? <Badge tone="ok">Gets WhatsApp approvals</Badge> : null}
        </p>
        <p className="text-xs text-ink-muted">
          {!canApprove ? 'No longer has the Assign seva leads permission' : !hasPhone ? 'No phone number saved in Setu' : on ? 'Replies YES / NO on WhatsApp' : 'Approves in Setu only'}
        </p>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
      <Button
        variant={on ? 'secondary' : 'primary'}
        disabled={pending || blocked}
        onClick={() =>
          start(async () => {
            const r = await setWhatsAppApprover(id, !on);
            setError(r.error ?? null);
          })
        }
      >
        {on ? 'Stop' : 'Send approvals on WhatsApp'}
      </Button>
    </li>
  );
}

export type AllotterCandidate = { id: string; full_name: string; role: string; has_phone: boolean; is_allotter: boolean };

/** Super admins: who may allot leads to others by WhatsApp ("Allot 5 leads to Srikesh"). */
export function LeadAllotters({ people }: { people: AllotterCandidate[] }) {
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const current = people.filter((p) => p.is_allotter);
  const others = people.filter((p) => !p.is_allotter);
  const set = (id: string, enabled: boolean) =>
    start(async () => {
      const r = await setLeadAllotter(id, enabled);
      setError(r.error ?? null);
      if (r.ok) setPick('');
    });

  return (
    <div className="flex flex-col">
      {current.length ? (
        <ul className="divide-y divide-line">
          {current.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div>
                <p className="font-medium">
                  {p.full_name} <Badge tone="ok">Can allot</Badge>
                </p>
                <p className="text-xs text-ink-muted">{p.has_phone ? 'Writes from the phone number saved in Setu' : 'No phone number saved: messages cannot be recognised'}</p>
              </div>
              <Button variant="secondary" disabled={pending} onClick={() => set(p.id, false)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-ink-muted">Nobody can allot leads by WhatsApp yet.</p>
      )}
      <div className="flex flex-wrap items-end gap-2 border-t border-line px-5 py-4">
        <Field label="Add someone" htmlFor="allotter-pick" className="min-w-64 flex-1">
          <Select id="allotter-pick" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose a person…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.has_phone}>
                {p.full_name}
                {p.has_phone ? '' : ' (no phone number)'}
              </option>
            ))}
          </Select>
        </Field>
        <Button disabled={pending || !pick} onClick={() => set(pick, true)}>
          Add
        </Button>
      </div>
      {error ? <p className="px-5 pb-4 text-sm text-danger">{error}</p> : null}
    </div>
  );
}

const ALLOT_PLACEHOLDERS = ['{{name}}', '{{allotter}}', '{{count}}', '{{leads}}', '{{hours}}', '{{example_code}}'];
const WELCOME_PLACEHOLDERS = [...ALLOT_PLACEHOLDERS, '{{app_url}}', '{{mobile}}', '{{password}}'];

/** The WhatsApp messages sent with allotted leads, editable with placeholders. */
export function AllotMessages({
  allot,
  welcome,
  defaults,
}: {
  allot: string | null;
  welcome: string | null;
  defaults: { allot: string; welcome: string };
}) {
  const [a, setA] = useState(allot ?? defaults.allot);
  const [w, setW] = useState(welcome ?? defaults.welcome);
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  const chips = (list: string[], add: (p: string) => void) => (
    <p className="mt-1 flex flex-wrap gap-1 text-xs text-ink-muted">
      {list.map((p) => (
        <button key={p} type="button" className="rounded bg-canvas px-1.5 py-0.5 font-mono hover:text-ink" onClick={() => add(p)}>
          {p}
        </button>
      ))}
    </p>
  );
  return (
    <div className="flex flex-col gap-4 p-5">
      <FormMessage state={state} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="Leads allotted (someone already in Setu)" htmlFor="m-allot" hint="Must contain {{leads}}.">
          <Textarea id="m-allot" rows={12} value={a} maxLength={3000} onChange={(e) => setA(e.target.value)} className="font-mono text-xs" />
          {chips(ALLOT_PLACEHOLDERS, (p) => setA((v) => v + p))}
        </Field>
        <Field label="Welcome + leads (someone the bot just added)" htmlFor="m-welcome" hint="Must contain {{leads}}, {{mobile}} and {{password}}.">
          <Textarea id="m-welcome" rows={12} value={w} maxLength={3000} onChange={(e) => setW(e.target.value)} className="font-mono text-xs" />
          {chips(WELCOME_PLACEHOLDERS, (p) => setW((v) => v + p))}
        </Field>
      </div>
      <p className="text-xs text-ink-muted">
        {'{{name}}'} = their first name · {'{{allotter}}'} = who allotted · {'{{count}}'} = number of leads · {'{{leads}}'} = the list of leads ·{' '}
        {'{{hours}}'} = hours to call · {'{{example_code}}'} = the first lead code · {'{{app_url}}'} / {'{{mobile}}'} / {'{{password}}'} = how to sign in
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => start(async () => setState(await saveAllotMessages(a, w)))}>
          Save messages
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setA(defaults.allot);
            setW(defaults.welcome);
            start(async () => setState(await saveAllotMessages('', '')));
          }}
        >
          Back to the standard text
        </Button>
      </div>
    </div>
  );
}
