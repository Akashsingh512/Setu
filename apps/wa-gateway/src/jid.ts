// Helpers for WhatsApp ids ("JIDs").
//   919845012345@s.whatsapp.net   a phone-number user
//   1234567890123@lid              a privacy id (number hidden) - newer WhatsApp
//   120363...@g.us                 a group

/** "+919845012345" from a phone-number JID, ignoring any device suffix (":12"). */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const m = /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return m ? `+${m[1]}` : null;
}

/** WhatsApp chat id for an E.164 number. */
export function jidFromPhone(e164: string): string {
  return `${e164.replace(/^\+/, '')}@s.whatsapp.net`;
}

export const isGroupJid = (jid: string | null | undefined) => !!jid && jid.endsWith('@g.us');
export const isLidJid = (jid: string | null | undefined) => !!jid && jid.endsWith('@lid');
