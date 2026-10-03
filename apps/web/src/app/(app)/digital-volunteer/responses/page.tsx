import type { Metadata } from 'next';
import { DEFAULT_DV_TEMPLATES, DV_TEMPLATE_KINDS, type AnswerCourse, type AnswerSession, type DvTemplateKind } from '@crm/shared';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { createClient } from '@/lib/supabase/server';
import { TemplateEditor } from './template-editor';

export const metadata: Metadata = { title: 'Course responses' };

export default async function ResponsesPage() {
  await requireDv('manage_content');
  const supabase = await createClient();
  const settings = await getOrgSettings();
  const [{ data: saved }, { data: courses }, { data: sessions }] = await Promise.all([
    supabase.from('dv_response_templates').select('kind, body'),
    supabase.from('courses').select('id, name, short_description, registration_url, is_active').eq('is_active', true).order('name'),
    supabase
      .from('upcoming_sessions')
      .select('id, course_id, title, starts_at, ends_at, timezone, schedule_note, mode, venue, city, meeting_url, registration_url, instructor_name, status')
      .order('starts_at')
      .limit(20),
  ]);
  const savedByKind = new Map((saved ?? []).map((t) => [t.kind as DvTemplateKind, t.body as string]));

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-muted">
        The bot answers course questions using these templates, filled in from <strong className="text-ink">Courses</strong> and{' '}
        <strong className="text-ink">Upcoming Programs</strong>. It never makes up dates, venues or links: a line whose value is missing is left
        out. The preview uses your real upcoming programs.
      </p>
      {DV_TEMPLATE_KINDS.map((kind) => (
        <TemplateEditor
          key={kind}
          kind={kind}
          saved={savedByKind.get(kind) ?? null}
          defaultBody={DEFAULT_DV_TEMPLATES[kind]}
          courses={(courses ?? []) as AnswerCourse[]}
          sessions={(sessions ?? []) as AnswerSession[]}
          timeZone={settings.default_timezone}
        />
      ))}
    </div>
  );
}
