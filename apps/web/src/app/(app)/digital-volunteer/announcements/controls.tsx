'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { FormMessage, type ActionState } from '@/components/form';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { createClient } from '@/lib/supabase/client';
import { approveAnnouncement, cancelAnnouncement, createAnnouncement, rejectAnnouncement } from '../announcement-actions';

export type GroupOption = { id: string; name: string; media: boolean };

// 0 = send once; otherwise days between sends.
const REPEAT_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Send once' },
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
  const sendCount = every ? times : 1;
  const tooLong = every > 0 && (times - 1) * every > 89;
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
        repeatEveryDays: every || 1,
      });
      setState(r);
      if (r.ok) {
        setTitle('');
        setBody('');
        setPoster(null);
        setPicked(new Set());
        setEvery(0);
        setTimes(5);
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
      <Field label={every ? 'First send at' : 'Send at'} htmlFor="ann-at">
        <Input id="ann-at" type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className="max-w-xs" />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label="Repeat" htmlFor="ann-repeat">
          <Select id="ann-repeat" value={every} onChange={(e) => setEvery(Number(e.target.value))} className="w-44">
            {REPEAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {every ? (
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
      {every && sendAt ? (
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
        <Button disabled={pending || tooLong || !title.trim() || !picked.size || blocked.length > 0 || (!body.trim() && !poster)} onClick={submit}>
          {pending ? 'Saving…' : 'Submit for approval'}
        </Button>
        <FormMessage state={state} />
      </div>
    </div>
  );
}

export function AnnouncementActions({ id, canApprove, canCancel }: { id: string; canApprove: boolean; canCancel: boolean }) {
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
              if (confirm('Cancel this announcement? Groups that already received it keep it.')) run(() => cancelAnnouncement(id));
            }}
          >
            Cancel
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
