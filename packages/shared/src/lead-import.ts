// Bulk lead import: parse a spreadsheet, map its columns, validate each row.
// Pure functions shared by web and mobile. The import_leads RPC re-validates
// everything (E.164 domain, enum casts, duplicate check) on the server.
import { LEAD_SOURCE_LABELS, LEAD_SOURCES, type LeadSource } from './constants';
import { normalizePhone } from './phone';

export const MAX_IMPORT_ROWS = 5000;
/** Rows per server request (keeps each request well under the body-size limit). */
export const IMPORT_CHUNK_SIZE = 500;

export const IMPORT_FIELDS = [
  { key: 'full_name', label: 'Name', required: true, aliases: ['name', 'full name', 'lead name', 'student name', 'participant'] },
  { key: 'phone', label: 'Phone', required: true, aliases: ['mobile', 'mobile number', 'phone number', 'contact', 'contact number', 'number', 'cell'] },
  { key: 'whatsapp_phone', label: 'WhatsApp number', required: false, aliases: ['whatsapp', 'whatsapp number', 'wa number'] },
  { key: 'email', label: 'Email', required: false, aliases: ['email address', 'e-mail', 'mail'] },
  { key: 'source', label: 'Source', required: false, aliases: ['lead source'] },
  { key: 'source_detail', label: 'Source detail', required: false, aliases: ['event name', 'place', 'location', 'venue'] },
  { key: 'course', label: 'Course interested', required: false, aliases: ['course', 'program', 'programme', 'course name', 'interested in'] },
  { key: 'met_by_name', label: 'Met by', required: false, aliases: ['met by name', 'volunteer', 'referred by', 'collected by'] },
  { key: 'met_on', label: 'Met on (date)', required: false, aliases: ['date', 'met date', 'meeting date'] },
  { key: 'meeting_notes', label: 'Meeting notes', required: false, aliases: ['remarks', 'comments', 'comment'] },
  { key: 'notes', label: 'Notes', required: false, aliases: ['note', 'other notes'] },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];
/** Field key -> index of the spreadsheet column it reads from (absent = not imported). */
export type ColumnMapping = Partial<Record<ImportFieldKey, number>>;

/** The JSON shape import_leads expects for each row. */
export interface ImportLeadRow {
  full_name: string;
  phone: string;
  whatsapp_phone: string | null;
  email: string | null;
  source: LeadSource;
  source_detail: string | null;
  course_id: string | null;
  met_by_name: string | null;
  met_on: string | null;
  meeting_notes: string | null;
  notes: string | null;
}

export interface CheckedRow {
  /** 1-based row number as the user sees it in the spreadsheet (header = row 1). */
  line: number;
  raw: Record<ImportFieldKey, string>;
  lead: ImportLeadRow | null;
  errors: string[];
  warnings: string[];
  /** Line of an earlier row in the same file with the same phone. */
  duplicateOfLine: number | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF, embedded newlines, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Excel in some locales saves with ";" - pick whichever separator the header uses more.
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Matches spreadsheet headers to CRM fields by name and common aliases. */
export function guessMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(norm);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  // Exact key/label matches first, so "WhatsApp number" isn't taken by "Phone"'s aliases.
  for (const pass of ['exact', 'alias'] as const) {
    for (const f of IMPORT_FIELDS) {
      if (mapping[f.key] !== undefined) continue;
      const names = pass === 'exact' ? [norm(f.key), norm(f.label)] : f.aliases.map(norm);
      const idx = normalized.findIndex((h, i) => !used.has(i) && names.includes(h));
      if (idx >= 0) {
        mapping[f.key] = idx;
        used.add(idx);
      }
    }
  }
  return mapping;
}

