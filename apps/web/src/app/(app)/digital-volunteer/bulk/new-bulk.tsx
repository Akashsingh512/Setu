'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { PosterInput } from '@/components/poster-input';
import { Alert, Button, Card, CardHeader, cn, Field, Input, Select, Textarea } from '@/components/ui';
import { createBulk, previewBulk, type BulkInput, type BulkPreview } from '../bulk-actions';

type Option = { id: string; label: string };

const num = (v: string, fallback: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fallback : Math.round(Number(v)));

function duration(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  const h = seconds / 3600;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

export function NewBulk({ statuses, courses, teams }: { statuses: Option[]; courses: Option[]; teams: Option[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('Namaste {{name}} 🙏\n\n');
  const [poster, setPoster] = useState<string | null>(null);
  const [startMode, setStartMode] = useState<'now' | 'later'>('now');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);

  const [useLeads, setUseLeads] = useState(false);
  const [leads, setLeads] = useState({ status: '', course: '', team: '', assignee: '', from: '', to: '' });
  const [useMembers, setUseMembers] = useState(false);
  const [members, setMembers] = useState<{ role: 'volunteer' | 'teacher' | 'all'; team: string }>({ role: 'volunteer', team: '' });
  const [pasted, setPasted] = useState('');

  const [pace, setPace] = useState({
    minGap: '45',
    maxGap: '120',
    typingMin: '3',
    typingMax: '8',
    dailyCap: '200',
    windowStart: '09:00',
    windowEnd: '20:00',
    batchSize: '25',
    batchPause: '10',
    startAt: '',
  });
  const [preview, setPreview] = useState<BulkPreview | null>(null);

  const input = (): BulkInput => ({
    title,
    body,
    posterPath: poster,
    addStopLine: false,
    sendDays: days,
    leads: useLeads ? leads : null,
    members: useMembers ? members : null,
    pasted,
    pace: {
      minGap: num(pace.minGap, 45),
      maxGap: num(pace.maxGap, 120),
      typingMin: num(pace.typingMin, 3),
      typingMax: num(pace.typingMax, 8),
      dailyCap: num(pace.dailyCap, 200),
      windowStart: pace.windowStart,
      windowEnd: pace.windowEnd,
      batchSize: num(pace.batchSize, 0),
      batchPause: num(pace.batchPause, 0),
      startAt: startMode === 'later' ? pace.startAt : '',
    },
  });

  // Rough time to send everything, from the chosen pace.
  const estimate = useMemo(() => {
    const n = preview?.counts?.recipients;
    if (!n) return null;
    const p = input().pace;
    const per = (p.minGap + p.maxGap) / 2;
    const pauses = p.batchSize > 0 ? Math.floor((n - 1) / p.batchSize) * p.batchPause * 60 : 0;
    const days = Math.ceil(n / p.dailyCap);
    return { total: duration(n * per + pauses), days };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when the preview changes
  }, [preview, pace]);

  const changed = () => setPreview(null);

  function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 400_000) return setPreview({ error: 'The file is too large (400 KB max). Split it into smaller lists.' });
    const reader = new FileReader();
    reader.onload = () => {
      setPasted((p) => (p.trim() ? `${p.trim()}\n` : '') + String(reader.result ?? ''));
      changed();
    };
    reader.readAsText(file);
  }

  return (
    <Card>
      <CardHeader
        title="New bulk message"
        description="Sent one by one, with random gaps and 'typing…' first, only during your sending hours and up to your daily limit. Numbers that replied STOP and 'Do not contact' leads are always left out."
      />
      <div className="flex flex-col gap-6 p-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Field label="Name (only you see it)" htmlFor="b-title">
              <Input id="b-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Happiness Program, October" />
            </Field>
            <Field
              label="Message"
              htmlFor="b-body"
              hint="{{name}} = first name, {{full_name}} = full name. A different name in each message helps it not look like spam."
            >
              <Textarea id="b-body" rows={9} value={body} maxLength={3900} onChange={(e) => (setBody(e.target.value), changed())} />
            </Field>
            <Field label="Poster (optional)" htmlFor="b-poster">
              <PosterInput id="b-poster" folder="announcements" currentPath={null} currentUrl={null} onChange={(p) => setPoster(p)} />
            </Field>
          </div>

          <div className="flex flex-col gap-4">
            <p className="text-sm font-medium">Who gets it (choose one or more)</p>
            <fieldset className={cn('rounded-lg border p-3', useLeads ? 'border-accent' : 'border-line')}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" className="size-4 accent-accent" checked={useLeads} onChange={(e) => (setUseLeads(e.target.checked), changed())} />
                Leads
              </label>
              {useLeads ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Select aria-label="Status" value={leads.status} onChange={(e) => (setLeads({ ...leads, status: e.target.value }), changed())}>
                    <option value="">Any status</option>
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="Course" value={leads.course} onChange={(e) => (setLeads({ ...leads, course: e.target.value }), changed())}>
                    <option value="">Any course</option>
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                  {teams.length ? (
                    <Select aria-label="Team" value={leads.team} onChange={(e) => (setLeads({ ...leads, team: e.target.value }), changed())}>
                      <option value="">Any team</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  <Select aria-label="Assigned" value={leads.assignee} onChange={(e) => (setLeads({ ...leads, assignee: e.target.value }), changed())}>
                    <option value="">Assigned or not</option>
                    <option value="none">Unassigned only</option>
                    <option value="assigned">Assigned only</option>
                  </Select>
                  <Field label="Added from" htmlFor="b-from">
                    <Input id="b-from" type="date" value={leads.from} onChange={(e) => (setLeads({ ...leads, from: e.target.value }), changed())} />
                  </Field>
                  <Field label="Added until" htmlFor="b-to">
                    <Input id="b-to" type="date" value={leads.to} onChange={(e) => (setLeads({ ...leads, to: e.target.value }), changed())} />
                  </Field>
                </div>
              ) : null}
            </fieldset>

            <fieldset className={cn('rounded-lg border p-3', useMembers ? 'border-accent' : 'border-line')}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" className="size-4 accent-accent" checked={useMembers} onChange={(e) => (setUseMembers(e.target.checked), changed())} />
                Volunteers / teachers
              </label>
              {useMembers ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Select
                    aria-label="Who"
                    value={members.role}
                    onChange={(e) => (setMembers({ ...members, role: e.target.value as 'volunteer' | 'teacher' | 'all' }), changed())}
                  >
                    <option value="volunteer">Volunteers</option>
                    <option value="teacher">Teachers</option>
                    <option value="all">Everyone with a phone number</option>
                  </Select>
                  {teams.length ? (
                    <Select aria-label="Team" value={members.team} onChange={(e) => (setMembers({ ...members, team: e.target.value }), changed())}>
                      <option value="">Any team</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                </div>
              ) : null}
            </fieldset>

            <Field
              label="Paste or upload numbers"
              htmlFor="b-paste"
              hint="One person per line: 'Name, number', 'number, name' or just the number. CSV files work too."
            >
              <Textarea
                id="b-paste"
                rows={4}
                value={pasted}
                onChange={(e) => (setPasted(e.target.value), changed())}
                placeholder={'Asha Rao, 98450 12345\n+91 99000 11111'}
              />
            </Field>
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="text-sm"
              onChange={(e) => (readFile(e.target.files?.[0]), (e.target.value = ''))}
            />
          </div>
        </div>

        <div className="rounded-xl border border-line p-4">
          <p className="mb-3 text-sm font-medium">When to send</p>
          <div className="grid gap-4 lg:grid-cols-3">
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1 text-xs font-medium text-ink-muted">Start</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="b-start-mode"
                  className="size-4 accent-accent"
                  checked={startMode === 'now'}
                  onChange={() => (setStartMode('now'), changed())}
                />
                Now
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="b-start-mode"
                  className="size-4 accent-accent"
                  checked={startMode === 'later'}
                  onChange={() => (setStartMode('later'), changed())}
                />
                At a date and time
              </label>
              {startMode === 'later' ? (
                <Input
                  aria-label="Start date and time"
                  type="datetime-local"
                  value={pace.startAt}
                  onChange={(e) => (setPace({ ...pace, startAt: e.target.value }), changed())}
                />
              ) : null}
            </fieldset>
            <fieldset className="text-sm">
              <legend className="mb-2 text-xs font-medium text-ink-muted">Only on these days</legend>
              <div className="flex flex-wrap gap-1.5">
                {(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const).map((d, i) => {
                  const on = days.includes(i + 1);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        setDays((cur) => (on ? (cur.length > 1 ? cur.filter((x) => x !== i + 1) : cur) : [...cur, i + 1].sort()));
                        changed();
                      }}
                      className={cn(
                        'min-h-9 rounded-md border px-2.5 text-sm',
                        on ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-muted hover:bg-canvas',
                      )}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Field label="Only between" htmlFor="b-from-h" hint="Empty = any time of day">
              <div className="flex items-center gap-1">
                <Input id="b-from-h" type="time" value={pace.windowStart} onChange={(e) => (setPace({ ...pace, windowStart: e.target.value }), changed())} />
                <span className="text-ink-muted">–</span>
                <Input aria-label="Until" type="time" value={pace.windowEnd} onChange={(e) => (setPace({ ...pace, windowEnd: e.target.value }), changed())} />
              </div>
            </Field>
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Pace (so it looks like a person, not a robot)</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Gap between messages (s)" htmlFor="b-gap">
              <div className="flex items-center gap-1">
                <Input id="b-gap" type="number" min={5} value={pace.minGap} onChange={(e) => (setPace({ ...pace, minGap: e.target.value }), changed())} />
                <span className="text-ink-muted">–</span>
                <Input
                  aria-label="Longest gap"
                  type="number"
                  min={5}
                  value={pace.maxGap}
                  onChange={(e) => (setPace({ ...pace, maxGap: e.target.value }), changed())}
                />
              </div>
            </Field>
            <Field label="'Typing…' shown (s)" htmlFor="b-typing">
              <div className="flex items-center gap-1">
                <Input
                  id="b-typing"
                  type="number"
                  min={0}
                  max={30}
                  value={pace.typingMin}
                  onChange={(e) => (setPace({ ...pace, typingMin: e.target.value }), changed())}
                />
                <span className="text-ink-muted">–</span>
                <Input
                  aria-label="Longest typing"
                  type="number"
                  min={0}
                  max={30}
                  value={pace.typingMax}
                  onChange={(e) => (setPace({ ...pace, typingMax: e.target.value }), changed())}
                />
              </div>
            </Field>
            <Field label="Daily limit" htmlFor="b-cap">
              <Input
                id="b-cap"
                type="number"
                min={1}
                max={2000}
                value={pace.dailyCap}
                onChange={(e) => (setPace({ ...pace, dailyCap: e.target.value }), changed())}
              />
            </Field>
            <Field label="Break after every … messages" htmlFor="b-batch" hint="0 = no breaks">
              <div className="flex items-center gap-1">
                <Input
                  id="b-batch"
                  type="number"
                  min={0}
                  value={pace.batchSize}
                  onChange={(e) => (setPace({ ...pace, batchSize: e.target.value }), changed())}
                />
                <span className="text-xs text-ink-muted">for</span>
                <Input
                  aria-label="Break minutes"
                  type="number"
                  min={0}
                  value={pace.batchPause}
                  onChange={(e) => (setPace({ ...pace, batchPause: e.target.value }), changed())}
                />
                <span className="text-xs text-ink-muted">min</span>
              </div>
            </Field>
          </div>
        </div>

        {preview?.error ? <Alert>{preview.error}</Alert> : null}
        {preview?.ok && preview.counts && !preview.id ? (
          <div className="grid gap-4 rounded-xl border border-line bg-canvas p-4 text-sm lg:grid-cols-2">
            <div>
              <p className="text-lg font-semibold">{preview.counts.recipients} people will get it</p>
              <ul className="mt-1 text-ink-muted">
                {preview.counts.duplicates ? <li>{preview.counts.duplicates} duplicate number(s) left out</li> : null}
                {preview.counts.opted_out ? <li>{preview.counts.opted_out} replied STOP before: left out</li> : null}
                {preview.counts.do_not_contact ? <li>{preview.counts.do_not_contact} marked Do not contact: left out</li> : null}
                {preview.counts.invalid ? <li>{preview.counts.invalid} invalid number(s) left out</li> : null}
                {preview.counts.unreadable ? <li>{preview.counts.unreadable} pasted line(s) had no readable number</li> : null}
              </ul>
              {estimate ? (
                <p className="mt-2">
                  Takes about <strong>{estimate.total}</strong> of sending
                  {estimate.days > 1 ? (
                    <>
                      , spread over <strong>{estimate.days} days</strong> by the daily limit
                    </>
                  ) : null}
                  .
                </p>
              ) : null}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-ink-muted">The first message will read</p>
              <p className="rounded-lg border border-line bg-surface p-3 whitespace-pre-wrap">{preview.sample}</p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={() => start(async () => setPreview(await previewBulk(input())))}>
            {pending && !preview ? 'Checking…' : 'Check the list'}
          </Button>
          <Button
            disabled={pending || !preview?.ok || !preview.counts?.recipients}
            onClick={() => {
              if (!confirm(`Send "${title || 'this message'}" to ${preview?.counts?.recipients} people, slowly, as set above?`)) return;
              start(async () => {
                const r = await createBulk(input());
                setPreview(r);
                if (r.ok && r.id) router.push(`/digital-volunteer/bulk/${r.id}`);
              });
            }}
          >
            Schedule bulk message
          </Button>
        </div>
      </div>
    </Card>
  );
}
