'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { FormMessage, type ActionState } from '@/components/form';
import { Button, Field, Input, Textarea } from '@/components/ui';
import { createClient } from '@/lib/supabase/client';
import { approveAnnouncement, cancelAnnouncement, createAnnouncement, rejectAnnouncement } from '../announcement-actions';

export type GroupOption = { id: string; name: string; media: boolean };

const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const POSTER_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function NewAnnouncement({ groups, defaultSendAt }: { groups: GroupOption[]; defaultSendAt: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState | undefined>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sendAt, setSendAt] = useState(defaultSendAt);
  const [poster, setPoster] = useState<File | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
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
        if (!ext) return setState({ error: 'The poster must be a JPG, PNG or WebP image.' });
        if (poster.size > MAX_POSTER_BYTES) return setState({ error: 'The poster is larger than 5 MB.' });
        // Uploaded straight from the browser (storage policies check the permission).
        posterPath = `announcements/${crypto.randomUUID()}.${ext}`;
        const { error } = await createClient().storage.from('dv-posters').upload(posterPath, poster, { contentType: poster.type });
        if (error) return setState({ error: `The poster could not be uploaded: ${error.message}` });
      }
      const r = await createAnnouncement({ title, body, posterPath, sendAt, groupIds: [...picked] });
      setState(r);
      if (r.ok) {
        setTitle('');
        setBody('');
        setPoster(null);
        setPicked(new Set());
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
      <Field label="Send at" htmlFor="ann-at">
        <Input id="ann-at" type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} className="max-w-xs" />
      </Field>
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
        {blocked.length ? <p className="mt-2 text-danger">These groups don&apos;t allow media, so they can&apos;t get a poster: {blocked.map((g) => g.name).join(', ')}</p> : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending || !title.trim() || !picked.size || blocked.length > 0 || (!body.trim() && !poster)} onClick={submit}>
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
          <Input id={`reason-${id}`} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to the author)" className="max-w-sm" />
          <Button variant="secondary" disabled={pending} onClick={() => run(() => rejectAnnouncement(id, reason))}>
            Confirm
          </Button>
        </div>
      ) : null}
      <FormMessage state={state} />
    </div>
  );
}
