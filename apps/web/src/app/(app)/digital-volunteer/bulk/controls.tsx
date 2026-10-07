'use client';
import { useState, useTransition } from 'react';
import { FormMessage, type ActionState } from '@/components/form';
import { Button, Input } from '@/components/ui';
import { controlBulk, setOptOut } from '../bulk-actions';

export function BulkControls({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (action: 'pause' | 'resume' | 'cancel', question?: string) => {
    if (question && !confirm(question)) return;
    start(async () => setError((await controlBulk(id, action)).error ?? null));
  };
  if (status === 'completed' || status === 'cancelled') return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'paused' ? (
        <Button className="min-h-9 px-3" disabled={pending} onClick={() => act('resume')}>
          Resume
        </Button>
      ) : (
        <Button variant="secondary" className="min-h-9 px-3" disabled={pending} onClick={() => act('pause')}>
          Pause
        </Button>
      )}
      <Button
        variant="danger"
        className="min-h-9 px-3"
        disabled={pending}
        onClick={() => act('cancel', 'Stop this bulk message for good? People not reached yet will not get it.')}
      >
        Cancel
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}

export function OptOutForm() {
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setOptOut(phone, true);
          setState(r);
          if (r.ok) setPhone('');
        });
      }}
    >
      <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98450 12345" aria-label="Phone number" className="max-w-56" />
      <Button type="submit" variant="secondary" disabled={pending || !phone.trim()}>
        Never message this number
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export function RemoveOptOut({ phone }: { phone: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="text-xs text-ink-muted hover:text-danger hover:underline disabled:opacity-50"
      disabled={pending}
      onClick={() => {
        if (confirm('Allow bulk messages to this number again? Only do this if the person asked for it.'))
          start(async () => void (await setOptOut(phone, false)));
      }}
    >
      Remove
    </button>
  );
}
