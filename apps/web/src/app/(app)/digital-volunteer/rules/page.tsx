import type { Metadata } from 'next';
import { DV_RULE_ACTION_INFO, type DvRule } from '@crm/shared';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import { requireDv } from '@/lib/dv';
import { createClient } from '@/lib/supabase/server';
import { RuleForm, RuleRowActions, RuleTester } from './controls';

export const metadata: Metadata = { title: 'Reply rules' };

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const access = await requireDv();
  const canEdit = access.can('manage_content');
  const [{ edit }, supabase] = await Promise.all([searchParams, createClient()]);
  const [{ data: rows }, { data: courses }] = await Promise.all([
    supabase.from('dv_rules').select('*').order('priority').order('name'),
    supabase.from('courses').select('id, name').eq('is_active', true).order('name'),
  ]);
  const rules = (rows ?? []) as DvRule[];
  const courseNames = Object.fromEntries((courses ?? []).map((c) => [c.id as string, c.name as string]));
  const editing = edit ? (rules.find((r) => r.id === edit) ?? null) : null;

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-ink-muted">
        Rules decide what a message triggers. They are checked first, in order; then the built-in course and seva detection; then AI (if it is set up in
        Settings). Group, mode and permission settings still apply: a rule can only reply where replies are allowed, and in Assisted mode a person approves
        first.
      </p>

      <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
        <section aria-labelledby="rules-h" className="space-y-3">
          <h2 id="rules-h" className="font-semibold">
            Rules {rules.length ? <span className="text-ink-muted">({rules.length})</span> : null}
          </h2>
          {rules.length === 0 ? (
            <Card>
              <EmptyState title="No rules yet" description="Add one on the right, e.g. “satsang timing” → your reply with the satsang time." />
            </Card>
          ) : (
            <ol className="space-y-3">
              {rules.map((r) => (
                <li key={r.id}>
                  <Card className={`p-4 text-sm ${r.enabled ? '' : 'opacity-60'}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          <span className="mr-2 text-ink-muted">#{r.priority}</span>
                          {r.name}
                        </p>
                        <p className="text-xs text-ink-muted">
                          {r.action === 'course' ? `Send course details: ${courseNames[r.course_id ?? ''] ?? 'course'}` : DV_RULE_ACTION_INFO[r.action].label} ·{' '}
                          {r.in_groups && r.in_direct ? 'groups and private chats' : r.in_groups ? 'groups only' : 'private chats only'}
                        </p>
                      </div>
                      <Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {r.keywords.map((k) => (
                        <li key={k}>
                          <Badge>{k}</Badge>
                        </li>
                      ))}
                    </ul>
                    {r.action === 'reply' && r.reply_body ? <p className="mt-2 line-clamp-3 rounded-lg bg-canvas px-3 py-2 whitespace-pre-wrap">{r.reply_body}</p> : null}
                    {canEdit ? (
                      <div className="mt-3">
                        <RuleRowActions id={r.id} name={r.name} enabled={r.enabled} />
                      </div>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Try a message" description="See what a message would trigger, before anyone sends it." />
            <RuleTester rules={rules} courseNames={courseNames} />
          </Card>
          {canEdit ? (
            <Card>
              <CardHeader title={editing ? 'Edit rule' : 'New rule'} />
              <RuleForm key={editing?.id ?? 'new'} rule={editing} courses={(courses ?? []) as { id: string; name: string }[]} />
            </Card>
          ) : (
            <p className="text-sm text-ink-muted">Ask a super admin for the Course responses permission to change rules.</p>
          )}
        </div>
      </div>
    </div>
  );
}
