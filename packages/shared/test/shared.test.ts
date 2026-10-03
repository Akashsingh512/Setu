import { describe, expect, it } from 'vitest';
import {
  buildCourseMessage,
  chooseMessageCourseId,
  courseInputSchema,
  formatSessionSchedule,
  inviteUserSchema,
  leadInputSchema,
  messageTemplateSchema,
  navForRole,
  normalizePhone,
  renderTemplate,
  sessionInputSchema,
  telUrl,
  whatsAppUrl,
} from '../src';

const TEAM = '6f1c2a54-8a0e-4b8f-9a77-1d6b9d4f0c11';
const COURSE = '0b7d7e1e-3c4b-4a8c-8e7f-2a1b3c4d5e6f';

describe('phone numbers', () => {
  it.each([
    ['98450 12345', '+919845012345'],
    ['+91 98450-12345', '+919845012345'],
    ['0091 9845012345', '+919845012345'],
    ['09845012345', '+919845012345'],
  ])('normalises %s', (input, expected) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164: expected });
  });

  it('respects the default country and explicit country codes', () => {
    expect(normalizePhone('(415) 555-2671', 'US')).toEqual({ ok: true, e164: '+14155552671' });
    expect(normalizePhone('+44 7911 123456')).toEqual({ ok: true, e164: '+447911123456' });
  });

  it.each(['', '   ', '12345', 'abcdefghij', '+91 12'])('rejects %j', (input) => {
    expect(normalizePhone(input).ok).toBe(false);
  });

  it('builds tel: links', () => {
    expect(telUrl('+919845012345')).toBe('tel:+919845012345');
  });
});

describe('WhatsApp messages', () => {
  const course = {
    name: 'Happiness Program',
    short_description: 'Breathing techniques and meditation.',
    registration_url: 'https://example.org/hp',
  };
  const session = {
    starts_at: '2026-10-09T12:30:00Z', // 18:00 IST
    ends_at: '2026-10-11T14:30:00Z', // 20:00 IST
    timezone: 'Asia/Kolkata',
    schedule_note: 'Daily 6–8 pm',
    registration_url: 'https://example.org/hp-oct',
  };

  it('uses the official click-to-chat format with an encoded, unsent message', () => {
    const url = whatsAppUrl('+919845012345', 'Namaste Asha 🙏\nJai Gurudev');
    expect(url).toBe(`https://wa.me/919845012345?text=${encodeURIComponent('Namaste Asha 🙏\nJai Gurudev')}`);
    expect(whatsAppUrl('+919845012345')).toBe('https://wa.me/919845012345');
  });

  it('renders the default template with course and session details', () => {
    const text = buildCourseMessage({ leadName: 'Asha', course, session });
    expect(text).toContain('Namaste Asha 🙏');
    expect(text).toContain('details about Happiness Program with you.');
    expect(text).toContain('Breathing techniques and meditation.');
    expect(text).toMatch(/Upcoming program: Fri, 9 Oct,? 2026, 6:00 pm – Sun, 11 Oct,? 2026, 8:00 pm \(Daily 6–8 pm\)/i);
    expect(text).toContain('Registration link: https://example.org/hp-oct'); // session link wins
    expect(text.endsWith('Jai Gurudev 🙏')).toBe(true);
  });

  it('drops lines whose values are missing instead of leaving blanks', () => {
    const text = buildCourseMessage({ leadName: 'Asha', course: { name: 'Sudarshan Kriya' } });
    expect(text).not.toContain('Upcoming program');
    expect(text).not.toContain('Registration link');
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toContain('{{');
  });

  it('falls back to the course registration link without a session', () => {
    expect(buildCourseMessage({ leadName: 'A', course })).toContain('Registration link: https://example.org/hp');
  });

  it('renders custom templates', () => {
    expect(renderTemplate('Hi {{ lead_name }}, from {{volunteer_name}}', { lead_name: 'Ravi', volunteer_name: 'Meera' })).toBe(
      'Hi Ravi, from Meera',
    );
  });

  it('formats same-day sessions compactly', () => {
    const s = formatSessionSchedule({ starts_at: '2026-10-09T12:30:00Z', ends_at: '2026-10-09T14:30:00Z', timezone: 'Asia/Kolkata' });
    expect(s).toMatch(/^Fri, 9 Oct,? 2026, 6:00 pm – 8:00 pm$/i);
  });

  it('chooses the course: explicit choice > lead course > volunteer default', () => {
    expect(chooseMessageCourseId({ overrideCourseId: 'x', leadCourseId: 'y', volunteerDefaultCourseId: 'z' })).toBe('x');
    expect(chooseMessageCourseId({ leadCourseId: 'y', volunteerDefaultCourseId: 'z' })).toBe('y');
    expect(chooseMessageCourseId({ leadCourseId: null, volunteerDefaultCourseId: 'z' })).toBe('z');
    expect(chooseMessageCourseId({})).toBeNull();
  });
});

describe('validation schemas', () => {
  it('lead: normalises phones and blanks optional fields', () => {
    const r = leadInputSchema().parse({
      full_name: '  Asha  ',
      phone: '98450 12345',
      whatsapp_phone: '',
      email: '',
      team_id: TEAM,
      source_detail: '',
    });
    expect(r).toMatchObject({ full_name: 'Asha', phone: '+919845012345', whatsapp_phone: null, email: null, source: 'other', source_detail: null });
  });

  it('lead: requires name and a valid phone', () => {
    const r = leadInputSchema().safeParse({ full_name: ' ', phone: '123', team_id: TEAM });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['full_name', 'phone']));
  });

  it('course: rejects non-http registration links', () => {
    expect(courseInputSchema.safeParse({ name: 'X', registration_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(courseInputSchema.parse({ name: 'X', registration_url: '' }).registration_url).toBeNull();
  });

  it('session: end after start; online needs a link; in-person needs a venue', () => {
    const base = { course_id: COURSE, starts_at: '2026-10-09T12:30:00Z', ends_at: '2026-10-09T14:30:00Z' };
    expect(sessionInputSchema.safeParse({ ...base, venue: 'Hall' }).success).toBe(true);
    expect(sessionInputSchema.safeParse({ ...base, venue: 'Hall', ends_at: base.starts_at }).success).toBe(false);
    expect(sessionInputSchema.safeParse({ ...base, mode: 'online' }).success).toBe(false);
    expect(sessionInputSchema.safeParse({ ...base, mode: 'online', meeting_url: 'https://meet.example.org/x' }).success).toBe(true);
    expect(sessionInputSchema.safeParse({ ...base }).success).toBe(false);
  });

  it('templates: rejects unknown placeholders', () => {
    const r = messageTemplateSchema.safeParse({ name: 'T', body: 'Hi {{lead_name}} {{secret}}' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain('secret');
  });

  it('invite: teachers and volunteers need a team', () => {
    expect(inviteUserSchema().safeParse({ email: 'a@b.org', full_name: 'A', role: 'volunteer' }).success).toBe(false);
    expect(inviteUserSchema().safeParse({ email: 'a@b.org', full_name: 'A', role: 'super_admin' }).success).toBe(true);
  });
});

describe('navigation', () => {
  it('shows each role only its modules', () => {
    expect(navForRole('volunteer').map((n) => n.label)).toEqual(['Dashboard', 'My Leads', 'Upcoming Programs', 'Notifications', 'Profile']);
    expect(navForRole('teacher').map((n) => n.module)).not.toContain('settings');
    expect(navForRole('super_admin').map((n) => n.module)).toContain('users');
  });
});