function toSource(value: string): { source: LeadSource; unknown: boolean } {
  const v = norm(value);
  if (!v) return { source: 'other', unknown: false };
  const hit = LEAD_SOURCES.find((s) => norm(s) === v || norm(LEAD_SOURCE_LABELS[s]) === v);
  return hit ? { source: hit, unknown: false } : { source: 'other', unknown: true };
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (day first, as used in India). */
export function parseImportDate(value: string): string | null {
  const v = value.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v);
  if (match) [y, m, d] = [+match[1]!, +match[2]!, +match[3]!];
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v))) {
    [d, m, y] = [+match[1]!, +match[2]!, +match[3]!];
    if (y < 100) y += 2000;
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkImportRows(
  rows: string[][],
  mapping: ColumnMapping,
  opts: { defaultCountry: string; courses: { id: string; name: string }[] },
): CheckedRow[] {
  const courseByName = new Map(opts.courses.map((c) => [norm(c.name), c.id]));
  const seenPhones = new Map<string, number>();

  return rows.map((cells, i) => {
    const line = i + 2;
    const raw = Object.fromEntries(
      IMPORT_FIELDS.map((f) => {
        const idx = mapping[f.key];
        return [f.key, idx === undefined ? '' : (cells[idx] ?? '').trim()];
      }),
    ) as Record<ImportFieldKey, string>;
    const errors: string[] = [];
    const warnings: string[] = [];
    const text = (v: string, max: number) => (v ? v.slice(0, max) : null);

    if (!raw.full_name) errors.push('Name is missing');
    let phone = '';
    if (!raw.phone) errors.push('Phone is missing');
    else {
      const p = normalizePhone(raw.phone, opts.defaultCountry);
      if (p.ok) phone = p.e164;
      else errors.push(`Phone "${raw.phone}" is not a valid number`);
    }

    let whatsapp: string | null = null;
    if (raw.whatsapp_phone) {
      const p = normalizePhone(raw.whatsapp_phone, opts.defaultCountry);
      if (p.ok) whatsapp = p.e164 === phone ? null : p.e164;
      else warnings.push('WhatsApp number is not valid, left blank');
    }

    let email: string | null = null;
    if (raw.email) {
      if (EMAIL.test(raw.email)) email = raw.email.toLowerCase();
      else warnings.push('Email is not valid, left blank');
    }

    const { source, unknown } = toSource(raw.source);
    let sourceDetail = text(raw.source_detail, 300);
    if (unknown) {
      warnings.push(`Source "${raw.source}" not recognised, saved as Other`);
      sourceDetail = sourceDetail ?? raw.source.slice(0, 300);
    }

    let courseId: string | null = null;
    if (raw.course) {
      courseId = courseByName.get(norm(raw.course)) ?? null;
      if (!courseId) warnings.push(`Course "${raw.course}" not found, left blank`);
    }

    let metOn: string | null = null;
    if (raw.met_on) {
      metOn = parseImportDate(raw.met_on);
      if (!metOn) warnings.push(`Date "${raw.met_on}" not understood, left blank`);
    }

    let duplicateOfLine: number | null = null;
    if (phone && !errors.length) {
      duplicateOfLine = seenPhones.get(phone) ?? null;
      if (duplicateOfLine === null) seenPhones.set(phone, line);
    }

    return {
      line,
      raw,
      errors,
      warnings,
      duplicateOfLine,
      lead: errors.length
        ? null
        : {
            full_name: raw.full_name.slice(0, 200),
            phone,
            whatsapp_phone: whatsapp,
            email,
            source,
            source_detail: sourceDetail,
            course_id: courseId,
            met_by_name: text(raw.met_by_name, 200),
            met_on: metOn,
            meeting_notes: text(raw.meeting_notes, 4000),
            notes: text(raw.notes, 4000),
          },
    };
  });
}

/** Header + one example row, for the downloadable template. */
export function importTemplateCsv(): string {
  const header = IMPORT_FIELDS.map((f) => f.label);
  const example = ['Vinod Kumar', '98450 12345', '', 'vinod@example.com', 'Event', 'Sunday satsang, Jayanagar', 'Happiness Program', 'Anita', '28/09/2026', 'Interested in weekend batch', ''];
  return [header, example].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
