'use client';
import { useMemo, useState, useTransition } from 'react';
import {
  buildCourseAnswer,
  DV_PLACEHOLDERS,
  DV_TEMPLATE_INFO,
  unknownDvPlaceholders,
  type AnswerCourse,
  type AnswerSession,
  type DvTemplateKind,
} from '@crm/shared';
import { FormMessage, type ActionState } from '@/components/form';
import { PosterInput } from '@/components/poster-input';
import { Badge, Button, Card, Textarea } from '@/components/ui';
import { saveTemplate, setTemplatePoster } from '../actions';

/** Runs the real answer builder with real data, steered to produce this template's case. */
function preview(kind: DvTemplateKind, body: string, courses: AnswerCourse[], sessions: AnswerSession[], timeZone: string): string | null {
  const templates = { [kind]: body };
  const first = sessions[0];
  const firstCourse = first ? courses.find((c) => c.id === first.course_id) : undefined;
  switch (kind) {
    case 'greeting':
      return body;
    case 'course_details':
      return first && firstCourse ? buildCourseAnswer({ text: firstCourse.name, courses, sessions: [first], templates, timeZone }).body : null;
    case 'course_list':
      return sessions.length > 1 ? buildCourseAnswer({ text: 'upcoming?', courses, sessions, templates, timeZone }).body : null;
    case 'no_upcoming':
      return courses[0] ? buildCourseAnswer({ text: courses[0].name, courses: [courses[0]], sessions: [], templates, timeZone }).body : null;
    case 'fallback':
      return buildCourseAnswer({ text: '', courses: [], sessions: [], templates, timeZone }).body;
  }
}

export function TemplateEditor({
  kind,
  saved,
  posterPath,
  posterUrl,
  defaultBody,
  courses,
  sessions,
  timeZone,
}: {
  kind: DvTemplateKind;
  saved: string | null;
  posterPath: string | null;
  posterUrl: string | null;
  defaultBody: string;
  courses: AnswerCourse[];
  sessions: AnswerSession[];
  timeZone: string;
}) {
  const [body, setBody] = useState(saved ?? defaultBody);
  const [state, setState] = useState<ActionState | undefined>();
  const [pending, start] = useTransition();
  const unknown = unknownDvPlaceholders(body);
  const shown = useMemo(() => preview(kind, body, courses, sessions, timeZone), [kind, body, courses, sessions, timeZone]);
  const info = DV_TEMPLATE_INFO[kind];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <div>
          <h2 className="font-semibold">{info.label}</h2>
          <p className="text-xs text-ink-muted">{info.when}</p>
        </div>
        {saved ? <Badge tone="accent">Customised</Badge> : <Badge>Default</Badge>}
      </div>
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor={`tpl-${kind}`} className="text-sm font-medium">
            Template
          </label>
          <Textarea id={`tpl-${kind}`} rows={12} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" aria-invalid={unknown.length > 0} />
          <p className="text-xs text-ink-muted">
            Placeholders:{' '}
            {DV_PLACEHOLDERS.map((p) => (
              <button key={p} type="button" className="mr-1 rounded bg-canvas px-1 font-mono hover:text-ink" onClick={() => setBody((b) => `${b}{{${p}}}`)}>
                {`{{${p}}}`}
              </button>
            ))}
          </p>
          {unknown.length ? <p className="text-xs text-danger">Not available: {unknown.map((u) => `{{${u}}}`).join(', ')}</p> : null}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button disabled={pending || unknown.length > 0 || body === (saved ?? defaultBody)} onClick={() => start(async () => setState(await saveTemplate(kind, body)))}>
              Save
            </Button>
            {saved ? (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await saveTemplate(kind, null);
                    if (r.ok) setBody(defaultBody);
                    setState(r);
                  })
                }
              >
                Reset to default
              </Button>
            ) : null}
            <FormMessage state={state} />
          </div>
        </div>
        <div className="space-y-2">
          {kind !== 'fallback' ? (
            <div className="space-y-1 pb-2">
              <p className="text-sm font-medium">Poster (optional)</p>
              <p className="text-xs text-ink-muted">
                {kind === 'course_details'
                  ? 'Used when the program has no poster of its own, and for the other replies when they have none. '
                  : 'Without one, the One program poster is used. '}
                JPG, PNG or WebP, up to 5 MB.
              </p>
              <PosterInput
                folder="templates"
                currentPath={posterPath}
                currentUrl={posterUrl}
                onChange={async (path) => setState(await setTemplatePoster(kind, path))}
              />
            </div>
          ) : null}
          <p className="text-sm font-medium">Preview with your data</p>
          {shown ? (
            <div className="rounded-xl border border-line bg-canvas px-4 py-3 text-sm whitespace-pre-wrap">{shown}</div>
          ) : (
            <p className="rounded-xl border border-dashed border-line-strong px-4 py-3 text-sm text-ink-muted">
              {kind === 'course_list' ? 'Needs at least two upcoming programs to preview.' : 'Add an upcoming program to preview this.'}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
