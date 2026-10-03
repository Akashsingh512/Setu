'use client';
import Link from 'next/link';
import { useActionState, useCallback, useEffect, useState } from 'react';
import { buildCourseMessage, chooseMessageCourseId, telUrl, whatsAppUrl } from '@crm/shared';
import { FormMessage, SubmitButton, type ActionState } from '@/components/form';
import { Badge, Button, Card, cn, Input, Textarea } from '@/components/ui';
import { toLocalInputValue } from '@/lib/format';
import type { Course, MessageTemplate, UpcomingSession } from '@/lib/types';
import { addNote, completeFollowUp, getLeadQuickView, scheduleFollowUp, type QuickViewData } from './actions';

export interface LeadCardData {
  id: string;
  lead_code: string;
  full_name: string;
  phoneDisplay: string;
  phone: string; // E.164
  whatsapp: string; // E.164
  courseId: string | null;
  statusLabel: string;
  statusTone: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';
  blocked: boolean; // Do Not Contact
  assignee: string | null;
  overdue: boolean;
  needsAttention: boolean;
  deadlineHours: number | null; // hours left to first call, if awaiting
  nextFollowUp: string | null;
}

export interface MessageContext {
  courses: Course[];
  sessions: UpcomingSession[];
  templates: MessageTemplate[];
  volunteerName: string;
  volunteerDefaultCourseId: string | null;
  timeZone: string;
}

function whatsAppHref(lead: LeadCardData, ctx: MessageContext): string {
  const courseId = chooseMessageCourseId({ leadCourseId: lead.courseId, volunteerDefaultCourseId: ctx.volunteerDefaultCourseId });
  const course = ctx.courses.find((c) => c.id === courseId) ?? null;
  const session = ctx.sessions.find((s) => s.course_id === courseId) ?? null;
  const template =
    ctx.templates.find((t) => t.course_id === courseId && t.is_default) ?? ctx.templates.find((t) => !t.course_id && t.is_default) ?? null;
  const text = buildCourseMessage({
    template: template?.body,
    leadName: lead.full_name,
    volunteerName: ctx.volunteerName,
    course,
    session: session ? { ...session, registration_url: session.effective_registration_url } : null,
    timeZone: ctx.timeZone,
  });
  return whatsAppUrl(lead.whatsapp, text);
}

/**
 * Mobile-first lead list: name (opens the full lead), number, Call and
 * WhatsApp. Tapping elsewhere on a card opens the quick-view sheet.
 */
