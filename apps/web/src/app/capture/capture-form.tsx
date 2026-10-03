'use client';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { formatPhone, LEAD_SOURCE_LABELS, LEAD_SOURCES, normalizePhone } from '@crm/shared';
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { createClient } from '@/lib/supabase/client';
import {
  enqueueLead,
  isOnline,
  parseJson,
  rawContext,
  rawQueue,
  removeLead,
  retryLead,
  subscribeOnline,
  subscribeStore,
  syncOfflineLeads,
  type OfflineContext,
  type OfflineLead,
} from '@/lib/offline-leads';

const STATE: Record<OfflineLead['state'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting to send', tone: 'warn' },
  synced: { label: 'Sent', tone: 'ok' },
  duplicate: { label: 'Already in Setu', tone: 'neutral' },
  error: { label: 'Not sent', tone: 'danger' },
};

const noSubscribe = () => () => {};

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the device's timezone

export function CaptureForm() {
  // Everything here lives on the phone: read it straight from storage (and re-render when it changes).
  const ready = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const rawCtx = useSyncExternalStore(subscribeStore, rawContext, () => '');
  const rawItems = useSyncExternalStore(subscribeStore, rawQueue, () => '');
  const ctx = useMemo(() => parseJson<OfflineContext | null>(rawCtx, null), [rawCtx]);
  const items = useMemo(
    () =>
      parseJson<OfflineLead[]>(rawItems, [])
        .filter((i) => !ctx || i.ownerId === ctx.userId)
        .reverse(),
    [rawItems, ctx],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const sync = useCallback(() => void syncOfflineLeads(createClient()), []);

  // Send what is waiting now, and again whenever the internet comes back.
  useEffect(() => {
    sync();
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, [sync]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ctx) return;
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const errs: Record<string, string> = {};

    const name = text('full_name');
    if (!name) errs.full_name = 'Name is required';
    const phone = normalizePhone(text('phone'), ctx.phoneCountry);
    if (!phone.ok) errs.phone = phone.error;
    let whatsapp: string | null = null;
    if (text('whatsapp_phone')) {
      const wa = normalizePhone(text('whatsapp_phone'), ctx.phoneCountry);
      if (wa.ok) whatsapp = wa.e164;
      else errs.whatsapp_phone = wa.error;
    }
    const email = text('email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = 'Enter a valid email';
    if (ctx.role === 'super_admin' && !text('team_id')) errs.team_id = 'Choose a team';
    setErrors(errs);
    if (Object.keys(errs).length || !phone.ok) return;

    enqueueLead({
      ref: crypto.randomUUID(),
      ownerId: ctx.userId,
      assignToMe: ctx.role === 'volunteer' && f.get('assign_to_me') === 'on',
      lead: {
        full_name: name,
        phone: phone.e164,
        whatsapp_phone: whatsapp === phone.e164 ? null : whatsapp,
        email: email || null,
        source: text('source') || 'other',
        source_detail: text('source_detail') || null,
        met_on: text('met_on') || null,
        meeting_notes: text('meeting_notes') || null,
        course_id: text('course_id') || null,
        team_id: ctx.role === 'volunteer' ? null : text('team_id') || ctx.teamId,
      },
    });
    setSaved(name);
    setFormKey((k) => k + 1);
    sync();
  }

  if (!ready) return null;
  if (!ctx) {
    return (
      <Alert tone="warn">
        Open Setu once while you have internet, then this page will work offline on this phone.{' '}
        <a href="/dashboard" className="underline">
          Open Setu
        </a>
      </Alert>
    );
  }

  const waiting = items.filter((i) => i.state === 'pending').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 text-sm">
        <p className="text-ink-muted">Saved on this phone first, then sent to Setu automatically when there is internet.</p>
        <Badge tone={online ? 'ok' : 'warn'}>{online ? 'Online' : 'Offline'}</Badge>
      </div>

      {saved ? (
        <Alert tone="ok">
          {saved} saved{online ? ' and sending now.' : '. It will be sent when you are back online.'}
        </Alert>
      ) : null}

      <Card className="p-5">
        <form key={formKey} onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name *" htmlFor="c-name" error={errors.full_name}>
            <Input id="c-name" name="full_name" autoComplete="off" aria-invalid={!!errors.full_name} />
          </Field>
          <Field label="Mobile number *" htmlFor="c-phone" error={errors.phone}>
            <Input id="c-phone" name="phone" type="tel" inputMode="tel" aria-invalid={!!errors.phone} />
          </Field>
          <Field label="WhatsApp number" htmlFor="c-wa" error={errors.whatsapp_phone} hint="Only if different.">
            <Input id="c-wa" name="whatsapp_phone" type="tel" inputMode="tel" />
          </Field>
          <Field label="Email" htmlFor="c-email" error={errors.email}>
            <Input id="c-email" name="email" type="email" />
          </Field>
          <Field label="Source" htmlFor="c-source">
            <Select id="c-source" name="source" defaultValue="event">
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Event / place" htmlFor="c-place">
            <Input id="c-place" name="source_detail" placeholder="e.g. Sunday satsang" />
          </Field>
          <Field label="Date met" htmlFor="c-date">
            <Input id="c-date" name="met_on" type="date" defaultValue={today()} />
          </Field>
          <Field label="Course of interest" htmlFor="c-course">
            <Select id="c-course" name="course_id" defaultValue="">
              <option value="">Not specified</option>
              {ctx.courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          {ctx.role === 'super_admin' ? (
            <Field label="Team *" htmlFor="c-team" error={errors.team_id}>
              <Select id="c-team" name="team_id" defaultValue={ctx.teamId ?? ''}>
                <option value="">Choose…</option>
                {ctx.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Notes" htmlFor="c-notes" className="sm:col-span-2">
            <Textarea id="c-notes" name="meeting_notes" rows={3} />
          </Field>
          {ctx.role === 'volunteer' ? (
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="assign_to_me" defaultChecked className="mt-0.5 size-4 accent-accent" />
              <span>
                I&apos;ll follow up with this person myself
                <span className="block text-ink-muted">Untick to hand them to your teacher.</span>
              </span>
            </label>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" className="w-full sm:w-auto">
              Save lead
            </Button>
          </div>
        </form>
      </Card>

      {items.length ? (
        <section aria-labelledby="c-saved" className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 id="c-saved" className="font-semibold">
              Saved on this phone
            </h2>
            {waiting && online ? (
              <Button variant="secondary" onClick={sync}>
                Send now
              </Button>
            ) : null}
          </div>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
            {items.map((i) => (
              <li key={i.ref} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {i.lead.full_name} <span className="font-normal text-ink-muted">· {formatPhone(i.lead.phone)}</span>
                  </p>
                  <p className="text-xs text-ink-muted">
                    Saved {new Date(i.savedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    {i.state === 'duplicate' ? ' · this number was already in Setu, so it was not added again' : ''}
                    {i.state === 'error' && i.message ? ` · ${i.message}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
                  {(i.state === 'synced' || i.state === 'duplicate') && i.leadId ? (
                    <a href={`/leads/${i.leadId}`} className="text-accent underline">
                      {i.leadCode ?? 'Open'}
                    </a>
                  ) : null}
                  {i.state === 'error' ? (
                    <button type="button" className="text-accent underline" onClick={() => (retryLead(i.ref), sync())}>
                      Retry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-ink-muted underline"
                    onClick={() => {
                      if (i.state !== 'pending' && i.state !== 'error') removeLead(i.ref);
                      else if (confirm(`${i.lead.full_name} has not been sent to Setu yet. Delete it from this phone?`)) removeLead(i.ref);
                    }}
                  >
                    {i.state === 'pending' || i.state === 'error' ? 'Delete' : 'Clear'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
