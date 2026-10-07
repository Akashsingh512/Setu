'use client';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { Alert, Badge, Button, Card, Select, Textarea } from '@/components/ui';
import type { LeadStatus } from '@/lib/types';
import { assignLeads, deleteLeads, idsForFilter, purgeLeads, restoreLeads, unassignLeads, type AssignResult } from './actions';
import { BriefOptions } from './brief-options';
import { LeadCards, type LeadCardData, type MessageContext } from './lead-cards';

export interface LeadRow {
  id: string;
  lead_code: string;
  full_name: string;
  phone: string;
  status: string;
  statusLabel: string;
  assignee: string | null;
  needs_attention: boolean;
  overdue: boolean;
  created_at: string;
  last_contact: string | null;
}

const SKIP_REASONS: Record<string, string> = {
  already_assigned: 'already assigned to this volunteer',
  registered: 'registered (they stay with their volunteer)',
  do_not_contact: 'marked Do Not Contact',
  archived: 'archived',
  not_found: 'not found',
};

export function LeadTable({
  rows,
  volunteers,
  totalMatching,
  filterQuery,
  statuses,
  cards,
  ctx,
  canAssign = true,
  canDelete = false,
  canPurge = false,
  deletedView = false,
}: {
  rows: LeadRow[];
  volunteers: { id: string; name: string; accepting: boolean }[];
  totalMatching: number;
  filterQuery: string;
  statuses: LeadStatus[];
  cards: LeadCardData[];
  ctx: MessageContext;
  /** Feature access "Assign leads": without it, no selection or bulk actions. */
  canAssign?: boolean;
  /** Feature access "Edit leads": delete, and restore from the Deleted view. */
  canDelete?: boolean;
  /** Super admins: delete for ever (Deleted view only). */
  canPurge?: boolean;
  /** Showing the Deleted list. */
  deletedView?: boolean;
}) {
  const canSelect = deletedView ? canDelete || canPurge : canAssign || canDelete;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [assignee, setAssignee] = useState('');
  const [note, setNote] = useState('');
  const [sendNotes, setSendNotes] = useState(true);
  const [sendHistory, setSendHistory] = useState(true);
  const [result, setResult] = useState<AssignResult | null>(null);
  const [pending, start] = useTransition();
  const closed = useMemo(() => new Set(statuses.filter((s) => s.is_closed).map((s) => s.code)), [statuses]);

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const count = allMatching ? totalMatching : selected.size;

  function toggle(id: string) {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function togglePage() {
    setAllMatching(false);
    setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function confirmAssign() {
    start(async () => {
      const ids = allMatching ? await idsForFilter(filterQuery) : [...selected];
      const r = await assignLeads({ leadIds: ids, assigneeId: assignee, note: note || undefined, sendNotes, sendHistory });
      setResult(r);
      if (r.ok) {
        setSelected(new Set());
        setAllMatching(false);
        setDialog(false);
        setNote('');
      }
    });
  }

  function doUnassign() {
    if (!confirm(`Unassign ${selected.size} lead(s)? They will return to the unassigned pool.`)) return;
    start(async () => {
      const r = await unassignLeads([...selected]);
      setResult(r);
      if (r.ok) setSelected(new Set());
    });
  }

  async function chosenIds() {
    return allMatching ? await idsForFilter(filterQuery) : [...selected];
  }
  function run(question: string, action: (ids: string[]) => Promise<AssignResult>) {
    if (!confirm(question)) return;
    start(async () => {
      const r = await action(await chosenIds());
      setResult(r);
      if (r.ok) {
        setSelected(new Set());
        setAllMatching(false);
      }
    });
  }

  const chosen = volunteers.find((v) => v.id === assignee);

  return (
    <>
      {result?.error ? (
        <div className="mb-3">
          <Alert>{result.error}</Alert>
        </div>
      ) : result?.ok && result.assigned !== undefined ? (
        <div className="mb-3">
          <Alert tone="ok">
            Assigned {result.assigned} lead(s).
            {result.skipped?.length ? (
              <>
                {' '}
                Skipped {result.skipped.length}:{' '}
                {Object.entries(result.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {}))
                  .map(([reason, n]) => `${n} ${SKIP_REASONS[reason] ?? reason}`)
                  .join(', ')}
                .
              </>
            ) : null}
            {result.brief ? ` ${result.brief}` : null}
          </Alert>
        </div>
      ) : result?.ok && result.message ? (
        <div className="mb-3">
          <Alert tone="ok">{result.message}</Alert>
        </div>
      ) : null}

      {canSelect && (selected.size > 0 || allMatching) ? (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm">
          <span className="font-medium">{count} selected</span>
          {allOnPage && !allMatching && totalMatching > rows.length ? (
            <button type="button" className="text-accent underline" onClick={() => setAllMatching(true)}>
              Select all {totalMatching} matching
            </button>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            {deletedView ? (
              <>
                {canDelete ? (
                  <Button onClick={() => run(`Restore ${count} lead(s)? They come back unassigned.`, restoreLeads)} disabled={pending}>
                    Restore
                  </Button>
                ) : null}
                {canPurge ? (
                  <Button
                    variant="danger"
                    onClick={() =>
                      run(`Delete ${count} lead(s) FOR EVER? Their calls, notes, follow-ups and history are erased too. This cannot be undone.`, purgeLeads)
                    }
                    disabled={pending}
                  >
                    Delete forever
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                {canAssign ? (
                  <Button onClick={() => setDialog(true)} disabled={pending}>
                    Assign leads
                  </Button>
                ) : null}
                {canAssign && !allMatching ? (
                  <Button variant="secondary" onClick={doUnassign} disabled={pending}>
                    Unassign
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button
                    variant="danger"
                    onClick={() =>
                      run(`Delete ${count} lead(s)? They are unassigned and moved to Deleted, where they can be restored.`, (ids) => deleteLeads(ids))
                    }
                    disabled={pending}
                  >
                    Delete
                  </Button>
                ) : null}
              </>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {/* Small screens: cards, no sideways scrolling. */}
      <div className="md:hidden">
        {canSelect ? (
          <label className="mb-2 flex items-center gap-2 px-1 text-sm text-ink-muted">
            <input type="checkbox" checked={allOnPage} onChange={togglePage} className="size-5 accent-accent" />
            Select all on this page
          </label>
        ) : null}
        <LeadCards rows={cards} ctx={ctx} selectable={canSelect} selected={selected} allSelected={allMatching} onToggle={toggle} />
      </div>

      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-line text-left text-ink-muted">
            <tr>
              {canSelect ? (
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={togglePage} className="size-4 accent-accent" />
                </th>
              ) : null}
              <th className="px-2 py-3 font-medium">Lead</th>
              <th className="px-2 py-3 font-medium">Status</th>
              <th className="px-2 py-3 font-medium">Assigned to</th>
              <th className="px-2 py-3 font-medium">Last contact</th>
              <th className="px-2 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) || allMatching ? 'bg-accent-soft/40' : undefined}>
                {canSelect ? (
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.full_name}`}
                      checked={allMatching || selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="size-4 accent-accent"
                    />
                  </td>
                ) : null}
                <td className="px-2 py-3">
                  <Link href={`/leads/${r.id}`} className="font-medium hover:underline">
                    {r.full_name}
                  </Link>
                  <p className="text-xs text-ink-muted">
                    {r.lead_code} · {r.phone}
                  </p>
                </td>
                <td className="px-2 py-3">
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={closed.has(r.status) ? 'neutral' : 'info'}>{r.statusLabel}</Badge>
                    {r.overdue ? <Badge tone="danger">Overdue</Badge> : null}
                    {r.needs_attention ? <Badge tone="danger">Needs attention</Badge> : null}
                  </div>
                </td>
                <td className="px-2 py-3">{r.assignee ?? <span className="text-ink-muted">Unassigned</span>}</td>
                <td className="px-2 py-3 text-ink-muted">{r.last_contact ?? 'Never'}</td>
                <td className="px-2 py-3 text-ink-muted">{r.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {dialog ? (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-scrim p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="assign-title"
        >
          <Card className="w-full max-w-md p-5">
            <h2 id="assign-title" className="text-lg font-semibold">
              Assign {count} lead(s)
            </h2>
            <p className="mt-1 text-sm text-ink-muted">The volunteer is notified and has 24 hours to make the first call.</p>
            <div className="mt-4 flex flex-col gap-3">
              <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Volunteer">
                <option value="">Choose a volunteer…</option>
                {volunteers.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.accepting ? '' : ' (not accepting new leads)'}
                  </option>
                ))}
              </Select>
              {chosen && !chosen.accepting ? <Alert tone="warn">This volunteer has paused new assignments. You can still assign manually.</Alert> : null}
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the volunteer (optional)" maxLength={500} />
              <BriefOptions notes={sendNotes} history={sendHistory} onNotes={setSendNotes} onHistory={setSendHistory} />
              {volunteers.length === 0 ? <Alert tone="warn">There are no active volunteers. Add one on the Volunteers page.</Alert> : null}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDialog(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={confirmAssign} disabled={!assignee || pending}>
                {pending ? 'Assigning…' : `Assign ${count}`}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
