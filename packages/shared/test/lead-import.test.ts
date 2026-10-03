import { describe, expect, it } from 'vitest';
import { checkImportRows, guessMapping, importTemplateCsv, parseCsv, parseImportDate } from '../src/lead-import';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const rows = parseCsv('﻿Name,Notes\r\n"Kumar, Vinod","said ""hi""\nthen left"\r\nAsha,\r\n\r\n');
    expect(rows).toEqual([
      ['Name', 'Notes'],
      ['Kumar, Vinod', 'said "hi"\nthen left'],
      ['Asha', ''],
    ]);
  });

  it('detects semicolon-separated files', () => {
    expect(parseCsv('Name;Phone\nAsha;98450 12345')).toEqual([
      ['Name', 'Phone'],
      ['Asha', '98450 12345'],
    ]);
  });
});

describe('guessMapping', () => {
  it('maps common header names and keeps WhatsApp separate from phone', () => {
    const m = guessMapping(['Full Name', 'Mobile Number', 'WhatsApp', 'E-mail', 'Program', 'Date', 'Something else']);
    expect(m).toEqual({ full_name: 0, phone: 1, whatsapp_phone: 2, email: 3, course: 4, met_on: 5 });
  });

  it('round-trips the template headers', () => {
    const [header] = parseCsv(importTemplateCsv());
    expect(Object.keys(guessMapping(header!))).toHaveLength(11);
  });
});

describe('parseImportDate', () => {
  it('reads ISO and day-first dates and rejects impossible ones', () => {
    expect(parseImportDate('2026-09-28')).toBe('2026-09-28');
    expect(parseImportDate('28/09/2026')).toBe('2026-09-28');
    expect(parseImportDate('5-1-26')).toBe('2026-01-05');
    expect(parseImportDate('31/02/2026')).toBeNull();
    expect(parseImportDate('next week')).toBeNull();
  });
});

describe('checkImportRows', () => {
  const courses = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Happiness Program' }];
  const mapping = { full_name: 0, phone: 1, source: 2, course: 3, met_on: 4, email: 5 };

  it('normalises valid rows and resolves source and course names', () => {
    const [r] = checkImportRows([['Vinod', '98450 12345', 'satsang', 'happiness program', '28/09/2026', 'V@Example.com']], mapping, {
      defaultCountry: 'IN',
      courses,
    });
    expect(r!.errors).toEqual([]);
    expect(r!.warnings).toEqual([]);
    expect(r!.lead).toMatchObject({
      full_name: 'Vinod',
      phone: '+919845012345',
      source: 'satsang',
      course_id: courses[0]!.id,
      met_on: '2026-09-28',
      email: 'v@example.com',
    });
  });

  it('rejects rows without a name or a valid phone, warns on soft problems', () => {
    const rows = checkImportRows(
      [
        ['', '98450 12345', '', '', '', ''],
        ['Asha', '123', '', '', '', ''],
        ['Ravi', '9845012346', 'flyer', 'Yoga', 'soon', 'not-an-email'],
      ],
      mapping,
      { defaultCountry: 'IN', courses },
    );
    expect(rows[0]!.errors).toEqual(['Name is missing']);
    expect(rows[1]!.lead).toBeNull();
    expect(rows[2]!.lead).toMatchObject({ source: 'other', source_detail: 'flyer', course_id: null, met_on: null, email: null });
    expect(rows[2]!.warnings).toHaveLength(4);
  });

  it('flags repeated phones within the file, whatever their formatting', () => {
    const rows = checkImportRows(
      [
        ['A', '98450 12345'],
        ['B', '+91-98450-12345'],
      ],
      { full_name: 0, phone: 1 },
      { defaultCountry: 'IN', courses: [] },
    );
    expect(rows.map((r) => r.duplicateOfLine)).toEqual([null, 2]);
  });
});
