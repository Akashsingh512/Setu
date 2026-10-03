'use client';
import { useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { logExport } from './actions';

export interface DailyPoint {
  day: string;
  calls: number;
  leads_contacted: number;
  assignments: number;
  leads_created: number;
}

const METRICS = [
  { key: 'calls', label: 'Call attempts' },
  { key: 'leads_contacted', label: 'Leads contacted' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'leads_created', label: 'Leads created' },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * One measure at a time over the same days (never two scales on one axis).
 * Bars carry their own hover/focus tooltip; a table view holds every value.
 */
export function DailyChart({ data }: { data: DailyPoint[] }) {
  const [metric, setMetric] = useState<MetricKey>('calls');
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const values = data.map((d) => d[metric]);
  const max = niceMax(Math.max(0, ...values));
  const total = values.reduce((a, b) => a + b, 0);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  const label = METRICS.find((m) => m.key === metric)!.label;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label="Measure" className="inline-flex rounded-lg border border-line-strong p-0.5 text-sm">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={metric === m.key}
              onClick={() => setMetric(m.key)}
              className={cn('rounded-md px-2.5 py-1.5', metric === m.key ? 'bg-ink font-medium text-on-ink' : 'text-ink-muted hover:text-ink')}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-ink-muted">
          <span className="font-semibold text-ink tabular-nums">{total}</span> {label.toLowerCase()} in range
        </p>
      </div>

      <div ref={wrap} className="relative">
        <div className="flex h-48 gap-2">
          {/* y axis */}
          <div className="relative w-8 shrink-0 text-right text-xs text-ink-muted tabular-nums">
            {ticks.map((t) => (
              <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / max) * 100}%` }}>
                {t}
              </span>
            ))}
          </div>
          <div className="relative flex-1 border-b border-line-strong">
            {ticks.slice(1).map((t) => (
              <div key={t} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${100 - (t / max) * 100}%` }} />
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {data.map((d, i) => {
                const v = d[metric];
                return (
                  <button
                    key={d.day}
                    type="button"
                    aria-label={`${dayLabel(d.day)}: ${v} ${label.toLowerCase()}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="group relative flex h-full flex-1 items-end focus:outline-none"
                  >
                    <span
                      className={cn('w-full rounded-t-[4px] bg-accent transition-opacity', hover !== null && hover !== i && 'opacity-60')}
                      style={{ height: v ? `${Math.max(2, (v / max) * 100)}%` : 0 }}
                    />
                  </button>
                );
              })}
            </div>
            {hover !== null && data[hover] ? (
              <div
                className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-3 py-2 text-sm whitespace-nowrap shadow-md"
                style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
                role="status"
              >
                <p className="text-base font-semibold tabular-nums">{data[hover][metric]}</p>
                <p className="text-xs text-ink-muted">
                  {label} · {dayLabel(data[hover].day)}
                </p>
              </div>
            ) : null}
          </div>
        </div>
        <div className="ml-10 flex gap-[2px] pt-1 text-xs text-ink-muted">
          {data.map((d, i) => (
            <span key={d.day} className="flex-1 overflow-visible text-center whitespace-nowrap">
              {i % labelEvery === 0 ? dayLabel(d.day) : ''}
            </span>
          ))}
        </div>
      </div>

      <button type="button" className="mt-3 text-sm text-ink-muted underline hover:text-ink" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
        {showTable ? 'Hide table' : 'Show as table'}
      </button>
      {showTable ? (
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm tabular-nums">
            <thead className="sticky top-0 bg-surface text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Day</th>
                {METRICS.map((m) => (
                  <th key={m.key} className="px-3 py-2 text-right font-medium">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((d) => (
                <tr key={d.day}>
                  <td className="px-3 py-1.5">{dayLabel(d.day)}</td>
                  {METRICS.map((m) => (
                    <td key={m.key} className="px-3 py-1.5 text-right">
                      {d[m.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** Downloads rows as CSV and records the export in the audit log. */
export function CsvButton({ filename, rows, entity }: { filename: string; rows: Record<string, string | number | null>[]; entity: string }) {
  const [busy, setBusy] = useState(false);
  const csv = useMemo(() => {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]!);
    const cell = (v: string | number | null) => {
      const s = v === null ? '' : String(v);
      // Quote, and neutralise spreadsheet formula injection.
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h] ?? null)).join(','))].join('\n');
  }, [rows]);

  return (
    <button
      type="button"
      disabled={!rows.length || busy}
      className="min-h-9 rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-canvas disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        await logExport(entity, rows.length);
        const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setBusy(false);
      }}
    >
      Download CSV
    </button>
  );
}
