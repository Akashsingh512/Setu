// What happens after a new incoming message is stored: work out what it asks,
// build a reply from verified CRM data, and hand both to the database, which
// decides whether the reply is sent, suggested, or not used (dv_record_intent).
//
// Order: an approver's SEND/EDIT/SKIP or YES/NO -> reply rules -> built-in keyword
// detection -> AI classification for anything still unclear -> AI draft when a
// real question has no answer in Setu (a draft is never sent without a person).
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildCourseAnswer,
  detectIntent,
  extractRequestedCount,
  matchRule,
  parseApprovalReply,
  parseDraftReply,
  type AnswerCourse,
  type AnswerSession,
  type DvRule,
  type DvTemplateKind,
} from '@crm/shared';
import { aiClassifyEnabled, aiDraftEnabled, classifyWithAi, draftReply, loadAiSettings } from './ai.js';

type Data = {
  courses: AnswerCourse[];
  sessions: (AnswerSession & { team_id: string | null })[];
  templates: Partial<Record<DvTemplateKind, string>>;
  rules: DvRule[];
  timeZone: string;
  teamByGroup: Map<string, string | null>;
  loadedAt: number;
};
let cache: Data | null = null;

/** Courses, upcoming sessions, templates and rules, refreshed at most once a minute. */
async function loadData(db: SupabaseClient): Promise<Data> {
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache;
  const [courses, sessions, templates, settings, groups, rules] = await Promise.all([
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
    db.from('dv_rules').select('id, name, enabled, priority, keywords, action, reply_body, course_id, in_groups, in_direct').eq('enabled', true),
  ]);
  for (const r of [courses, sessions, templates]) if (r.error) throw new Error(r.error.message);
  cache = {
    courses: (courses.data ?? []) as AnswerCourse[],
    sessions: (sessions.data ?? []) as Data['sessions'],
    templates: Object.fromEntries((templates.data ?? []).map((t) => [t.kind, t.body])),
    rules: (rules.data ?? []) as DvRule[], // missing table (migration not run yet) = no rules
    timeZone: (settings.data?.default_timezone as string | undefined) ?? 'Asia/Kolkata',
    teamByGroup: new Map(
      ((groups.data ?? []) as unknown as { id: string; responsible: { team_id: string | null } | null }[]).map((g) => [g.id, g.responsible?.team_id ?? null]),
    ),
    loadedAt: Date.now(),
  };
  return cache;
}

const looksLikeQuestion = (t: string) => t.includes('?') || t.trim().split(/\s+/).length >= 4;

/** Everything Setu knows that an AI draft may use: courses, upcoming sessions, rule replies. */
function factsFor(data: Data, sessions: Data['sessions']): string {
  const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: data.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const byId = new Map(data.courses.map((c) => [c.id, c]));
  const lines: string[] = [];
  const active = data.courses.filter((c) => c.is_active);
  if (active.length) {
    lines.push('Courses:');
    for (const c of active) lines.push(`- ${c.name}${c.short_description ? `: ${c.short_description}` : ''}${c.registration_url ? ` (register: ${c.registration_url})` : ''}`);
  }
  const upcoming = sessions.filter((s) => byId.get(s.course_id)?.is_active).slice(0, 15);
  if (upcoming.length) {
    lines.push('Upcoming sessions:');
    for (const s of upcoming) {
      const c = byId.get(s.course_id)!;
      const where = s.mode === 'online' ? 'Online' : [s.venue, s.city].filter(Boolean).join(', ');
      const link = s.registration_url ?? c.registration_url;
      lines.push(`- ${s.title || c.name}: ${fmt.format(new Date(s.starts_at))} to ${fmt.format(new Date(s.ends_at))}${where ? ` · ${where}` : ''}${link ? ` · register: ${link}` : ''}`);
    }
  }
  const answers = data.rules.filter((r) => r.action === 'reply' && r.reply_body);
  if (answers.length) {
    lines.push('Known answers:');
    for (const r of answers) lines.push(`- ${r.name}: ${r.reply_body}`);
  }
  return lines.join('\n');
}

