'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { detectIntent, DV_RULE_ACTION_INFO, DV_RULE_ACTIONS, matchRule, type DvRule, type DvRuleAction } from '@crm/shared';
import { FormMessage, type ActionState } from '@/components/form';
import { Button, ButtonLink, Field, Input, Select, Textarea } from '@/components/ui';
import { deleteRule, saveRule, setRuleEnabled } from '../rule-actions';

export type CourseOption = { id: string; name: string };

export function RuleForm({ rule, courses }: { rule: DvRule | null; courses: CourseOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState | undefined>();
  const [name, setName] = useState(rule?.name ?? '');
  const [keywords, setKeywords] = useState(rule?.keywords.join(', ') ?? '');
  const [action, setAction] = useState<DvRuleAction>(rule?.action ?? 'reply');
  const [replyBody, setReplyBody] = useState(rule?.reply_body ?? '');
  const [courseId, setCourseId] = useState(rule?.course_id ?? '');
  const [priority, setPriority] = useState(rule?.priority ?? 100);
  const [inGroups, setInGroups] = useState(rule?.in_groups ?? true);
  const [inDirect, setInDirect] = useState(rule?.in_direct ?? true);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  function submit() {
    start(async () => {
      const r = await saveRule({
        id: rule?.id ?? '',
        name,
        keywords,
        action,
        reply_body: replyBody,
        course_id: courseId,
        priority,
        in_groups: inGroups,
        in_direct: inDirect,
        enabled,
      });
      setState(r);
      if (r.ok) router.push('/digital-volunteer/rules');
    });
  }

  return (
    <div className="space-y-4 p-5 text-sm">
      <Field label="Rule name" htmlFor="r-name">
        <Input id="r-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Satsang timing" />
      </Field>
      <Field
        label="Trigger words"
        htmlFor="r-kw"
        hint="Separate with commas or new lines. Whole words or phrases; English, Hinglish and Hindi all work. Not case-sensitive."
      >
        <Textarea id="r-kw" rows={3} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="satsang timing, kab hai satsang, सत्संग" />
      </Field>
      <Field label="What happens" htmlFor="r-action" hint={DV_RULE_ACTION_INFO[action].description}>
        <Select id="r-action" value={action} onChange={(e) => setAction(e.target.value as DvRuleAction)}>
          {DV_RULE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {DV_RULE_ACTION_INFO[a].label}
            </option>
          ))}
        </Select>
      </Field>
      {action === 'reply' ? (
        <Field label="Reply" htmlFor="r-body" hint="Sent exactly as written. Facts here are also what AI drafts may use.">
          <Textarea id="r-body" rows={5} maxLength={2000} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
        </Field>
      ) : null}
      {action === 'course' ? (
        <Field label="Course" htmlFor="r-course" hint="Replies with its next upcoming session, using the Course responses templates.">
          <Select id="r-course" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">Choose a course…</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <fieldset className="space-y-1.5">
        <legend className="mb-1 font-medium">Applies in</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={inGroups} onChange={(e) => setInGroups(e.target.checked)} className="size-4 accent-accent" />
          Groups (only groups where this kind of reply is allowed)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={inDirect} onChange={(e) => setInDirect(e.target.checked)} className="size-4 accent-accent" />
          Private chats
        </label>
      </fieldset>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Order" htmlFor="r-prio" hint="Lower numbers are checked first.">
          <Input id="r-prio" type="number" min={1} max={1000} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 100)} className="w-28" />
        </Field>
        <label className="mb-2 flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-accent" />
          On
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending} onClick={submit}>
          {pending ? 'Saving…' : rule ? 'Save rule' : 'Add rule'}
        </Button>
        {rule ? (
          <ButtonLink href="/digital-volunteer/rules" variant="ghost">
            Cancel
          </ButtonLink>
        ) : null}
      </div>
      <FormMessage state={state} />
    </div>
  );
}

export function RuleRowActions({ id, name, enabled }: { id: string; name: string; enabled: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionState>) => start(async () => setError((await fn()).error ?? null));
  return (
    <span className="flex flex-wrap items-center gap-3 text-sm">
      <ButtonLink href={`/digital-volunteer/rules?edit=${id}`} variant="secondary">
        Edit
      </ButtonLink>
      <button type="button" disabled={pending} className="text-accent underline disabled:opacity-50" onClick={() => run(() => setRuleEnabled(id, !enabled))}>
        {enabled ? 'Turn off' : 'Turn on'}
      </button>
      <button
        type="button"
        disabled={pending}
        className="text-danger underline disabled:opacity-50"
        onClick={() => {
          if (confirm(`Delete the rule "${name}"?`)) run(() => deleteRule(id));
        }}
      >
        Delete
      </button>
      {error ? <span className="text-danger">{error}</span> : null}
    </span>
  );
}

/** Type a message and see what would trigger, using the same matching as the WhatsApp gateway. */
export function RuleTester({ rules, courseNames }: { rules: DvRule[]; courseNames: Record<string, string> }) {
  const [text, setText] = useState('');
  const [where, setWhere] = useState<'group' | 'direct'>('group');
  const hit = text.trim() ? matchRule(text, rules, where) : null;
  const builtIn = text.trim() && !hit ? detectIntent(text).intent : null;

  let result: React.ReactNode = <span className="text-ink-muted">Type a message to see what it triggers.</span>;
  if (hit) {
    const r = hit.rule;
    result = (
      <>
        <span className="font-medium">Rule “{r.name}”</span> <span className="text-ink-muted">(matched “{hit.keyword}”)</span> →{' '}
        {r.action === 'course' ? `${DV_RULE_ACTION_INFO.course.label}: ${courseNames[r.course_id ?? ''] ?? 'course'}` : DV_RULE_ACTION_INFO[r.action].label}
        {r.action === 'reply' && r.reply_body ? <span className="mt-1 block rounded bg-canvas px-2 py-1 whitespace-pre-wrap">{r.reply_body}</span> : null}
      </>
    );
  } else if (builtIn === 'course_info') {
    result = 'No rule. Built-in detection: a course question → course details from Courses and Upcoming Programs.';
  } else if (builtIn === 'seva_request') {
    result = 'No rule. Built-in detection: a seva request.';
  } else if (builtIn === 'none') {
    result = 'Nothing triggers. If AI is set up (Settings → AI), it decides; otherwise the message is only logged.';
  }

  return (
    <div className="space-y-3 p-5 text-sm">
      <label htmlFor="t-text" className="sr-only">
        Test message
      </label>
      <Textarea id="t-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. satsang kab hai?" />
      <div className="flex gap-4">
        <label className="flex items-center gap-1.5">
          <input type="radio" name="t-where" checked={where === 'group'} onChange={() => setWhere('group')} className="accent-accent" /> In a group
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="t-where" checked={where === 'direct'} onChange={() => setWhere('direct')} className="accent-accent" /> Private chat
        </label>
      </div>
      <p aria-live="polite">{result}</p>
    </div>
  );
}
