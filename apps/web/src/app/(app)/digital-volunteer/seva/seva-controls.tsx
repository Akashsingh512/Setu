'use client';
import { useState, useTransition } from 'react';
import { FormMessage, type ActionState } from '@/components/form';
import { Alert, Badge, Button, Card, Input, Select } from '@/components/ui';
import { approveSeva, identifyRequester, rejectSeva, revokeSeva, unlinkSender } from '../seva-actions';

export interface Candidate {
  id: string;
  name: string;
  team: string | null;
  hasPhone: boolean;
}
export interface Plan {
  allowed: number;
  available: number;
  unassigned_total?: number;
  reason?: string;
  per_request?: number;
  group_max?: number;
  open?: number;
  max_active?: number;
  today?: number;
  daily_limit?: number;
  week?: number;
  weekly_limit?: number;
  exception_active?: boolean;
}

export function PendingRequest({
  id,
  refNo,
  who,
  phone,
  senderName,
  group,
  text,
  asked,
  when,
  plan,
  note,
  candidates,
  canIdentify,
}: {
  id: string;
  refNo: number;
  who: string | null;
  phone: string | null;
  senderName: string | null;
  group: string;
  text: string | null;
  asked: number | null;
  when: string;
  plan: Plan | null;
  note: string | null;
  candidates: Candidate[];
  canIdentify: boolean;
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState | undefined>();
  const [count, setCount] = useState<string>('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [pick, setPick] = useState('');
  const allowed = plan?.allowed ?? 0;
  const run = (fn: () => Promise<ActionState>) => start(async () => setState(await fn()));

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            <span className="mr-1 text-ink-muted">#{refNo}</span>
            {who ?? senderName ?? 'Unknown sender'}{' '}
            {who ? <Badge tone="ok">Recognised volunteer</Badge> : <Badge tone="warn">Not recognised</Badge>}
          </p>
          <p className="text-xs text-ink-muted">
            {phone ? `${phone} · ` : ''}
            {group} · {when}
            {asked ? ` · asked for ${asked}` : ''}
          </p>
        </div>
      </div>
      {text ? <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-sm whitespace-pre-wrap">&ldquo;{text}&rdquo;</p> : null}
      {note ? (
        <div className="mt-3">
          <Alert tone="warn">{note}</Alert>
        </div>
      ) : null}

      {!who ? (
        canIdentify ? (
          <div className="mt-4 space-y-2 text-sm">
            <p className="text-ink-muted">
              {phone
                ? 'No volunteer in Setu has this phone number.'
                : "WhatsApp did not share this person's phone number, so they can't be matched automatically."}{' '}
              Nothing is shared until you confirm who this is. Only choose someone you have verified. Setu will remember them, so next time it is automatic.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={`who-${id}`} className="sr-only">
                Which volunteer is this?
              </label>
              <Select id={`who-${id}`} value={pick} onChange={(e) => setPick(e.target.value)} className="max-w-xs">
                <option value="">Choose the volunteer…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.team ? ` · ${c.team}` : ''}
                    {c.hasPhone ? '' : ' (no phone saved)'}
                  </option>
                ))}
              </Select>
              <Button disabled={!pick || pending} onClick={() => run(() => identifyRequester(id, pick))}>
                Confirm identity
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setDeclining(true)}>
                Decline
              </Button>
            </div>
          </div>
        ) : null
      ) : (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            {allowed > 0 ? (
              <>
                Can receive up to <strong>{allowed}</strong> now · <strong>{plan?.available ?? 0}</strong> free lead(s) in their team
              </>
            ) : (
              <span className="text-danger">{plan?.reason ?? 'No leads can be given right now'}</span>
            )}
          </p>
          {allowed > 0 && (plan?.available ?? 0) === 0 && plan?.reason ? <Alert tone="warn">{plan.reason}.</Alert> : null}
          {plan ? (
            <p className="text-xs text-ink-muted">
              Limits: {plan.per_request} per request{plan.exception_active ? ' (temporary exception)' : ''}
              {plan.group_max ? ` · group max ${plan.group_max}` : ''}
              {plan.max_active ? ` · holds ${plan.open ?? 0}/${plan.max_active} open` : ` · holds ${plan.open ?? 0} open`}
              {plan.daily_limit ? ` · today ${plan.today ?? 0}/${plan.daily_limit}` : ''}
              {plan.weekly_limit ? ` · this week ${plan.week ?? 0}/${plan.weekly_limit}` : ''}
            </p>
          ) : null}
          {!declining ? (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={`n-${id}`} className="text-ink-muted">
                Give
              </label>
              <Input
                id={`n-${id}`}
                type="number"
                min={1}
                max={Math.max(1, allowed)}
                value={count}
                placeholder={String(allowed || '')}
                onChange={(e) => setCount(e.target.value)}
                className="w-20"
                disabled={allowed === 0}
              />
              <Button
                disabled={pending || allowed === 0 || (plan?.available ?? 0) === 0}
                onClick={() => run(() => approveSeva(id, count ? Math.min(Number(count), allowed) : null))}
              >
                {pending ? 'Assigning…' : 'Approve & assign'}
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setDeclining(true)}>
                Decline
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {declining ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`r-${id}`} className="sr-only">
            Reason (shown to the volunteer)
          </label>
          <Input id={`r-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (the volunteer will see it)" className="max-w-sm" maxLength={200} />
          <Button variant="danger" disabled={pending} onClick={() => run(() => rejectSeva(id, reason))}>
            Decline request
          </Button>
          <Button variant="ghost" onClick={() => setDeclining(false)}>
            Back
          </Button>
        </div>
      ) : null}
      <div className="mt-3">
        <FormMessage state={state} />
      </div>
    </Card>
  );
}

export function RevokeButton({ id }: { id: string }) {
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  if (state?.ok) return <span className="text-sm text-ok">{state.message}</span>;
  return confirm ? (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-ink-muted">Take back leads nobody has called yet?</span>
      <Button
        variant="danger"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await revokeSeva(id);
            setState(r);
            setConfirm(false);
          })
        }
      >
        Yes, take back
      </Button>
      <Button variant="ghost" onClick={() => setConfirm(false)}>
        Cancel
      </Button>
    </span>
  ) : (
    <span className="flex items-center gap-2">
      {state?.error ? <span className="text-sm text-danger">{state.error}</span> : null}
      <Button variant="secondary" onClick={() => setConfirm(true)}>
        Undo assignment
      </Button>
    </span>
  );
}

export function ForgetSenderButton({ jid }: { jid: string }) {
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" disabled={pending} onClick={() => start(async () => void (await unlinkSender(jid)))}>
      {pending ? 'Removing…' : 'Forget'}
    </Button>
  );
}
