// The WhatsApp message for an intro talk, used to prefill an announcement.
// Plain text with WhatsApp formatting (*bold*); people can still edit it before sending.

export type IntroTalk = {
  id: string;
  name: string;
  location: string;
  starts_at: string;
  organised_by: string | null;
  location_url: string | null;
};

export function introTalkMessage(t: IntroTalk, timeZone: string): string {
  const when = new Date(t.starts_at);
  const day = new Intl.DateTimeFormat('en-IN', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(when);
  const time = new Intl.DateTimeFormat('en-IN', { timeZone, hour: 'numeric', minute: '2-digit' }).format(when);
  return [
    `🙏 *${t.name}*`,
    '',
    `📅 ${day}`,
    `⏰ ${time}`,
    `📍 ${t.location}`,
    t.location_url ? `🗺️ ${t.location_url}` : null,
    t.organised_by ? `👤 Organised by ${t.organised_by}` : null,
    '',
    'All are welcome. Please share with friends and family!',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
