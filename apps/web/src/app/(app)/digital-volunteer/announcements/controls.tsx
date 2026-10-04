'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { FormMessage, type ActionState } from '@/components/form';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { createClient } from '@/lib/supabase/client';
import { approveAnnouncement, cancelAnnouncement, cancelAnnouncementSend, createAnnouncement, rejectAnnouncement } from '../announcement-actions';

export type GroupOption = { id: string; name: string; media: boolean };

// 0 = send once; -1 = times chosen one by one; otherwise days between sends.
const CUSTOM = -1;
const MAX_TIMES = 30;
const REPEAT_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Send once' },
  { value: CUSTOM, label: 'Choose each time' },
  { value: 1, label: 'Every day' },
  { value: 2, label: 'Every 2 days' },
  { value: 3, label: 'Every 3 days' },
  { value: 7, label: 'Every week' },
];

/** "3 Oct, 6:37 pm" for the schedule preview (the datetime-local value is already in org time). */
function previewDate(local: string, addDays: number): string {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + addDays, +m[4]!, +m[5]!));
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** The same time of day, one day later (datetime-local values in org time). */
function nextDay(local: string): string {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return local;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + 1, +m[4]!, +m[5]!));
  return d.toISOString().slice(0, 16);
}

const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const POSTER_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function NewAnnouncement({
  groups,
  defaultSendAt,
  initialTitle = '',
  initialBody = '',
}: {
  groups: GroupOption[];
  defaultSendAt: string;
  /** Prefilled from an intro talk (Intro talks > Announce in groups). */
  initialTitle?: string;
  initialBody?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState | undefined>();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [sendAt, setSendAt] = useState(defaultSendAt);
  const [poster, setPoster] = useState<File | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [every, setEvery] = useState(0);
  const [times, setTimes] = useState(5);
  const [customTimes, setCustomTimes] = useState<string[]>([defaultSendAt]);
  const custom = every === CUSTOM;
  const sendCount = custom ? customTimes.length : every ? times : 1;
  const tooLong = every > 0 && (times - 1) * every > 89;
  // datetime-local values sort correctly as text.
  const sortedTimes = [...customTimes].filter(Boolean).sort();
  const customProblem = !custom
    ? null
    : customTimes.some((t) => !t)
      ? 'Fill in every time, or remove the empty one.'
      : new Set(customTimes).size !== customTimes.length
        ? 'Two of the times are the same.'
        : null;
  const [formKey, setFormKey] = useState(0);

  const blocked = poster ? groups.filter((g) => picked.has(g.id) && !g.media) : [];

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    start(async () => {
      let posterPath: string | null = null;
      if (poster) {
        const ext = POSTER_TYPES[poster.type];
        if (!ext)
          return setState({
            error: 'The poster must be a JPG, PNG or WebP image.',
          });
        if (poster.size > MAX_POSTER_BYTES) return setState({ error: 'The poster is larger than 5 MB.' });
        // Uploaded straight from the browser (storage policies check the permission).
        posterPath = `announcements/${crypto.randomUUID()}.${ext}`;
        const { error } = await createClient().storage.from('dv-posters').upload(posterPath, poster, { contentType: poster.type });
        if (error)
          return setState({
            error: `The poster could not be uploaded: ${error.message}`,
          });
      }
      const r = await createAnnouncement({
        title,
        body,
        posterPath,
        sendAt,
        groupIds: [...picked],
        repeatCount: sendCount,
        repeatEveryDays: every > 0 ? every : 1,
        sendTimes: custom ? customTimes : undefined,
      });
      setState(r);
      if (r.ok) {
        setTitle('');
        setBody('');
        setPoster(null);
        setPicked(new Set());
        setEvery(0);
        setTimes(5);
        setCustomTimes([defaultSendAt]);
        setFormKey((k) => k + 1);
        router.refresh();
      }
    });
  }

  return (
    <div key={formKey} className="space-y-4 p-5 text-sm">
      <Field label="Name (only shown in Setu)" htmlFor="ann-title">
        <Input id="ann-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sunday satsang reminder" />
      </Field>
      <Field label="Message" htmlFor="ann-body" hint="Sent exactly as written. With a poster, this becomes its caption.">
        <Textarea id="ann-body" rows={6} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Field label="Poster (optional)" htmlFor="ann-poster" hint="JPG, PNG or WebP, up to 5 MB. Only groups that allow media can receive it.">
        <Input id="ann-poster" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPoster(e.target.files?.[0] ?? null)} />
      </Field>
      {custom ? null : (
        <Field label={every ? 'First send at' : 'Send at'} htmlFor="ann-at">
          <Input id="ann-at" type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className="max-w-xs" />
        </Field>
      )}
      <div className="flex flex-wrap gap-3">
        <Field label="Repeat" htmlFor="ann-repeat">
          <Select
            id="ann-repeat"
            value={every}
            onChange={(e) => {
              const v = Number(e.target.value);
              // Start the list from the time already picked.
              if (v === CUSTOM && every !== CUSTOM) setCustomTimes([sendAt || defaultSendAt]);
              setEvery(v);
            }}
            className="w-48"
          >
            {REPEAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {every > 0 ? (
          <Field label="How many times" htmlFor="ann-times">
            <Input
              id="ann-times"
              type="number"
              min={2}
              max={30}
              value={times}
              onChange={(e) => setTimes(Math.max(1, Math.min(30, Math.trunc(Number(e.target.value)) || 1)))}
              className="w-28"
            />
          </Field>
        ) : null}
      </div>
      {custom ? (
        <fieldset className="space-y-2">
          <legend className="mb-1.5 font-medium">Send times</legend>
          <ol className="space-y-2">
            {customTimes.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-6 text-right text-ink-muted">{i + 1}.</span>
                <label htmlFor={`ann-time-${i}`} className="sr-only">
                  Send time {i + 1}
                </label>
                <Input
                  id={`ann-time-${i}`}
                  type="datetime-local"
                  value={t}
                  onChange={(e) => setCustomTimes((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
                  className="max-w-xs"
                />
                {customTimes.length > 1 ? (
                  <Button
                    variant="ghost"
                    aria-label={`Remove send time ${i + 1}`}
                    onClick={() => setCustomTimes((list) => list.filter((_, j) => j !== i))}
                    className="px-2"
                  >
                    ✕
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          {customTimes.length < MAX_TIMES ? (
            <Button
              variant="secondary"
              // Suggests the same time of day, one day after the latest time.
              onClick={() => setCustomTimes((list) => [...list, nextDay([...list].filter(Boolean).sort().at(-1) ?? defaultSendAt)])}
            >
              + Add a time
            </Button>
          ) : null}
          <p className={customProblem ? 'text-danger' : 'text-ink-muted'}>
            {customProblem ??
              `Sends ${sortedTimes.length} time${sortedTimes.length === 1 ? '' : 's'}: ${sortedTimes.map((t) => previewDate(t, 0)).join(', ')}. One approval covers all of them. Up to ${MAX_TIMES} times, within 90 days.`}
          </p>
        </fieldset>
      ) : null}
      {every > 0 && sendAt ? (
        <p className={tooLong ? 'text-danger' : 'text-ink-muted'}>
          {tooLong
            ? 'The last send must be within 90 days. Send it fewer times or closer together.'
            : `Sends ${times} time${times === 1 ? '' : 's'} at the same time of day: ${previewDate(sendAt, 0)}${times > 1 ? ` → last on ${previewDate(sendAt, (times - 1) * every)}` : ''}. One approval covers all of them.`}
        </p>
      ) : null}
      <fieldset>
        <legend className="mb-1.5 font-medium">Groups</legend>
        {groups.length ? (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {groups.map((g) => (
              <li key={g.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={picked.has(g.id)} onChange={() => toggle(g.id)} className="size-4 accent-accent" />
                  <span>
                    {g.name || 'Unnamed group'}
                    {!g.media ? <span className="text-ink-muted"> · text only</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">No group allows announcements yet. Turn on &ldquo;Announcements&rdquo; for a group on the Groups tab.</p>
        )}
        {blocked.length ? (
          <p className="mt-2 text-danger">These groups don&apos;t allow media, so they can&apos;t get a poster: {blocked.map((g) => g.name).join(', ')}</p>
        ) : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending || tooLong || !!customProblem || !title.trim() || !picked.size || blocked.length > 0 || (!body.trim() && !poster)} onClick={submit}>
          {pending ? 'Saving…' : 'Submit for approval'}
        </Button>
        <FormMessage state={state} />
      </div>
    </div>
  );
}

export function AnnouncementActions({
  id,
  canApprove,
  canCancel,
  cancelLabel = 'Cancel',
}: {
  id: string;
  canApprove: boolean;
  canCancel: boolean;
  cancelLabel?: string;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState | undefined>();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const run = (fn: () => Promise<ActionState>) => start(async () => setState(await fn()));
  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        {canApprove ? (
          <>
            <Button disabled={pending} onClick={() => run(() => approveAnnouncement(id))}>
              Approve
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setDeclining((d) => !d)}>
              Don&apos;t approve
            </Button>
          </>
        ) : null}
        {canCancel ? (
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => {
              if (confirm('Cancel everything not sent yet? Groups that already received it keep it.')) run(() => cancelAnnouncement(id));
            }}
          >
            {cancelLabel}
          </Button>
        ) : null}
      </div>
      {declining ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`reason-${id}`} className="sr-only">
            Reason
          </label>
          <Input
            id={`reason-${id}`}
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (shown to the author)"
            className="max-w-sm"
          />
          <Button variant="secondary" disabled={pending} onClick={() => run(() => rejectAnnouncement(id, reason))}>
            Confirm
          </Button>
        </div>
      ) : null}
      <FormMessage state={state} />
    </div>
  );
}

/** Cancel one scheduled send of an announcement (every group gets it at that time). */
export function CancelSendButton({ id, sendAfter, label }: { id: string; sendAfter: string; label: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={pending}
        className="text-danger underline disabled:opacity-50"
        onClick={() => {
          if (confirm(`Cancel the send on ${label}? The other times still go out.`))
            start(async () => {
              const r = await cancelAnnouncementSend(id, sendAfter);
              setError(r.error ?? null);
            });
        }}
      >
        Cancel this one
      </button>
      {error ? <span className="text-danger">{error}</span> : null}
    </>
  );
}
