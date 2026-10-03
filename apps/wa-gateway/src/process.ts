// What happens after a new incoming message is stored: work out what it asks,
// build a reply from verified CRM data, and hand both to the database, which
// decides whether the reply is sent, suggested, or not used (dv_record_intent).
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCourseAnswer, detectIntent, extractRequestedCount, parseApprovalReply, type AnswerCourse, type AnswerSession, type DvTemplateKind } from '@crm/shared';
import { aiEnabled, classifyWithAi } from './ai.js';

type Data = {
  courses: AnswerCourse[];
  sessions: (AnswerSession & { team_id: string | null })[];
  templates: Partial<Record<DvTemplateKind, string>>;
  timeZone: string;
  teamByGroup: Map<string, string | null>;
  loadedAt: number;
};
let cache: Data | null = null;

/** Courses, upcoming sessions and templates, refreshed at most once a minute. */
async function loadData(db: SupabaseClient): Promise<Data> {
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache;
  const [courses, sessions, templates, settings, groups] = await Promise.all([
    db.from('courses').select('id, name, short_description, registration_url, is_active'),
    db
      .from('course_sessions')
      .select('id, course_id, title, starts_at, ends_at, timezone, schedule_note, mode, venue, city, meeting_url, registration_url, instructor_name, status, team_id')
      .eq('status', 'scheduled')
      .gt('ends_at', new Date().toISOString())
      .order('starts_at')
      .limit(200),
    db.from('dv_response_templates').select('kind, body'),
    db.from('org_settings').select('default_timezone').single(),
    db.from('wa_groups').select('id, responsible:profiles!wa_groups_responsible_admin_id_fkey(team_id)'),
  ]);
  for (const r of [courses, sessions, templates]) if (r.error) throw new Error(r.error.message);
  cache = {
    courses: (courses.data ?? []) as AnswerCourse[],
    sessions: (sessions.data ?? []) as Data['sessions'],
    templates: Object.fromEntries((templates.data ?? []).map((t) => [t.kind, t.body])),
    timeZone: (settings.data?.default_timezone as string | undefined) ?? 'Asia/Kolkata',
    teamByGroup: new Map(
      ((groups.data ?? []) as unknown as { id: string; responsible: { team_id: string | null } | null }[]).map((g) => [g.id, g.responsible?.team_id ?? null]),
    ),
    loadedAt: Date.now(),
  };
  return cache;
}

const looksLikeQuestion = (t: string) => t.includes('?') || t.trim().split(/\s+/).length >= 4;

export async function processMessage(
  db: SupabaseClient,
  msg: { id: string; groupId: string | null; text: string | null },
  log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void },
): Promise<void> {
  const text = msg.text?.trim() ?? '';

  // A private "YES 12" / "NO 12 reason" may be an approver deciding a seva request.
  // The database decides whether the sender really is an approver; if not, it is
  // handled as an ordinary message below.
  const decision = msg.groupId ? null : parseApprovalReply(text);
  if (decision) {
    const { data, error } = await db.rpc('dv_seva_whatsapp_decision', {
      p_message_id: msg.id,
      p_action: decision.action,
      p_ref: decision.ref,
      p_count: decision.count,
      p_reason: decision.reason,
    });
    if (error) log.warn({ err: error.message, id: msg.id }, 'approval reply failed');
    else if ((data as { handled?: boolean } | null)?.handled) {
      log.info({ id: msg.id, action: decision.action, ref: decision.ref }, 'seva decision from WhatsApp');
      return;
    }
  }

  let intent = detectIntent(text).intent;
  let source: 'keywords' | 'ai' = 'keywords';
  let courseHintIds: string[] = [];
  const data = await loadData(db);

  // Teams only see their own sessions; public (no team) sessions are shared everywhere.
  const team = msg.groupId ? (data.teamByGroup.get(msg.groupId) ?? null) : null;
  const sessions = data.sessions.filter((s) => s.team_id === null || s.team_id === team);

  if (intent === 'none' && text && aiEnabled() && looksLikeQuestion(text)) {
    const ai = await classifyWithAi(text, data.courses.filter((c) => c.is_active));
    if (ai && ai.intent !== 'none') {
      intent = ai.intent;
      source = 'ai';
      courseHintIds = ai.courseIds;
    }
  }

  let reply: string | null = null;
  let replyKind: DvTemplateKind | null = null;
  if (intent === 'course_info') {
    const answer = buildCourseAnswer({ text, courses: data.courses, sessions, templates: data.templates, timeZone: data.timeZone, courseHintIds });
    reply = answer.body;
    replyKind = answer.kind;
  }

  const { data: result, error } = await db.rpc('dv_record_intent', {
    p_message_id: msg.id,
    p_intent: intent,
    p_source: source,
    p_reply: reply,
    p_reply_kind: replyKind,
    // Only a hint ("share 5 numbers"): the database limits always decide the real number.
    p_requested_count: intent === 'seva_request' ? extractRequestedCount(text) : null,
  });
  if (error) log.warn({ err: error.message, id: msg.id }, 'could not record intent');
  // e.g. {intent: course_info, status: needs_review, send: pending_approval} = suggestion waiting in the Inbox
  else log.info({ id: msg.id, intent, source, replyKind, result }, 'message analysed');
}

/** Called when courses/templates change in the CRM, so answers are never stale. */
export function invalidateAnswerData() {
  cache = null;
}
