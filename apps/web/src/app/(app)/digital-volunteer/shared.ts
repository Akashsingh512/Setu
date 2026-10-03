// Types and helpers shared by the Digital Volunteer pages.

export type WaAccount = {
  enabled: boolean;
  auto_paused: boolean;
  status: string;
  phone_e164: string | null;
  display_name: string | null;
  connected_at: string | null;
  gateway_seen_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  dm_mode: 'manual' | 'assisted' | 'automatic';
  dm_course_info: boolean;
  dm_followup_sync: boolean;
  dm_seva_requests: boolean;
};

/** The gateway reports in every 20 s; silence for 90 s means it isn't running. */
export function gatewayAlive(seenAt: string | null, now: number): boolean {
  return !!seenAt && now - new Date(seenAt).getTime() < 90_000;
}
