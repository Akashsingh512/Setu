const DEFAULT_TZ = 'Asia/Kolkata';
const LOCALE = 'en-IN';

export function formatDateTime(iso: string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!iso) return '—';
  // Plain dates (YYYY-MM-DD) have no timezone; format them as-is.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? 'UTC' : timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** "in 3 h", "2 d ago" — coarse, for deadlines and activity. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  let text: string;
  if (mins < 1) text = 'now';
  else if (mins < 60) text = `${mins} min`;
  else if (mins < 60 * 48) text = `${Math.round(mins / 60)} h`;
  else text = `${Math.round(mins / 1440)} d`;
  if (text === 'now') return text;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** Value for <input type="datetime-local"> in the given timezone. */
export function toLocalInputValue(date: Date, timeZone = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Convert a datetime-local value interpreted in `timeZone` into an ISO string (UTC).
 * Works for any IANA zone without a date library.
 */
export function localInputToIso(value: string, timeZone = DEFAULT_TZ): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  // Offset of the zone at that instant, found by formatting the UTC guess in the zone.
  const guess = new Date(asUtc);
  const local = toLocalInputValue(guess, timeZone);
  const lm = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)!;
  const localAsUtc = Date.UTC(+lm[1]!, +lm[2]! - 1, +lm[3]!, +lm[4]!, +lm[5]!);
  const offset = localAsUtc - asUtc;
  return new Date(asUtc - offset).toISOString();
}
