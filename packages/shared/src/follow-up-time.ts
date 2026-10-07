// "follow up tomorrow 5pm", "call back Saturday morning", "follow up in 2 hours":
// the time a volunteer asks for, read from a WhatsApp message, in the org's time zone.

const DAY_WORDS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const PARTS_OF_DAY: Record<string, [number, number]> = { morning: [10, 0], afternoon: [15, 0], evening: [18, 0], night: [20, 0] };

/** Words that make a message a follow-up request. */
const TRIGGER = /\b(follow[\s-]?up|followup|call\s*back|callback|call\s+(?:again|him|her|them)|remind(?:\s+me)?)\b/i;

/** Minutes a wall-clock time in `timeZone` is ahead of UTC at that moment. */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(utcMs))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
  return Math.round((asUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

/** A wall-clock date and time in `timeZone`, as an instant. */
function zoned(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  const guess = Date.UTC(y, m, d, h, min);
  return new Date(guess - offsetMinutes(guess, timeZone) * 60_000);
}

/** Today's date in `timeZone`. */
function localDate(now: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  return { y: +p.year!, m: +p.month! - 1, d: +p.day!, dow: DAY_WORDS[p.weekday!.toLowerCase().slice(0, 3)]! };
}

/**
 * The follow-up time asked for in `text`, or null when the message does not ask for
 * one. Needs a follow-up word ("follow up", "call back", "remind") and a time or day.
 * A day without a time means 10 am; a time without a day means today, or tomorrow
 * when that time has passed.
 */
export function parseFollowUpTime(text: string | null | undefined, now: Date = new Date(), timeZone = 'Asia/Kolkata'): Date | null {
  if (!text || !TRIGGER.test(text)) return null;
  const t = ` ${text.toLowerCase().replace(/[,.;]/g, ' ')} `;

  // "in 2 hours" / "in 30 minutes" / "in 3 days"
  const rel = /\bin\s+(\d{1,3})\s*(min(?:ute)?s?|hrs?|hours?|days?)\b/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.startsWith('m') ? 60_000 : rel[2]!.startsWith('d') ? 86_400_000 : 3_600_000;
    if (n > 0) return new Date(now.getTime() + n * unit);
  }

  const today = localDate(now, timeZone);
  let day: { y: number; m: number; d: number } | null = null;

  if (/\bday after tomorrow\b/.test(t)) day = { ...today, d: today.d + 2 };
  else if (/\b(tomorrow|tmrw|tmr|tomorow)\b/.test(t)) day = { ...today, d: today.d + 1 };
  else if (/\btoday\b|\btonight\b/.test(t)) day = { ...today };
  else {
    const wd = /\b(?:next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(t);
    // "10 oct", "oct 10", "10th october"
    const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t);
    const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
    // "10/10" or "10-10" (day/month)
    const num = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(t);
    if (dm || md) {
      const d = Number(dm ? dm[1] : md![2]);
      const m = MONTHS[(dm ? dm[2] : md![1])!]!;
      const y = m < today.m || (m === today.m && d < today.d) ? today.y + 1 : today.y;
      day = { y, m, d };
    } else if (num && Number(num[2]) >= 1 && Number(num[2]) <= 12 && Number(num[1]) >= 1 && Number(num[1]) <= 31) {
      const d = Number(num[1]);
      const m = Number(num[2]) - 1;
      const y = num[3] ? (num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3])) : m < today.m || (m === today.m && d < today.d) ? today.y + 1 : today.y;
      day = { y, m, d };
    } else if (wd) {
      let add = (DAY_WORDS[wd[1]!]! - today.dow + 7) % 7;
      if (add === 0) add = 7; // "Saturday" on a Saturday = next week
      day = { ...today, d: today.d + add };
    }
  }

  // Time: "5pm", "5:30 pm", "17:00", "at 5", "morning"
  let hm: [number, number] | null = null;
  const ampm = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(t);
  const h24 = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(t);
  const at = /\bat\s+(\d{1,2})\b(?!\s*[/-])/.exec(t);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === 'pm') h += 12;
    hm = [h, Number(ampm[2] ?? 0)];
  } else if (h24) hm = [Number(h24[1]), Number(h24[2])];
  else if (at) {
    const h = Number(at[1]);
    hm = [h >= 1 && h <= 7 ? h + 12 : h, 0]; // "at 5" in seva work means 5 pm
  } else {
    const part = Object.keys(PARTS_OF_DAY).find((p) => t.includes(` ${p} `) || (p === 'night' && /\btonight\b/.test(t)));
    if (part) hm = PARTS_OF_DAY[part]!;
  }

  if (!day && !hm) return null;
  if (!day) {
    const todayAt = zoned(today.y, today.m, today.d, hm![0], hm![1], timeZone);
    return todayAt.getTime() > now.getTime() ? todayAt : zoned(today.y, today.m, today.d + 1, hm![0], hm![1], timeZone);
  }
  const [h, min] = hm ?? [10, 0];
  return zoned(day.y, day.m, day.d, h, min, timeZone);
}
