'use client';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import {
  checkImportRows,
  formatPhone,
  guessMapping,
  IMPORT_CHUNK_SIZE,
  IMPORT_FIELDS,
  importTemplateCsv,
  MAX_IMPORT_ROWS,
  parseCsv,
  type CheckedRow,
  type ColumnMapping,
  type ImportFieldKey,
} from '@crm/shared';
import { Alert, Badge, Button, Card, CardHeader, cn, Field, Select } from '@/components/ui';
import { importLeadChunk } from './actions';

type Option = { id: string; name: string };
type Sheet = { fileName: string; headers: string[]; rows: string[][] };
type Outcome = {
  inserted: number;
  assigned: number;
  existing: { line: number; name: string; leadId: string }[];
  failed: { line: number; name: string; phone: string; reason: string }[];
  notices: string[];
};

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v);
}

async function readFile(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import('read-excel-file/browser');
    const data = await readSheet(file);
    return data.map((row) => row.map(cellText)).filter((r) => r.some((v) => v.trim() !== ''));
  }
  if (/\.(csv|txt)$/i.test(file.name)) return parseCsv(await file.text());
  throw new Error('Please choose an Excel (.xlsx) or CSV file. For an old .xls file, open it and save as .xlsx first.');
}

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export function Importer({
  courses,
  teams,
  fixedTeamId,
  volunteers,
  defaultCountry,
}: {
  courses: Option[];
  teams: Option[];
  fixedTeamId: string | null;
  volunteers: (Option & { teamId: string | null })[];
  defaultCountry: string;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [teamId, setTeamId] = useState(fixedTeamId ?? (teams.length === 1 ? teams[0]!.id : ''));
  const [assignTo, setAssignTo] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [view, setView] = useState<'all' | 'problems'>('all');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const checked = useMemo(
    () => (sheet ? checkImportRows(sheet.rows, mapping, { defaultCountry, courses }) : []),
    [sheet, mapping, defaultCountry, courses],
  );
  const invalid = checked.filter((r) => r.errors.length);
  const repeats = skipDuplicates ? checked.filter((r) => !r.errors.length && r.duplicateOfLine !== null) : [];
  const ready = checked.filter((r) => r.lead && !(skipDuplicates && r.duplicateOfLine !== null));
  const warned = ready.filter((r) => r.warnings.length);
  const missingRequired = IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] === undefined);
  const teamVolunteers = volunteers.filter((v) => v.teamId === teamId);
  const busy = progress !== null && outcome === null;

  async function loadFile(file: File | undefined) {
    if (!file) return;
    setFileError(null);
    setOutcome(null);
    setRunError(null);
    try {
      const all = await readFile(file);
      if (all.length < 2) throw new Error('The file has no data rows. The first row should be the column headings.');
      const [headers, ...rows] = all;
      if (rows.length > MAX_IMPORT_ROWS) throw new Error(`The file has ${rows.length} rows. Import at most ${MAX_IMPORT_ROWS} at a time - split it into smaller files.`);
      setSheet({ fileName: file.name, headers: headers!.map((h, i) => h.trim() || `Column ${i + 1}`), rows });
      setMapping(guessMapping(headers!));
      setView('all');
    } catch (e) {
      setSheet(null);
      setFileError(e instanceof Error ? e.message : 'Could not read that file.');
    }
  }

  async function runImport() {
    if (!teamId || !ready.length) return;
    setRunError(null);
    const result: Outcome = { inserted: 0, assigned: 0, existing: [], failed: [], notices: [] };
    setProgress({ done: 0, total: ready.length });
    for (let start = 0; start < ready.length; start += IMPORT_CHUNK_SIZE) {
      const chunk = ready.slice(start, start + IMPORT_CHUNK_SIZE);
      const res = await importLeadChunk({ teamId, rows: chunk.map((r) => r.lead!), skipDuplicates, assignTo: assignTo || null });
      if (!res.ok) {
        // Earlier chunks are already saved; report them and stop.
        setRunError(`${res.error}${start > 0 ? ` (${result.inserted} lead(s) from earlier in the file were already imported.)` : ''}`);
        for (const r of ready.slice(start)) result.failed.push({ line: r.line, name: r.raw.full_name, phone: r.raw.phone, reason: 'Not imported - stopped after an error' });
        break;
      }
      result.inserted += res.inserted;
      result.assigned += res.assigned;
      if (res.assignError) result.notices.push(`Some leads were imported but not assigned: ${res.assignError}`);
      for (const d of res.duplicates) {
        const r = chunk[d.index]!;
        if (skipDuplicates) result.existing.push({ line: r.line, name: r.raw.full_name, leadId: d.existingLeadId });
      }
      for (const e of res.errors) {
        const r = chunk[e.index]!;
        result.failed.push({ line: r.line, name: r.raw.full_name, phone: r.raw.phone, reason: e.message });
      }
      setProgress({ done: Math.min(start + chunk.length, ready.length), total: ready.length });
    }
    setOutcome(result);
  }

  function downloadProblems() {
    if (!sheet) return;
    const reasons = new Map<number, string>();
    for (const r of invalid) reasons.set(r.line, r.errors.join('; '));
    for (const r of repeats) reasons.set(r.line, `Same phone as row ${r.duplicateOfLine}`);
    for (const f of outcome?.failed ?? []) reasons.set(f.line, f.reason);
    for (const e of outcome?.existing ?? []) reasons.set(e.line, 'Already in the CRM');
    const lines = [...reasons.keys()].sort((a, b) => a - b);
    const csv = [
      ['Row', 'Problem', ...sheet.headers].map(csvCell).join(','),
      ...lines.map((line) => [line, reasons.get(line)!, ...(sheet.rows[line - 2] ?? [])].map(csvCell).join(',')),
    ].join('\r\n');
    download(`import-problems-${sheet.fileName.replace(/\.[^.]+$/, '')}.csv`, csv);
  }

  function reset() {
    setSheet(null);
    setOutcome(null);
    setProgress(null);
    setRunError(null);
    setAssignTo('');
    if (input.current) input.current.value = '';
  }

  // ---- Results ------------------------------------------------------------
  if (outcome && sheet) {
    const notImported = invalid.length + repeats.length + outcome.failed.length + outcome.existing.length;
    return (
      <div className="space-y-4">
        {runError ? <Alert>{runError}</Alert> : null}
        <Card className="p-5">
          <h2 className="text-lg font-semibold">
            {outcome.inserted} lead{outcome.inserted === 1 ? '' : 's'} imported
          </h2>
          <ul className="mt-3 space-y-1 text-sm text-ink-muted">
            {outcome.assigned ? <li>{outcome.assigned} assigned to {volunteers.find((v) => v.id === assignTo)?.name ?? 'the volunteer'}.</li> : null}
            {outcome.existing.length ? <li>{outcome.existing.length} skipped - phone number already in the CRM.</li> : null}
            {repeats.length ? <li>{repeats.length} skipped - same phone appears earlier in the file.</li> : null}
            {invalid.length ? <li>{invalid.length} skipped - missing name or invalid phone.</li> : null}
            {outcome.failed.length ? <li>{outcome.failed.length} could not be saved.</li> : null}
          </ul>
          {outcome.notices.map((n) => (
            <div key={n} className="mt-3">
              <Alert tone="warn">{n}</Alert>
            </div>
          ))}
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={outcome.assigned ? '/leads' : '/leads?assignee=none'} className="inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover">
              {outcome.assigned ? 'Go to leads' : 'View unassigned leads'}
            </Link>
            {notImported ? (
              <Button variant="secondary" onClick={downloadProblems}>
                Download skipped rows ({notImported})
              </Button>
            ) : null}
            <Button variant="ghost" onClick={reset}>
              Import another file
            </Button>
          </div>
        </Card>
        {outcome.failed.length ? (
          <Card>
            <CardHeader title="Rows that could not be saved" />
            <ul className="divide-y divide-line text-sm">
              {outcome.failed.slice(0, 100).map((f) => (
                <li key={f.line} className="px-5 py-2">
                  Row {f.line}: {f.name || '(no name)'} - <span className="text-danger">{f.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {outcome.existing.length ? (
          <Card>
            <CardHeader title="Already in the CRM" description="These numbers match an existing lead, so they were not added again." />
            <ul className="divide-y divide-line text-sm">
              {outcome.existing.slice(0, 100).map((e) => (
                <li key={e.line} className="flex justify-between gap-3 px-5 py-2">
                  <span>
                    Row {e.line}: {e.name}
                  </span>
                  <Link href={`/leads/${e.leadId}`} className="text-accent hover:underline">
                    Open existing lead
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    );
  }

  // ---- Step 1: choose a file ---------------------------------------------
  if (!sheet) {
    return (
      <div className="space-y-4">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void loadFile(e.dataTransfer.files[0]);
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface hover:bg-canvas',
          )}
        >
          <span className="text-base font-medium">Choose an Excel or CSV file</span>
          <span className="text-sm text-ink-muted">or drag it here · .xlsx or .csv · up to {MAX_IMPORT_ROWS.toLocaleString('en-IN')} rows</span>
          <input
            ref={input}
            type="file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => void loadFile(e.target.files?.[0])}
          />
        </label>
        {fileError ? <Alert>{fileError}</Alert> : null}
        <Card className="p-5 text-sm">
          <h2 className="font-semibold">How it works</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-muted">
            <li>The first row must be column headings. Only <strong className="text-ink">Name</strong> and <strong className="text-ink">Phone</strong> are required.</li>
            <li>Phone numbers without a country code are treated as {defaultCountry === 'IN' ? 'Indian (+91)' : defaultCountry} numbers.</li>
            <li>You&apos;ll see a preview and can fix the column matching before anything is saved.</li>
            <li>Numbers already in the CRM are skipped, so re-uploading the same file is safe.</li>
          </ol>
          <button type="button" className="mt-3 text-accent underline" onClick={() => download('lead-import-template.csv', importTemplateCsv())}>
            Download a template
          </button>
        </Card>
      </div>
    );
  }

  // ---- Step 2: map columns, preview, import ------------------------------
  const shown = (view === 'problems' ? checked.filter((r) => r.errors.length || r.warnings.length || (skipDuplicates && r.duplicateOfLine !== null)) : checked).slice(0, 200);
  const courseName = (id: string | null) => courses.find((c) => c.id === id)?.name;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">{sheet.fileName}</span> <span className="text-ink-muted">· {sheet.rows.length} rows</span>
        </p>
        <Button variant="ghost" onClick={reset} disabled={busy}>
          Choose a different file
        </Button>
      </div>

      <Card>
        <CardHeader title="Match your columns" description="We matched what we could. Check each CRM field reads from the right column." />
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {IMPORT_FIELDS.map((f) => {
            const idx = mapping[f.key];
            const sample = idx === undefined ? '' : sheet.rows.find((r) => r[idx]?.trim())?.[idx];
            return (
              <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} htmlFor={`map-${f.key}`} hint={sample ? `e.g. ${sample.slice(0, 40)}` : undefined}>
                <Select
                  id={`map-${f.key}`}
                  value={idx ?? ''}
                  disabled={busy}
                  aria-invalid={f.required && idx === undefined}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMapping((m) => {
                      const next = { ...m };
                      if (v === '') delete next[f.key as ImportFieldKey];
                      else next[f.key as ImportFieldKey] = Number(v);
                      return next;
                    });
                  }}
                >
                  <option value="">{f.required ? 'Choose a column…' : "Don't import"}</option>
                  {sheet.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </Select>
              </Field>
            );
          })}
        </div>
      </Card>

      {missingRequired.length ? (
        <Alert tone="warn">Choose which column holds {missingRequired.map((f) => f.label).join(' and ')} to continue.</Alert>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-sm" aria-live="polite">
            <Badge tone="ok">{ready.length} ready to import</Badge>
            {warned.length ? <Badge tone="warn">{warned.length} with notes</Badge> : null}
            {repeats.length ? <Badge tone="neutral">{repeats.length} repeated in file</Badge> : null}
            {invalid.length ? <Badge tone="danger">{invalid.length} can&apos;t be imported</Badge> : null}
          </div>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
              <h2 className="font-semibold">Preview</h2>
              <div role="radiogroup" aria-label="Rows to show" className="inline-flex rounded-lg border border-line-strong p-0.5 text-sm">
                {(['all', 'problems'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={view === v}
                    onClick={() => setView(v)}
                    className={cn('rounded-md px-2.5 py-1', view === v ? 'bg-ink font-medium text-on-ink' : 'text-ink-muted hover:text-ink')}
                  >
                    {v === 'all' ? 'All rows' : 'Only problems'}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-muted">No problems found.</p>
            ) : (
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface text-left text-ink-muted">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium">Row</th>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Phone</th>
                      <th className="hidden px-4 py-2 font-medium md:table-cell">Course</th>
                      <th className="px-4 py-2 font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {shown.map((r) => (
                      <PreviewRow key={r.line} row={r} skipRepeats={skipDuplicates} courseName={courseName(r.lead?.course_id ?? null)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(view === 'all' ? checked.length : shown.length) > 200 ? (
              <p className="border-t border-line px-5 py-2 text-xs text-ink-muted">Showing the first 200 rows. All rows will be imported.</p>
            ) : null}
          </Card>

          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {fixedTeamId ? null : (
                <Field label="Team *" htmlFor="import-team">
                  <Select
                    id="import-team"
                    value={teamId}
                    disabled={busy}
                    onChange={(e) => {
                      setTeamId(e.target.value);
                      setAssignTo('');
                    }}
                  >
                    <option value="">Choose a team…</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Assign all to (optional)" htmlFor="import-assign" hint="Leave blank to assign later from the Leads page.">
                <Select id="import-assign" value={assignTo} disabled={busy || !teamId} onChange={(e) => setAssignTo(e.target.value)}>
                  <option value="">Don&apos;t assign yet</option>
                  {teamVolunteers.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <label className="mt-4 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-accent" checked={skipDuplicates} disabled={busy} onChange={(e) => setSkipDuplicates(e.target.checked)} />
              <span>
                Skip numbers that are already in the CRM or repeated in this file
                <span className="block text-ink-muted">Recommended. Untick only if you really want duplicate leads.</span>
              </span>
            </label>

            {runError ? (
              <div className="mt-4">
                <Alert>{runError}</Alert>
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button onClick={runImport} disabled={busy || !teamId || !ready.length}>
                {busy ? 'Importing…' : `Import ${ready.length} lead${ready.length === 1 ? '' : 's'}`}
              </Button>
              {invalid.length || repeats.length ? (
                <Button variant="secondary" onClick={downloadProblems} disabled={busy}>
                  Download rows that will be skipped
                </Button>
              ) : null}
            </div>
            {progress && busy ? (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Import progress">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(4, (progress.done / progress.total) * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {progress.done} of {progress.total} sent… keep this page open.
                </p>
              </div>
            ) : null}
          </Card>
        </>
      )}
    </div>
  );
}

function PreviewRow({ row, skipRepeats, courseName }: { row: CheckedRow; skipRepeats: boolean; courseName?: string }) {
  const repeat = skipRepeats && row.duplicateOfLine !== null && !row.errors.length;
  return (
    <tr className={cn(row.errors.length ? 'bg-danger-soft' : repeat ? 'text-ink-muted' : undefined)}>
      <td className="px-4 py-2 text-ink-muted tabular-nums">{row.line}</td>
      <td className="px-4 py-2">{row.raw.full_name || <span className="text-ink-muted">-</span>}</td>
      <td className="px-4 py-2 whitespace-nowrap tabular-nums">{row.lead ? formatPhone(row.lead.phone) : row.raw.phone || '-'}</td>
      <td className="hidden px-4 py-2 md:table-cell">{courseName ?? <span className="text-ink-muted">-</span>}</td>
      <td className="px-4 py-2 text-xs">
        {row.errors.map((e) => (
          <p key={e} className="text-danger">
            {e}
          </p>
        ))}
        {repeat ? <p>Same phone as row {row.duplicateOfLine}, skipped</p> : null}
        {row.warnings.map((w) => (
          <p key={w} className="text-warn">
            {w}
          </p>
        ))}
      </td>
    </tr>
  );
}
