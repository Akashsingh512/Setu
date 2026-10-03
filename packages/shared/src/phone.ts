import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export type PhoneResult = { ok: true; e164: string } | { ok: false; error: string };

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Normalise user input to E.164 (the only format the database accepts).
 * Numbers without a country code are interpreted in `defaultCountry`
 * (org_settings.default_phone_country).
 */
export function normalizePhone(input: string, defaultCountry: string = 'IN'): PhoneResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Phone number is required' };

  // "00" international prefix -> "+"
  const cleaned = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry as CountryCode);
  if (!parsed || !parsed.isValid()) {
    return { ok: false, error: 'Enter a valid mobile number' };
  }
  const e164 = parsed.number;
  if (!E164.test(e164)) return { ok: false, error: 'Enter a valid mobile number' };
  return { ok: true, e164 };
}

export function isE164(value: string): boolean {
  return E164.test(value);
}

/** Human-friendly display, e.g. "+91 98450 12345". Falls back to the raw value. */
export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

/** `tel:` URL that opens the native dialer (mobile) or default calling app (desktop). */
export function telUrl(e164: string): string {
  return `tel:${e164.replace(/[^+0-9]/g, '')}`;
}
