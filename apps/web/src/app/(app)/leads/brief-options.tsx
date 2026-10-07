'use client';

/** When assigning: what to send to the volunteer's WhatsApp along with the leads. */
export function BriefOptions({
  notes,
  history,
  onNotes,
  onHistory,
}: {
  notes: boolean;
  history: boolean;
  onNotes: (v: boolean) => void;
  onHistory: (v: boolean) => void;
}) {
  return (
    <fieldset className="rounded-lg border border-line p-3 text-sm">
      <legend className="px-1 text-xs font-medium text-ink-muted">Also send to their WhatsApp</legend>
      <label className="flex items-center gap-2 py-0.5">
        <input type="checkbox" className="size-4 accent-accent" checked={notes} onChange={(e) => onNotes(e.target.checked)} />
        Meeting notes
      </label>
      <label className="flex items-center gap-2 py-0.5">
        <input type="checkbox" className="size-4 accent-accent" checked={history} onChange={(e) => onHistory(e.target.checked)} />
        Follow-up history (calls, notes, comments)
      </label>
      <p className="mt-1 text-xs text-ink-muted">Untick both to only notify them in Setu.</p>
    </fieldset>
  );
}