export function LeadCards({
  rows,
  ctx,
  selectable,
  selected,
  onToggle,
  allSelected,
  className,
}: {
  rows: LeadCardData[];
  ctx: MessageContext;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  allSelected?: boolean;
  className?: string;
}) {
  const [quick, setQuick] = useState<LeadCardData | null>(null);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <ul className={cn('grid gap-3', className)}>
        {rows.map((l) => {
          const isSelected = !!allSelected || !!selected?.has(l.id);
          return (
            <li key={l.id}>
              <Card
                role="button"
                tabIndex={0}
                aria-label={`Quick view for ${l.full_name}`}
                onClick={() => setQuick(l)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) setQuick(l);
                }}
                className={cn('cursor-pointer p-4 transition-colors hover:border-line-strong', isSelected && 'border-accent/40 bg-accent-soft/40')}
              >
                <div className="flex items-start gap-3">
                  {selectable ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.full_name}`}
                      checked={isSelected}
                      onClick={stop}
                      onChange={() => onToggle?.(l.id)}
                      className="mt-1 size-5 shrink-0 accent-accent"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <Link href={`/leads/${l.id}`} onClick={stop} className="block truncate text-base font-semibold hover:underline">
                      {l.full_name}
                    </Link>
                    <p className="text-sm text-ink-muted">{l.phoneDisplay}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone={l.statusTone}>{l.statusLabel}</Badge>
                      {l.overdue ? <Badge tone="danger">Overdue</Badge> : null}
                      {!l.overdue && l.deadlineHours !== null ? (
                        <Badge tone={l.deadlineHours <= 6 ? 'warn' : 'info'}>Call within {l.deadlineHours} h</Badge>
                      ) : null}
                      {l.needsAttention ? <Badge tone="danger">Needs attention</Badge> : null}
                      {l.nextFollowUp ? <Badge tone="accent">Follow-up {l.nextFollowUp}</Badge> : null}
                      {selectable ? <Badge>{l.assignee ?? 'Unassigned'}</Badge> : null}
                    </div>
                  </div>
                </div>
                {l.blocked ? (
                  <p className="mt-3 text-xs text-danger">Do Not Contact</p>
                ) : (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <a
                      href={telUrl(l.phone)}
                      onClick={stop}
                      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-accent text-sm font-medium text-on-accent hover:bg-accent-hover"
                    >
                      <span aria-hidden>📞</span> Call
                    </a>
                    <a
                      href={whatsAppHref(l, ctx)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={stop}
                      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-whatsapp text-sm font-medium text-white hover:bg-whatsapp-hover"
                    >
                      <span aria-hidden>💬</span> WhatsApp
                    </a>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
      {quick ? <QuickViewSheet lead={quick} timeZone={ctx.timeZone} onClose={() => setQuick(null)} /> : null}
    </>
  );
}

const KIND_LABEL = { note: 'Comment', call: 'Call', follow_up: 'Follow-up' } as const;

function QuickViewSheet({ lead, timeZone, onClose }: { lead: LeadCardData; timeZone: string; onClose: () => void }) {
  const [data, setData] = useState<QuickViewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const apply = useCallback((r: QuickViewData | { error: string }) => {
    if ('error' in r) setLoadError(r.error);
    else {
      setLoadError(null);
      setData(r);
    }
  }, []);
  const load = useCallback(async () => apply(await getLeadQuickView(lead.id)), [apply, lead.id]);

  // Initial load; ignore the result if the sheet closed first.
  useEffect(() => {
    let alive = true;
    void getLeadQuickView(lead.id).then((r) => alive && apply(r));
    return () => {
      alive = false;
    };
  }, [apply, lead.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Refresh the sheet after a successful save and reset the form.
  const afterSave = (fn: (leadId: string, prev: ActionState | undefined, fd: FormData) => Promise<ActionState>) =>
    async (prev: ActionState | undefined, fd: FormData) => {
      const r = await fn(lead.id, prev, fd);
      if (r.ok) {
        setFormKey((k) => k + 1);
        await load();
      }
      return r;
    };
  const [fuState, fuAction] = useActionState(afterSave(scheduleFollowUp), undefined);
  const [noteState, noteAction] = useActionState(afterSave(addNote), undefined);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-scrim sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qv-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl border border-line bg-surface sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id="qv-title" className="truncate text-lg font-semibold">
              {lead.full_name}
            </h2>
            <p className="text-sm text-ink-muted">
              {lead.phoneDisplay} · {lead.lead_code}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link href={`/leads/${lead.id}`} className="inline-flex min-h-9 items-center rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-canvas">
              Open lead
            </Link>
            <button type="button" onClick={onClose} aria-label="Close" className="min-h-9 min-w-9 rounded-lg text-lg text-ink-muted hover:bg-canvas">
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadError ? <p className="text-sm text-danger">{loadError}</p> : null}

          <section aria-labelledby="qv-fu">
            <h3 id="qv-fu" className="mb-2 text-sm font-semibold">
              Follow-ups
            </h3>
            {data === null && !loadError ? <p className="text-sm text-ink-muted">Loading…</p> : null}
            {data?.followUps.length ? (
              <ul className="mb-3 divide-y divide-line rounded-lg border border-line text-sm">
                {data.followUps.map((f) => (
                  <li key={f.id} className="flex items-start gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className={cn('font-medium', f.overdue && 'text-danger')}>{f.due}</p>
                      {f.note ? <p className="text-ink-muted">{f.note}</p> : null}
                    </div>
                    <Button
                      variant="secondary"
                      className="min-h-8 px-2.5 text-xs"
                      onClick={async () => {
                        await completeFollowUp(lead.id, f.id);
                        await load();
                      }}
                    >
                      Done
                    </Button>
                  </li>
                ))}
              </ul>
            ) : data ? (
              <p className="mb-3 text-sm text-ink-muted">No open follow-ups.</p>
            ) : null}
            {lead.blocked ? null : (
              <form key={`fu-${formKey}`} action={fuAction} className="grid gap-2">
                <FormMessage state={fuState} />
                <Input name="due_at" type="datetime-local" required min={toLocalInputValue(new Date(), timeZone)} aria-label="Follow-up date and time" />
                <Input name="note" placeholder="What to follow up on (optional)" />
                <SubmitButton variant="secondary">Add follow-up</SubmitButton>
              </form>
            )}
          </section>

          <section aria-labelledby="qv-comments" className="mt-6">
            <h3 id="qv-comments" className="mb-2 text-sm font-semibold">
              Add a comment
            </h3>
            <form key={`n-${formKey}`} action={noteAction} className="grid gap-2">
              {noteState?.error ? <FormMessage state={noteState} /> : null}
              <Textarea name="body" placeholder="What happened, what they said…" required aria-label="Comment" />
              <SubmitButton variant="secondary">Save comment</SubmitButton>
            </form>
          </section>

          <section aria-labelledby="qv-history" className="mt-6">
            <h3 id="qv-history" className="mb-2 text-sm font-semibold">
              History
            </h3>
            {data?.history.length ? (
              <ol className="space-y-3 text-sm">
                {data.history.map((h) => (
                  <li key={h.id} className="border-l-2 border-line pl-3">
                    <p>
                      <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">{KIND_LABEL[h.kind]}</span>
                    </p>
                    <p className="whitespace-pre-wrap">{h.kind === 'note' ? h.text : <span className="font-medium">{h.text}</span>}</p>
                    {h.detail ? <p className="whitespace-pre-wrap text-ink-muted">{h.detail}</p> : null}
                    <p className="text-xs text-ink-muted">
                      {h.who} · {h.when}
                    </p>
                  </li>
                ))}
              </ol>
            ) : data ? (
              <p className="text-sm text-ink-muted">No comments or calls yet.</p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
