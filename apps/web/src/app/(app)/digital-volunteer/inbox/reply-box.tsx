'use client';
import { useActionState, useState, useTransition } from 'react';
import { FormMessage, SubmitButton } from '@/components/form';
import { Button, Textarea } from '@/components/ui';
import { approveSuggestion, cancelOutbox, confirmFollowUp, dismissMessage, sendMessage } from '../actions';

export function ReplyBox({ chat }: { chat: string }) {
  const [state, action] = useActionState(sendMessage, undefined);
  return (
    // React resets the form after each submit; a failed send puts the text back.
    <form action={action} className="space-y-2 border-t border-line p-4">
      <input type="hidden" name="chat" value={chat} />
      <label htmlFor="reply-body" className="sr-only">
        Message
      </label>
      <Textarea
        key={state?.draft ?? ''}
        id="reply-body"
        name="body"
        rows={3}
        maxLength={4000}
        placeholder="Type a reply…"
        defaultValue={state?.draft ?? ''}
        required
      />
      <div className="flex items-center justify-between gap-3">
        <FormMessage state={state} />
        <SubmitButton pendingText="Queuing…">Send</SubmitButton>
      </div>
    </form>
  );
}

export function CancelOutboxButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} className="ml-2 text-ink-muted underline hover:text-ink" onClick={() => start(async () => void (await cancelOutbox(id)))}>
      Cancel
    </button>
  );
}

/** A reply the bot prepared from course data, waiting for a person (assisted mode). */
export function SuggestionCard({
  id,
  body,
  canSend,
  aiDraft = false,
  refNo,
}: {
  id: string;
  body: string;
  canSend: boolean;
  /** Written by AI from Setu's data: check it before sending. */
  aiDraft?: boolean;
  /** The number approvers use on WhatsApp (SEND 12). */
  refNo?: number;
}) {
  const [text, setText] = useState(body);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="w-full max-w-[85%] rounded-xl border border-accent/40 bg-accent-soft/60 p-3">
      <p className="mb-2 text-xs font-medium text-accent">
        {refNo ? `#${refNo} · ` : ''}
        {aiDraft ? '🤖 AI draft from Setu’s data · check it before sending' : 'Suggested reply · from verified course data'}
      </p>
      {canSend ? (
        <>
          <label htmlFor={`sugg-${id}`} className="sr-only">
            Suggested reply
          </label>
          <Textarea id={`sugg-${id}`} rows={Math.min(14, text.split('\n').length + 1)} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              disabled={pending || !text.trim()}
              onClick={() =>
                start(async () => {
                  const r = await approveSuggestion(id, text === body ? null : text);
                  setError(r.error ?? null);
                })
              }
            >
              Approve &amp; send
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await cancelOutbox(id);
                  setError(r.error ?? null);
                })
              }
            >
              Discard
            </Button>
            {error ? <span className="text-sm text-danger">{error}</span> : null}
          </div>
        </>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{body}</p>
      )}
    </div>
  );
}

export function MarkHandledButton({ messageId }: { messageId: string }) {
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} className="ml-2 text-accent underline" onClick={() => start(async () => void (await dismissMessage(messageId)))}>
      Mark as handled
    </button>
  );
}

export function ConfirmFollowUpButton({ messageId, followUpId }: { messageId: string; followUpId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={pending}
        className="text-accent underline"
        onClick={() =>
          start(async () => {
            const r = await confirmFollowUp(messageId, followUpId);
            setError(r.error ?? null);
          })
        }
      >
        Mark done
      </button>
      {error ? <span className="text-danger">{error}</span> : null}
    </>
  );
}
