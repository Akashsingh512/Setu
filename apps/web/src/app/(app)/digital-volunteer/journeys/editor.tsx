'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { PosterInput } from '@/components/poster-input';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Textarea } from '@/components/ui';
import { saveJourney, type JourneyInput, type JourneyStepInput } from '../journey-actions';

type Option = { id: string; label: string };
type Step = JourneyStepInput & { key: number; posterUrl: string | null };

const KINDS: { id: JourneyStepInput['kind']; label: string; hint: string }[] = [
  { id: 'message', label: 'WhatsApp message', hint: 'Sent from the Setu number, typed like a person. {{name}}, {{full_name}} and {{volunteer}} are filled in.' },
  { id: 'call_task', label: 'Call by their volunteer', hint: 'A follow-up for the lead’s volunteer, with the usual WhatsApp reminder. The text is the note.' },
  {
    id: 'program_invite',
    label: 'Invite to the next program',
    hint: 'The next upcoming program, with its poster. {{program}}, {{date}}, {{venue}} and {{link}} are filled in. Skipped when none is scheduled.',
  },
];

const DEFAULT_BODY: Record<JourneyStepInput['kind'], string> = {
  message: 'Namaste {{name}} 🙏\n\n',
  call_task: 'Call to ask how the practice is going',
  program_invite: 'Namaste {{name}} 🙏\n\nThe next *{{program}}* is on {{date}}{{venue}}.\nRegister: {{link}}\n\nWould love to see you there!',
};

let nextKey = 1;
const newStep = (kind: JourneyStepInput['kind'], delay: number): Step => ({
  key: nextKey++,
  kind,
  delay_days: delay,
  send_time: '10:00',
  body: DEFAULT_BODY[kind],
  poster_path: null,
  course_id: null,
  posterUrl: null,
});

