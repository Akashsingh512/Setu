import { describe, expect, it } from 'vitest';
import { buildCourseAnswer, detectIntent, extractRequestedCount, matchCourses, parseApprovalReply, unknownDvPlaceholders, type AnswerCourse, type AnswerSession } from '../src/dv-answers';

describe('detectIntent', () => {
  it.each([
    'When is the next Happiness Program?',
    'Can you share the registration link for the course',
    'Sahaj samadhi kab hai?',
    'online course hai kya',
    'कोर्स कब है?',
    'Where is the yoga workshop conducted?',
  ])('course question: %s', (text) => {
    expect(detectIntent(text).intent).toBe('course_info');
  });

  it.each([
    'Jai Gurudev 🙏 I would like to do seva. Please share some numbers I can contact.',
    'mujhe seva karni hai',
    'please send me 5 numbers to call',
    'सेवा करना चाहता हूँ',
  ])('seva request: %s', (text) => {
    expect(detectIntent(text).intent).toBe('seva_request');
  });

  it.each(['Jai Gurudev 🙏', 'Good morning all', 'The course was wonderful, thank you', 'ok', ''])('no action: %s', (text) => {
    expect(detectIntent(text).intent).toBe('none');
  });
});

const courses: AnswerCourse[] = [
  { id: 'hp', name: 'Happiness Program', short_description: 'Sudarshan Kriya and more', registration_url: 'https://aol.example/hp', is_active: true },
  { id: 'ss', name: 'Sahaj Samadhi Meditation', short_description: null, registration_url: null, is_active: true },
  { id: 'old', name: 'Old Retired Course', registration_url: null, is_active: false },
];
const now = new Date('2026-10-03T06:00:00Z');
const session = (over: Partial<AnswerSession>): AnswerSession => ({
  id: Math.random().toString(36).slice(2),
  course_id: 'hp',
  starts_at: '2026-10-09T12:30:00Z', // Fri 6:00 pm IST
  ends_at: '2026-10-11T14:30:00Z', // Sun 8:00 pm IST
  timezone: 'Asia/Kolkata',
  mode: 'in_person',
  venue: 'Community Hall',
  city: 'Jayanagar',
  status: 'scheduled',
  ...over,
});

describe('buildCourseAnswer', () => {
  it('answers a named course with its next session, using only real values', () => {
    const a = buildCourseAnswer({ text: 'When is the next happiness program?', courses, sessions: [session({ instructor_name: 'Anita' })], now });
    expect(a.kind).toBe('course_details');
    expect(a.body).toContain('Course: Happiness Program');
    expect(a.body).toContain('Fri, 9 Oct 2026 – Sun, 11 Oct 2026');
    expect(a.body).toContain('Duration: 3 days');
    expect(a.body).toContain('Venue: Community Hall, Jayanagar');
    expect(a.body).toContain('Conducted by: Anita');
    expect(a.body).toContain('Registration: https://aol.example/hp'); // falls back to the course link
  });

  it('drops lines it has no data for instead of guessing', () => {
    const a = buildCourseAnswer({
      text: 'sahaj kab hai?',
      courses,
      sessions: [session({ course_id: 'ss', venue: null, city: null, mode: 'online', instructor_name: null })],
      now,
    });
    expect(a.body).not.toMatch(/Venue:|Conducted by:|Registration:/);
    expect(a.body).toContain('Mode: Online');
  });

  it('a named course with nothing scheduled says so, never inventing a date', () => {
    const a = buildCourseAnswer({ text: 'Sahaj Samadhi details please?', courses, sessions: [session({})], now });
    expect(a.kind).toBe('no_upcoming');
    expect(a.body).toContain('Sahaj Samadhi Meditation');
    expect(a.body).not.toMatch(/Oct 2026/);
  });

  it('ignores past, cancelled and inactive-course sessions', () => {
    const sessions = [
      session({ ends_at: '2026-10-01T10:00:00Z', starts_at: '2026-10-01T08:00:00Z' }),
      session({ status: 'cancelled' }),
      session({ course_id: 'old' }),
    ];
    expect(buildCourseAnswer({ text: 'next course?', courses, sessions, now }).kind).toBe('fallback');
  });

  it('lists upcoming programs when no course is named', () => {
    const a = buildCourseAnswer({
      text: 'what courses are coming up?',
      courses,
      sessions: [session({}), session({ course_id: 'ss', mode: 'online', starts_at: '2026-10-20T12:30:00Z', ends_at: '2026-10-20T14:30:00Z' })],
      now,
    });
    expect(a.kind).toBe('course_list');
    expect(a.body).toContain('• Happiness Program – Fri, 9 Oct 2026 – Sun, 11 Oct 2026 – Community Hall, Jayanagar');
    expect(a.body).toContain('• Sahaj Samadhi Meditation – Tue, 20 Oct 2026 – Online');
  });

  it('single-sitting sessions show hours; custom templates are used', () => {
    const a = buildCourseAnswer({
      text: 'sahaj timings?',
      courses,
      sessions: [session({ course_id: 'ss', starts_at: '2026-10-20T12:30:00Z', ends_at: '2026-10-20T14:30:00Z' })],
      templates: { course_details: '{{course_name}} | {{session_time}} | {{duration}}' },
      now,
    });
    expect(a.body).toBe('Sahaj Samadhi Meditation | 6:00 pm – 8:00 pm | 2 hours');
  });
});

describe('helpers', () => {
  it('matches courses by a distinctive word, not by generic ones', () => {
    expect(matchCourses('happiness kab hai', courses).map((c) => c.id)).toEqual(['hp']);
    expect(matchCourses('which program is next', courses)).toEqual([]);
  });
  it('flags unknown placeholders', () => {
    expect(unknownDvPlaceholders('{{course_name}} {{price}}')).toEqual(['price']);
  });
});

describe('extractRequestedCount', () => {
  it.each([
    ['please share 5 numbers I can contact', 5],
    ['Jai Gurudev, I want to do seva. Give me 10 contacts', 10],
    ['mujhe das numbers do', 10],
    ['send three leads', 3],
    ['i can call 200 people', 50], // capped
  ])('%s -> %s', (text, expected) => {
    expect(extractRequestedCount(text)).toBe(expected);
  });
  it.each(['I would like to do seva', '', 'call me at 5 pm', '0 numbers'])('no count: %s', (text) => {
    expect(extractRequestedCount(text)).toBeNull();
  });
});

describe('parseApprovalReply', () => {
  it.each([
    ['YES 12', { action: 'approve', ref: 12, count: null, reason: null }],
    ['yes #12', { action: 'approve', ref: 12, count: null, reason: null }],
    ['Yes 12 3', { action: 'approve', ref: 12, count: 3, reason: null }],
    ['approve 7 2 leads', { action: 'approve', ref: 7, count: 2, reason: null }],
    ['haan 5', { action: 'approve', ref: 5, count: null, reason: null }],
    ['NO 12', { action: 'decline', ref: 12, count: null, reason: null }],
    ['no 12 please finish your current leads first', { action: 'decline', ref: 12, count: null, reason: 'please finish your current leads first' }],
    ['nahi #9 busy week', { action: 'decline', ref: 9, count: null, reason: 'busy week' }],
  ])('%s', (text, expected) => {
    expect(parseApprovalReply(text)).toEqual(expected);
  });

  it.each(['yes', 'ok thanks', 'no problem', 'yes 12 maybe later', 'yes 12 99', 'call me at 5', 'I want to do seva', ''])(
    'not a decision: %s',
    (text) => {
      expect(parseApprovalReply(text)).toBeNull();
    },
  );
});
