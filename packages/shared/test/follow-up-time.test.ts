import { describe, expect, it } from 'vitest';
import { parseFollowUpTime } from '../src/follow-up-time';

// "Now" = Wednesday 7 Oct 2026, 11:15 pm in India (17:45 UTC).
const NOW = new Date('2026-10-07T17:45:00Z');
const ist = (s: string | null | undefined) => (s ? new Date(s) : null);
const at = (text: string) => parseFollowUpTime(text, NOW, 'Asia/Kolkata')?.toISOString() ?? null;
const istIso = (local: string) => new Date(`${local}+05:30`).toISOString();

describe('parseFollowUpTime', () => {
  it('days and times', () => {
    expect(at('Vimala follow up tomorrow 5pm')).toBe(istIso('2026-10-08T17:00:00'));
    expect(at('L-000037 call back tomorrow at 5:30 pm')).toBe(istIso('2026-10-08T17:30:00'));
    expect(at('follow up day after tomorrow morning')).toBe(istIso('2026-10-09T10:00:00'));
    expect(at('call back saturday evening')).toBe(istIso('2026-10-10T18:00:00'));
    expect(at('follow up on 12 oct 11am')).toBe(istIso('2026-10-12T11:00:00'));
    expect(at('followup oct 15')).toBe(istIso('2026-10-15T10:00:00'));
    expect(at('follow up 20/10 17:00')).toBe(istIso('2026-10-20T17:00:00'));
    expect(at('remind me tomorrow at 4')).toBe(istIso('2026-10-08T16:00:00'));
  });
  it('relative times, and a time with no day', () => {
    expect(at('not picking, follow up in 2 hours')).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
    expect(at('follow up in 3 days')).toBe(new Date(NOW.getTime() + 3 * 86_400_000).toISOString());
    expect(at('follow up 9am')).toBe(istIso('2026-10-08T09:00:00')); // 9 am has passed today
  });
  it('a past date means next year; no follow-up word or no time = nothing', () => {
    expect(at('follow up 2 oct')).toBe(istIso('2027-10-02T10:00:00'));
    expect(at('Vimala called, coming on Sunday')).toBeNull();
    expect(at('please follow up')).toBeNull();
    expect(ist(null)).toBeNull();
  });
});
