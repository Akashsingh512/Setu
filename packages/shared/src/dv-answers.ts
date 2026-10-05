// Digital Volunteer: understand a WhatsApp message and build a course answer.
//
// The golden rule: facts come only from the CRM (courses, upcoming sessions).
// Intent detection (keywords here, optionally AI in the gateway) decides *what*
// was asked; the reply is always a template filled with database values, and a
// line whose value is missing is dropped (renderTemplate). Nothing is invented.
import { renderTemplate } from './messages';

export type DvIntent = 'course_info' | 'seva_request' | 'none';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Keep combining marks (\p{M}): Devanagari vowel signs are marks, not letters.
    .replace(/[^\p{L}\p{M}\p{N}?]+/gu, ' ')
    .trim();

// English, Hinglish (Hindi in Latin script) and Devanagari keywords.
const COURSE_WORDS = [
  'course', 'courses', 'program', 'programme', 'programs', 'workshop', 'session', 'sessions', 'class', 'classes',
  'batch', 'shivir', 'satsang', 'kriya', 'happiness', 'sahaj', 'yoga', 'meditation', 'dhyan',
  'कोर्स', 'शिविर', 'कार्यक्रम', 'सत्संग', 'क्रिया', 'योग', 'ध्यान',
];
const QUESTION_WORDS = [
  'when', 'where', 'what', 'which', 'how', 'timing', 'timings', 'time', 'date', 'dates', 'next', 'upcoming',
  'register', 'registration', 'link', 'join', 'fee', 'fees', 'venue', 'online', 'offline', 'duration', 'details',
  'info', 'information', 'conduct', 'conducting', 'teacher', 'available', 'schedule', 'starting', 'start',
  'kab', 'kahan', 'kaha', 'kya', 'kaise', 'kitne', 'kitna', 'batao', 'bataye', 'bataiye', 'bata', 'jankari',
  'कब', 'कहाँ', 'कहां', 'क्या', 'कैसे', 'बताइए', 'बताओ', 'जानकारी', 'लिंक',
];
const SEVA_PATTERNS = [
  /\bseva\b/, /\bsewa\b/, /सेवा/, /\bvolunteer(ing)?\b/,
  /\b(share|send|give|de do|dedo|bhejo|bhej do)\b.*\b(numbers?|contacts?|leads?)\b/,
  /\b(numbers?|contacts?|leads?)\b.*\b(share|send|give|chahiye|bhejo|do)\b/,
  /\bcall(ing)? seva\b/,
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ek: 1, do: 2, teen: 3, char: 4, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
};
export const MAX_SEVA_REQUEST = 50;

/**
 * How many leads a seva request asks for ("share 5 numbers", "mujhe das numbers do"),
 * or null when no count is stated. A hint only: the database limits always apply.
 */
export function extractRequestedCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = norm(text);
  const unit = '(?:numbers?|nos?|contacts?|leads?|names?|calls?|people)';
  const m = new RegExp(String.raw`\b(\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})\s+${unit}\b`).exec(t);
  if (!m) return null;
  const n = /^\d/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!]!;
  return n >= 1 ? Math.min(n, MAX_SEVA_REQUEST) : null;
}

export interface ApprovalReply {
  action: 'approve' | 'decline';
  ref: number;
  /** Approve only this many (approve only). */
  count: number | null;
  /** Shown to the volunteer (decline only). */
  reason: string | null;
}

const APPROVE_WORDS = ['yes', 'y', 'approve', 'approved', 'ok', 'okay', 'haan', 'ha', 'han', 'ji'];
const DECLINE_WORDS = ['no', 'n', 'decline', 'reject', 'nahi', 'nahin', 'na'];

/**
 * An approver's WhatsApp reply to a seva request: "YES 12", "yes #12 3",
 * "NO 12 please finish your current leads first", "haan 12". Returns null for
 * anything else, so ordinary messages are never mistaken for decisions.
 * Whether the sender may decide is checked in the database, not here.
 */
export function parseApprovalReply(text: string | null | undefined): ApprovalReply | null {
  if (!text) return null;
  const m = /^\s*([a-z]+)\s*#?\s*(\d{1,7})(?!\d)\s*([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  const ref = Number(m[2]);
  const rest = m[3]!.trim();
  if (APPROVE_WORDS.includes(word)) {
    if (rest === '') return { action: 'approve', ref, count: null, reason: null };
    const c = /^(\d{1,2})(?:\s*(?:leads?|numbers?))?$/i.exec(rest);
    if (!c) return null; // "yes 12 maybe later" is not a clear decision
    const count = Number(c[1]);
    return count >= 1 && count <= MAX_SEVA_REQUEST ? { action: 'approve', ref, count, reason: null } : null;
  }
  if (DECLINE_WORDS.includes(word)) return { action: 'decline', ref, count: null, reason: rest ? rest.slice(0, 200) : null };
  return null;
}

