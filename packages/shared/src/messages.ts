// WhatsApp message composition. The app only *prefills* a message via the
// official click-to-chat link (https://wa.me/<number>?text=...); the volunteer
// reviews and sends it manually. No automated or bulk sending.

export const TEMPLATE_PLACEHOLDERS = [
  'lead_name',
  'course_name',
  'course_description',
  'session_schedule',
  'registration_link',
  'volunteer_name',
] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];
export type TemplateVars = Partial<Record<TemplatePlaceholder, string | null | undefined>>;

export const DEFAULT_WHATSAPP_TEMPLATE = `Namaste {{lead_name}} 🙏

Thank you for connecting with us.

We would be happy to share details about {{course_name}} with you.

{{course_description}}

Upcoming program: {{session_schedule}}

Registration link: {{registration_link}}

Please let us know if you would like to know more.

Jai Gurudev 🙏`;

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Placeholders used in a template that are not supported (for template editor validation). */
export function unknownPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) found.add(name);
  }
  return [...found];
}

/**
 * Fill placeholders. A line that references a placeholder with no value is
 * dropped entirely (e.g. "Upcoming program: …" when there is no session), and
 * the resulting runs of blank lines are collapsed.
 */
export function renderTemplate(template: string, vars: TemplateVars | Partial<Record<string, string | null | undefined>>): string {
  const lines = template.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    let missing = false;
    const rendered = line.replace(PLACEHOLDER, (_, name: string) => {
      const value = (vars as Record<string, string | null | undefined>)[name];
      if (value === undefined || value === null || String(value).trim() === '') {
        missing = true;
        return '';
      }
      return String(value).trim();
    });
    if (!missing) out.push(rendered);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Official click-to-chat link. Expects an E.164 number. */
export function whatsAppUrl(e164: string, text?: string): string {
  const digits = e164.replace(/\D/g, '');
  const base = `https://wa.me/${digits}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/**
 * Which course a message should be about: an explicit choice in the dialog,
 * else the lead's course of interest, else the volunteer's default course.
 */
export function chooseMessageCourseId(opts: {
  overrideCourseId?: string | null;
  leadCourseId?: string | null;
  volunteerDefaultCourseId?: string | null;
}): string | null {
  return opts.overrideCourseId || opts.leadCourseId || opts.volunteerDefaultCourseId || null;
}

export interface MessageCourse {
  name: string;
  short_description?: string | null;
  registration_url?: string | null;
}

export interface MessageSession {
  starts_at: string;
  ends_at: string;
  timezone?: string | null;
  schedule_note?: string | null;
  registration_url?: string | null;
  venue?: string | null;
  mode?: string | null;
}

/** e.g. "Fri, 9 Oct 2026, 6:00 pm – Sun, 11 Oct 2026, 8:00 pm (Daily 6–8 pm)". */
export function formatSessionSchedule(session: MessageSession, locale = 'en-IN', fallbackTimeZone = 'Asia/Kolkata'): string {
  const timeZone = session.timezone || fallbackTimeZone;
  const start = new Date(session.starts_at);
  const end = new Date(session.ends_at);
  const dateTime = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const timeOnly = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' });
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const sameDay = dayKey.format(start) === dayKey.format(end);

  const range = sameDay
    ? `${dateTime.format(start)} – ${timeOnly.format(end)}`
    : `${dateTime.format(start)} – ${dateTime.format(end)}`;
  return session.schedule_note ? `${range} (${session.schedule_note})` : range;
}

export function buildCourseMessage(opts: {
  template?: string | null;
  leadName: string;
  volunteerName?: string | null;
  course?: MessageCourse | null;
  session?: MessageSession | null;
  locale?: string;
  timeZone?: string;
}): string {
  const { course, session } = opts;
  return renderTemplate(opts.template || DEFAULT_WHATSAPP_TEMPLATE, {
    lead_name: opts.leadName,
    volunteer_name: opts.volunteerName,
    course_name: course?.name,
    course_description: course?.short_description,
    session_schedule: session ? formatSessionSchedule(session, opts.locale, opts.timeZone) : null,
    registration_link: session?.registration_url || course?.registration_url,
  });
}