export async function processMessage(
  db: SupabaseClient,
  msg: { id: string; groupId: string | null; text: string | null },
  log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void },
): Promise<void> {
  const text = msg.text?.trim() ?? '';

  // Private "SEND 12" / "EDIT 12 ..." / "SKIP 12": an approver deciding a suggested reply.
  const draft = msg.groupId ? null : parseDraftReply(text);
  if (draft) {
    const { data, error } = await db.rpc('dv_reply_whatsapp_decision', { p_message_id: msg.id, p_action: draft.action, p_ref: draft.ref, p_text: draft.text });
    if (error) log.warn({ err: error.message, id: msg.id }, 'reply decision failed');
    else if ((data as { handled?: boolean } | null)?.handled) {
      log.info({ id: msg.id, action: draft.action, ref: draft.ref }, 'suggested reply decided on WhatsApp');
      return;
    }
  }

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

  const data = await loadData(db);
  await loadAiSettings(db).catch(() => {});
  // Teams only see their own sessions; public (no team) sessions are shared everywhere.
  const team = msg.groupId ? (data.teamByGroup.get(msg.groupId) ?? null) : null;
  const sessions = data.sessions.filter((s) => s.team_id === null || s.team_id === team);
  const where = msg.groupId ? 'group' : 'direct';
  const usableRules = data.rules.filter((r) => (where === 'group' ? r.in_groups : r.in_direct));

  let intent: string = 'none';
  let source: 'keywords' | 'ai' | 'rule' = 'keywords';
  let rule: DvRule | null = null;
  let courseHintIds: string[] = [];
  let aiQuestion = false;

  // 1. Reply rules set up in Setu.
  const hit = matchRule(text, data.rules, where);
  if (hit) {
    rule = hit.rule;
    source = 'rule';
  } else {
    // 2. Built-in keyword detection.
    intent = detectIntent(text).intent;
    // 3. AI for anything still unclear.
    if (intent === 'none' && text && aiClassifyEnabled() && looksLikeQuestion(text)) {
      const ai = await classifyWithAi(text, data.courses.filter((c) => c.is_active), usableRules);
      if (ai && ai.intent !== 'none') {
        source = 'ai';
        if (ai.ruleIndex !== null) rule = usableRules[ai.ruleIndex] ?? null;
        else if (ai.intent === 'question') aiQuestion = true;
        else intent = ai.intent;
        courseHintIds = ai.courseIds;
      }
    }
  }

  let reply: string | null = null;
  let replyKind: string | null = null;
  if (rule) {
    if (rule.action === 'reply') {
      intent = 'course_info';
      reply = rule.reply_body;
      replyKind = 'rule';
    } else if (rule.action === 'course' && rule.course_id) {
      intent = 'course_info';
      // Only the rule's course: the text itself is not used to pick another one.
      const answer = buildCourseAnswer({ text: '', courses: data.courses, sessions, templates: data.templates, timeZone: data.timeZone, courseHintIds: [rule.course_id] });
      reply = answer.body;
      replyKind = answer.kind;
    } else if (rule.action === 'seva') {
      intent = 'seva_request';
    } else {
      intent = 'handover';
    }
  } else if (intent === 'course_info') {
    const answer = buildCourseAnswer({ text, courses: data.courses, sessions, templates: data.templates, timeZone: data.timeZone, courseHintIds });
    reply = answer.body;
    replyKind = answer.kind;
    // Nothing in Setu answers it: an AI draft can do better than "a volunteer will reply".
    if (answer.kind === 'fallback') aiQuestion = true;
  }

  // 4. AI draft (always waits for a person).
  if (aiQuestion && aiDraftEnabled()) {
    const drafted = await draftReply(text, factsFor(data, sessions));
    if (drafted) {
      intent = 'course_info';
      reply = drafted;
      replyKind = 'ai_draft';
    }
  }
  if (aiQuestion && intent === 'none') intent = 'handover'; // a real question nobody answered: flag it for a person

  const { data: result, error } = await db.rpc('dv_record_intent', {
    p_message_id: msg.id,
    p_intent: intent,
    p_source: source,
    p_reply: reply,
    p_reply_kind: replyKind,
    // Only a hint ("share 5 numbers"): the database limits always decide the real number.
    p_requested_count: intent === 'seva_request' ? extractRequestedCount(text) : null,
    p_rule_id: rule?.id ?? null,
  });
  if (error) log.warn({ err: error.message, id: msg.id }, 'could not record intent');
  // e.g. {intent: course_info, status: needs_review, send: pending_approval} = suggestion waiting in the Inbox
  else log.info({ id: msg.id, intent, source, rule: rule?.name, replyKind, result }, 'message analysed');
}

/** Called when courses/templates/rules change in the CRM, so answers are never stale. */
export function invalidateAnswerData() {
  cache = null;
}