export function JourneyEditor({
  id,
  initial,
  initialSteps,
  statuses,
  courses,
}: {
  id: string | null;
  initial: JourneyInput;
  initialSteps: (JourneyStepInput & { posterUrl: string | null })[];
  statuses: Option[];
  courses: Option[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [j, setJ] = useState<JourneyInput>(initial);
  const [steps, setSteps] = useState<Step[]>(() =>
    initialSteps.length ? initialSteps.map((s) => ({ ...s, key: nextKey++ })) : [newStep('message', 0), newStep('call_task', 2), newStep('program_invite', 5)],
  );
  const [msg, setMsg] = useState<{ ok?: boolean; text: string } | null>(null);

  const setStep = (key: number, patch: Partial<Step>) => setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (i: number, by: number) =>
    setSteps((all) => {
      const next = [...all];
      const [s] = next.splice(i, 1);
      next.splice(i + by, 0, s!);
      return next;
    });

  // Day of each step, counted from the start.
  const days = steps.map((_, i) => steps.slice(0, i + 1).reduce((sum, s) => sum + s.delay_days, 0));

  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveJourney(
        id,
        j,
        steps.map((s) => ({
          kind: s.kind,
          delay_days: s.delay_days,
          send_time: s.send_time,
          body: s.body,
          poster_path: s.poster_path,
          course_id: s.course_id,
        })),
      );
      if (r.error) setMsg({ text: r.error });
      else if (!id && r.id) router.push(`/digital-volunteer/journeys/${r.id}`);
      else setMsg({ ok: true, text: 'Saved. People already on this journey continue with the new steps.' });
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={id ? 'Journey' : 'New journey'} description="A path that keeps someone connected after they meet the Art of Living." />
        <div className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
          <Field label="Name" htmlFor="j-name">
            <Input id="j-name" value={j.name} maxLength={120} onChange={(e) => setJ({ ...j, name: e.target.value })} placeholder="After the Happiness Program" />
          </Field>
          <Field label="About (only Setu users see it)" htmlFor="j-desc">
            <Input id="j-desc" value={j.description} maxLength={1000} onChange={(e) => setJ({ ...j, description: e.target.value })} placeholder="For everyone who finished the program" />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Steps" description="Each step runs a number of days after the one before, at the time you choose." />
        <ol className="divide-y divide-line">
          {steps.map((s, i) => {
            const kind = KINDS.find((k) => k.id === s.kind)!;
            return (
              <li key={s.key} className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-end gap-3">
                  <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">{i + 1}</span>
                  <Field label="What happens" htmlFor={`s-kind-${s.key}`} className="min-w-52 flex-1">
                    <Select
                      id={`s-kind-${s.key}`}
                      value={s.kind}
                      onChange={(e) => {
                        const k = e.target.value as Step['kind'];
                        setStep(s.key, { kind: k, body: s.body === DEFAULT_BODY[s.kind] ? DEFAULT_BODY[k] : s.body });
                      }}
                    >
                      {KINDS.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={i === 0 ? 'Days after starting' : 'Days after the step before'} htmlFor={`s-days-${s.key}`} className="w-44">
                    <Input
                      id={`s-days-${s.key}`}
                      type="number"
                      min={0}
                      max={365}
                      value={s.delay_days}
                      onChange={(e) => setStep(s.key, { delay_days: Math.max(0, Math.min(365, Math.round(Number(e.target.value) || 0))) })}
                    />
                  </Field>
                  <Field label="At" htmlFor={`s-time-${s.key}`} className="w-32">
                    <Input id={`s-time-${s.key}`} type="time" value={s.send_time} onChange={(e) => setStep(s.key, { send_time: e.target.value })} />
                  </Field>
                  <span className="pb-2 text-xs text-ink-muted">Day {days[i]}</span>
                  <div className="ml-auto flex gap-1 pb-1">
                    <Button variant="ghost" className="min-h-9 px-2" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                      ↑
                    </Button>
                    <Button variant="ghost" className="min-h-9 px-2" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                      ↓
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-9 px-2 text-danger"
                      disabled={steps.length === 1}
                      onClick={() => setSteps((all) => all.filter((x) => x.key !== s.key))}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {s.kind === 'program_invite' ? (
                  <Field label="Program" htmlFor={`s-course-${s.key}`} className="max-w-sm">
                    <Select id={`s-course-${s.key}`} value={s.course_id ?? ''} onChange={(e) => setStep(s.key, { course_id: e.target.value || null })}>
                      <option value="">Any upcoming program</option>
                      {courses.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label={s.kind === 'call_task' ? 'Note for the volunteer' : 'Message'} htmlFor={`s-body-${s.key}`} hint={kind.hint}>
                  <Textarea
                    id={`s-body-${s.key}`}
                    rows={s.kind === 'call_task' ? 2 : 5}
                    maxLength={3900}
                    value={s.body}
                    onChange={(e) => setStep(s.key, { body: e.target.value })}
                  />
                </Field>
                {s.kind !== 'call_task' ? (
                  <Field label={s.kind === 'program_invite' ? 'Poster (optional; else the program’s own)' : 'Poster (optional)'} htmlFor={`s-poster-${s.key}`}>
                    <PosterInput
                      id={`s-poster-${s.key}`}
                      folder="announcements"
                      currentPath={s.poster_path}
                      currentUrl={s.posterUrl}
                      onChange={(p) => setStep(s.key, { poster_path: p })}
                    />
                  </Field>
                ) : null}
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4">
          {KINDS.map((k) => (
            <Button key={k.id} variant="secondary" disabled={steps.length >= 100} onClick={() => setSteps((all) => [...all, newStep(k.id, 3)])}>
              + {k.label}
            </Button>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="When they write back" description="Every reply is also in the Inbox." />
        <div className="space-y-3 px-5 pb-5 text-sm">
          <Check checked={j.ai_auto_reply} onChange={(v) => setJ({ ...j, ai_auto_reply: v })} label="Setu answers by itself">
            Reply rules, course answers and AI (when it is set up) reply straight away, warmly, using only what Setu knows. Personal or health problems get
            “your volunteer will call you”.
          </Check>
          <Check checked={j.forward_replies} onChange={(v) => setJ({ ...j, forward_replies: v })} label="Send their message to their volunteer">
            The volunteer gets it on WhatsApp and answers by swiping right on it. The answer goes from the Setu number, signed with the volunteer’s name.
          </Check>
          <Check checked={j.pause_on_reply} onChange={(v) => setJ({ ...j, pause_on_reply: v })} label="Wait for the volunteer before the next step">
            The journey pauses until the volunteer answers, or until{' '}
            <Input
              type="number"
              min={1}
              max={720}
              aria-label="Hours to wait"
              className="inline-block min-h-8 w-20 px-2 py-1"
              value={j.resume_after_hours}
              onChange={(e) => setJ({ ...j, resume_after_hours: Math.max(1, Math.min(720, Math.round(Number(e.target.value) || 1))) })}
            />{' '}
            hours pass.
          </Check>
        </div>
      </Card>

      <Card>
        <CardHeader title="When the journey stops" description="“Do not contact” and STOP replies always stop it." />
        <div className="grid gap-2 px-5 pb-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {statuses.map((s) => (
            <label key={s.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={j.stop_statuses.includes(s.id)}
                onChange={(e) =>
                  setJ({ ...j, stop_statuses: e.target.checked ? [...j.stop_statuses, s.id] : j.stop_statuses.filter((x) => x !== s.id) })
                }
              />
              Status becomes {s.label}
            </label>
          ))}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-accent" checked={j.active} onChange={(e) => setJ({ ...j, active: e.target.checked })} />
          Journey is on (off = everyone on it waits)
        </label>
        <Button className="ml-auto" onClick={save} disabled={pending}>
          {pending ? 'Saving…' : id ? 'Save journey' : 'Create journey'}
        </Button>
      </div>
      {msg ? <Alert tone={msg.ok ? 'ok' : 'danger'}>{msg.text}</Alert> : null}
    </div>
  );
}

function Check({ checked, onChange, label, children }: { checked: boolean; onChange: (v: boolean) => void; label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" className="mt-0.5 size-4 accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-ink-muted">{children}</span>
      </span>
    </label>
  );
}