export interface AllotCommand {
  /** null = the default number per request. */
  count: number | null;
  /** A name or a phone number, as written. */
  target: string;
}

/**
 * "Allot 5 leads to Srikesh", "assign 3 leads to +91 98450 12345", "give leads to Priya".
 * Whether the sender may allot is decided in the database (dv_allot_by_whatsapp).
 */
export function parseAllotCommand(text: string | null | undefined): AllotCommand | null {
  if (!text) return null;
  const m = /^\s*(?:please\s+)?(?:allot|allocate|assign|give|send|share)\s+(?:(\d{1,2})\s+)?(?:new\s+)?(?:leads?|numbers?|contacts?)\s+(?:to|for)\s+(.{2,80}?)[\s.!]*$/i.exec(text.trim());
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : null;
  if (count !== null && (count < 1 || count > MAX_SEVA_REQUEST)) return null;
  const target = m[2]!.trim();
  return target ? { count, target } : null;
}

export interface IntentResult {
  intent: DvIntent;
  /** Matched keywords, for the audit trail and tuning. */
  signals: string[];
}

/** Keyword intent detection. Conservative: when unsure it returns 'none' (a person decides). */
export function detectIntent(text: string | null | undefined): IntentResult {
  if (!text) return { intent: 'none', signals: [] };
  const t = norm(text);
  const words = new Set(t.replace(/\?/g, ' ').split(/\s+/));

  const seva = SEVA_PATTERNS.filter((p) => p.test(t)).map((p) => p.source);
  if (seva.length) return { intent: 'seva_request', signals: seva };

  const course = COURSE_WORDS.map(norm).filter((w) => words.has(w) || (w.length > 3 && t.includes(w)));
  const question = QUESTION_WORDS.map(norm).filter((w) => words.has(w));
  const asks = t.includes('?') || question.length > 0;
  if (course.length && asks) return { intent: 'course_info', signals: [...course, ...question] };
  // "when is the next one?" / "registration link please" without naming a course
  if (question.some((w) => ['register', 'registration', 'upcoming', 'next', 'schedule'].includes(w)) && t.includes('?')) {
    return { intent: 'course_info', signals: question };
  }
  return { intent: 'none', signals: [] };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------
export const DV_TEMPLATE_KINDS = ['course_details', 'course_list', 'no_upcoming', 'fallback'] as const;
export type DvTemplateKind = (typeof DV_TEMPLATE_KINDS)[number];

export const DV_PLACEHOLDERS = [
  'course_name', 'course_description', 'session_dates', 'session_time', 'duration', 'venue', 'mode', 'teacher',
  'registration_link', 'course_list',
] as const;
export type DvPlaceholder = (typeof DV_PLACEHOLDERS)[number];

export const DV_TEMPLATE_INFO: Record<DvTemplateKind, { label: string; when: string }> = {
  course_details: { label: 'One program', when: 'The question is about one course and it has an upcoming session.' },
  course_list: { label: 'List of programs', when: 'No course was named and several sessions are coming up.' },
  no_upcoming: { label: 'No upcoming session', when: 'The course exists but nothing is scheduled yet.' },
  fallback: { label: 'Hand over to a person', when: 'The bot cannot answer from verified data.' },
};

export const DEFAULT_DV_TEMPLATES: Record<DvTemplateKind, string> = {
  course_details: `Namaste 🙏

Thank you for your interest in our upcoming program.

Course: {{course_name}}
Date: {{session_dates}}
Time: {{session_time}}
Duration: {{duration}}
Venue: {{venue}}
Mode: {{mode}}
Conducted by: {{teacher}}

Registration: {{registration_link}}

For further information, please let us know.

Jai Gurudev 🙏`,
  course_list: `Namaste 🙏

Here are our upcoming programs:

{{course_list}}

Reply with the course name for full details.

Jai Gurudev 🙏`,
  no_upcoming: `Namaste 🙏

Thank you for your interest in {{course_name}}.

{{course_description}}

There is no session scheduled right now. A volunteer will let you know when the next one is announced.

Registration: {{registration_link}}

Jai Gurudev 🙏`,
  fallback: `Namaste 🙏

Thank you for your message. A volunteer will get back to you shortly.

Jai Gurudev 🙏`,
};

export interface AnswerCourse {
  id: string;
  name: string;
  short_description?: string | null;
  registration_url?: string | null;
  is_active: boolean;
}
export interface AnswerSession {
  id: string;
  course_id: string;
  title?: string | null;
  starts_at: string;
  ends_at: string;
  timezone?: string | null;
  schedule_note?: string | null;
  mode?: string | null;
  venue?: string | null;
  city?: string | null;
  meeting_url?: string | null;
  registration_url?: string | null;
  instructor_name?: string | null;
  status: string;
}

const MODE_LABEL: Record<string, string> = { in_person: 'In person', online: 'Online', hybrid: 'In person and online' };
const STOP = new Set(['the', 'and', 'of', 'program', 'programme', 'course', 'workshop', 'art', 'living', 'for', 'with']);

/** Courses named in the text: full name, or a distinctive word of it (e.g. "happiness", "sahaj"). */
export function matchCourses(text: string, courses: AnswerCourse[]): AnswerCourse[] {
  const t = ` ${norm(text).replace(/\?/g, ' ')} `;
  return courses.filter((c) => {
    const n = norm(c.name);
    if (t.includes(` ${n} `)) return true;
    return n.split(' ').some((w) => w.length >= 4 && !STOP.has(w) && t.includes(` ${w} `));
  });
}

/** "2 hours" for a single sitting; "3 days" for a multi-day program (calendar days in its timezone). */
function durationText(s: AnswerSession, timeZone: string): string {
  const start = new Date(s.starts_at);
  const end = new Date(s.ends_at);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = Math.round((Date.parse(day.format(end)) - Date.parse(day.format(start))) / 86_400_000) + 1;
  if (days <= 1) {
    const h = Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 2) / 2;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${days} days`;
}

function sessionVars(s: AnswerSession, course: AnswerCourse | undefined, tz: string): Record<DvPlaceholder, string | null> {
  const timeZone = s.timezone || tz;
  const parts = new Intl.DateTimeFormat('en-IN', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  // Assembled from parts: "Fri, 9 Oct 2026" (ICU versions disagree on commas).
  const date = {
    format: (d: Date) => {
      const p = Object.fromEntries(parts.formatToParts(d).map((x) => [x.type, x.value]));
      return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
    },
  };
  const time = new Intl.DateTimeFormat('en-IN', { timeZone, hour: 'numeric', minute: '2-digit' });
  const start = new Date(s.starts_at);
  const end = new Date(s.ends_at);
  const sameDay = date.format(start) === date.format(end);
  return {
    course_name: s.title || course?.name || null,
    course_description: course?.short_description ?? null,
    session_dates: sameDay ? date.format(start) : `${date.format(start)} – ${date.format(end)}`,
    session_time: s.schedule_note || `${time.format(start)} – ${time.format(end)}`,
    duration: durationText(s, timeZone),
    venue: s.mode === 'online' ? null : [s.venue, s.city].filter(Boolean).join(', ') || null,
    mode: s.mode ? (MODE_LABEL[s.mode] ?? null) : null,
    teacher: s.instructor_name || null,
    registration_link: s.registration_url || course?.registration_url || null,
    course_list: null,
  };
}

export interface CourseAnswer {
  kind: DvTemplateKind;
  body: string;
  courseIds: string[];
  /** The one program a "course_details" answer is about (its poster can go with it). */
  sessionId?: string;
}

/**
 * Builds the reply for a course question from verified data. Returns the
 * fallback (hand-over) answer when nothing can be answered from the CRM.
 */
export function buildCourseAnswer(opts: {
  text: string;
  courses: AnswerCourse[];
  sessions: AnswerSession[];
  templates?: Partial<Record<DvTemplateKind, string | null>>;
  now?: Date;
  timeZone?: string;
  /** Courses chosen by AI classification, used when the text names none. */
  courseHintIds?: string[];
}): CourseAnswer {
  const tz = opts.timeZone ?? 'Asia/Kolkata';
  const now = opts.now ?? new Date();
  const tpl = (k: DvTemplateKind) => opts.templates?.[k] || DEFAULT_DV_TEMPLATES[k];
  const active = opts.courses.filter((c) => c.is_active);
  const byId = new Map(active.map((c) => [c.id, c]));
  // Only scheduled, not-yet-ended sessions of active courses ever count as upcoming.
  const upcoming = opts.sessions
    .filter((s) => s.status === 'scheduled' && new Date(s.ends_at) > now && byId.has(s.course_id))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  let named = matchCourses(opts.text, active);
  if (!named.length && opts.courseHintIds?.length) named = active.filter((c) => opts.courseHintIds!.includes(c.id));
  const fallback = (): CourseAnswer => ({ kind: 'fallback', body: renderTemplate(tpl('fallback'), {}), courseIds: [] });

  const details = (s: AnswerSession): CourseAnswer => ({
    kind: 'course_details',
    body: renderTemplate(tpl('course_details'), sessionVars(s, byId.get(s.course_id), tz)),
    courseIds: [s.course_id],
    sessionId: s.id,
  });
  const list = (sessions: AnswerSession[]): CourseAnswer => {
    const lines = sessions.slice(0, 6).map((s) => {
      const v = sessionVars(s, byId.get(s.course_id), tz);
      return `• ${[v.course_name, v.session_dates, v.mode === 'Online' ? 'Online' : v.venue].filter(Boolean).join(' – ')}`;
    });
    return { kind: 'course_list', body: renderTemplate(tpl('course_list'), { course_list: lines.join('\n') }), courseIds: [...new Set(sessions.map((s) => s.course_id))] };
  };

  if (named.length === 1) {
    const course = named[0]!;
    const next = upcoming.find((s) => s.course_id === course.id);
    if (next) return details(next);
    return {
      kind: 'no_upcoming',
      body: renderTemplate(tpl('no_upcoming'), {
        course_name: course.name,
        course_description: course.short_description,
        registration_link: course.registration_url,
      }),
      courseIds: [course.id],
    };
  }
  const pool = named.length > 1 ? upcoming.filter((s) => named.some((c) => c.id === s.course_id)) : upcoming;
  if (pool.length === 1) return details(pool[0]!);
  if (pool.length > 1) return list(pool);
  return fallback();
}

/** Placeholders in a Digital Volunteer template that aren't supported. */
export function unknownDvPlaceholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
    if (!(DV_PLACEHOLDERS as readonly string[]).includes(m[1] ?? '')) out.add(m[1] ?? '');
  }
  return [...out];
}


// ---------------------------------------------------------------------------
// Reply rules (mirrors public.dv_rules) and approving drafts on WhatsApp
// ---------------------------------------------------------------------------
export const DV_RULE_ACTIONS = ['reply', 'course', 'seva', 'handover'] as const;
export type DvRuleAction = (typeof DV_RULE_ACTIONS)[number];
export const DV_RULE_ACTION_INFO: Record<DvRuleAction, { label: string; description: string }> = {
  reply: { label: 'Send my reply', description: 'Replies with the text you write here' },
  course: { label: 'Send course details', description: "Replies with the chosen course's next session (or its details)" },
  seva: { label: 'Seva request', description: 'Treats the message as a request for leads to call' },
  handover: { label: 'Hand to a person', description: 'No reply: flags the message in the inbox for someone to answer' },
};

export interface DvRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  keywords: string[];
  action: DvRuleAction;
  reply_body: string | null;
  course_id: string | null;
  in_groups: boolean;
  in_direct: boolean;
}

/** Latin-script words match whole words; other scripts (e.g. Devanagari) match anywhere. */
function containsKeyword(text: string, keyword: string): boolean {
  const k = norm(keyword).replace(/\?/g, ' ').trim();
  if (!k) return false;
  if (/[^\x00-\x7f]/.test(k)) return text.includes(k);
  return ` ${text} `.includes(` ${k} `);
}

/**
 * The rule a message triggers: the enabled rule with the lowest priority number whose
 * trigger word or phrase appears in it, for this kind of chat. Null when none does.
 */
export function matchRule<R extends Pick<DvRule, 'enabled' | 'priority' | 'keywords' | 'in_groups' | 'in_direct'>>(
  text: string | null | undefined,
  rules: R[],
  where: 'group' | 'direct',
): { rule: R; keyword: string } | null {
  if (!text) return null;
  const t = norm(text).replace(/\?/g, ' ').replace(/\s+/g, ' ').trim();
  const usable = rules
    .filter((r) => r.enabled && (where === 'group' ? r.in_groups : r.in_direct))
    .sort((a, b) => a.priority - b.priority);
  for (const rule of usable) {
    const keyword = rule.keywords.find((k) => containsKeyword(t, k));
    if (keyword) return { rule, keyword };
  }
  return null;
}

export interface DraftDecision {
  action: 'send' | 'edit' | 'skip';
  ref: number;
  /** The approver's own text (edit only). */
  text: string | null;
}

/**
 * An approver's WhatsApp answer to a suggested reply: "SEND 12", "EDIT 12 new text",
 * "SKIP 12". Different words from seva approvals (YES/NO), so the two never mix.
 * Whether the sender may decide is checked in the database.
 */
export function parseDraftReply(text: string | null | undefined): DraftDecision | null {
  if (!text) return null;
  const m = /^\s*(send|edit|skip)\s*#?\s*(\d{1,9})(?!\d)\s*([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const action = m[1]!.toLowerCase() as DraftDecision['action'];
  const ref = Number(m[2]);
  const rest = m[3]!.trim();
  if (action === 'send' && rest !== '') return null; // "send 12 later?" is not a clear decision
  return { action, ref, text: action === 'edit' ? rest.slice(0, 4000) || null : null };
}
