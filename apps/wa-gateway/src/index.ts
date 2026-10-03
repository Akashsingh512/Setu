// Digital Volunteer WhatsApp gateway.
//
// An always-on process holding the WhatsApp connection (open-source Baileys
// library, linked like WhatsApp Web). It is the only component that talks to
// WhatsApp, and it only acts on what the database authorises:
//   * wa_commands  - link / logout / sync_groups requested from the CRM
//   * wa_account   - emergency switch (enabled) and status it reports back
//   * wa_groups    - which groups may be read (anything else is not stored)
//   * wa_outbox    - messages approved for sending (claimed once each)
// Runs anywhere Node 20+ runs; the session lives in Postgres, not on disk.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  type ConnectionState,
  type proto,
  type WAMessage,
  type WASocket,
} from 'baileys';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import pino from 'pino';
import { usePostgresAuthState } from './auth-state.js';
import { isGroupJid, isLidJid, phoneFromJid } from './jid.js';
import { processMessage } from './process.js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(); // tolerate stray spaces from copy-paste
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side secrets) before starting the gateway.');
  process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const MAX_QR_CODES = 6; // ~2 minutes of codes, then wait for the user to ask again
const SEND_GAP_MS = 3_500; // pacing between outgoing messages (stays well under WhatsApp's anti-spam limits)

type Account = { enabled: boolean; auto_paused: boolean; status: string };
type GroupRow = { jid: string; enabled: boolean; allow_read: boolean; is_member: boolean };

let sock: WASocket | null = null;
let auth: Awaited<ReturnType<typeof usePostgresAuthState>> | null = null;
let connected = false;
let qrCount = 0;
let stopReason: 'qr_expired' | 'logout' | 'shutdown' | null = null;
let reconnectDelay = 2_000;
let account: Account = { enabled: false, auto_paused: false, status: 'not_linked' };
let groups = new Map<string, GroupRow>();
const sentCache = new Map<string, proto.IMessage>(); // lets WhatsApp re-request a message we sent

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------
async function setStatus(patch: Record<string, unknown>) {
  const { error } = await db.from('wa_account').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', true);
  if (error) log.error({ err: error.message }, 'status update failed');
}

async function setQr(dataUrl: string | null) {
  await db.from('wa_pairing').update({ qr_data_url: dataUrl, updated_at: new Date().toISOString() }).eq('id', true);
}

async function reportError(message: string) {
  log.warn(message);
  await setStatus({ last_error: message.slice(0, 500), last_error_at: new Date().toISOString() });
}

async function refreshConfig() {
  const [{ data: acc }, { data: grp }] = await Promise.all([
    db.from('wa_account').select('enabled, auto_paused, status').eq('id', true).single(),
    db.from('wa_groups').select('jid, enabled, allow_read, is_member'),
  ]);
  if (acc) account = acc as Account;
  if (grp) groups = new Map((grp as GroupRow[]).map((g) => [g.jid, g]));
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function connect(mode: 'resume' | 'link') {
  if (sock) return;
  auth = await usePostgresAuthState(db);
  if (mode === 'resume' && !auth.isRegistered()) {
    log.info('no saved WhatsApp login - waiting for "Link WhatsApp" in the CRM (Digital Volunteer > WhatsApp account)');
    await setStatus({ status: 'not_linked' });
    return;
  }
  qrCount = 0;
  stopReason = null;
  await setStatus({ status: 'connecting' });

  const s = makeWASocket({
    auth: auth.state,
    logger: log.child({ mod: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' }),
    browser: Browsers.ubuntu('Setu'),
    markOnlineOnConnect: false, // keep phone notifications working for humans
    // Only the initial sync (contacts, privacy-id mappings) - no old chat history.
    // Disabling sync entirely breaks the privacy-id mappings and destabilises the session.
    syncFullHistory: false,
    getMessage: async (key) => (key.id ? sentCache.get(key.id) : undefined),
  });
  sock = s;

  s.ev.on('creds.update', () => {
    void auth?.saveCreds().catch((e: Error) => log.error({ err: e.message }, 'saving session failed'));
  });
  s.ev.on('connection.update', (u) => void onConnectionUpdate(s, u).catch((e: Error) => log.error({ err: e.message }, 'connection handler')));
  s.ev.on('messages.upsert', ({ messages, type }) => {
    log.info({ type, count: messages.length }, 'messages event');
    if (type !== 'notify') return;
    for (const m of messages) void onMessage(s, m).catch((e: Error) => log.error({ err: e.message }, 'message handler'));
  });
  // Group events carry the changed groups: update just those (a full reload on
  // every rename/join is what triggers WhatsApp's "rate-overlimit").
  s.ev.on('groups.upsert', (list) => void upsertGroups(list));
  s.ev.on('groups.update', (list) => void upsertGroups(list));
}

async function onConnectionUpdate(s: WASocket, update: Partial<ConnectionState>) {

  if (update.qr) {
    qrCount += 1;
    if (qrCount > MAX_QR_CODES) {
      stopReason = 'qr_expired';
      s.end(undefined);
      return;
    }
    await setQr(await QRCode.toDataURL(update.qr, { margin: 1, width: 320 }));
    await setStatus({ status: 'waiting_for_scan' });
    log.info('waiting for QR scan');
  }

  if (update.connection === 'open') {
    connected = true;
    reconnectDelay = 2_000;
    const me = s.user;
    await setQr(null);
    await setStatus({
      status: 'connected',
      phone_e164: phoneFromJid(me?.id ? jidNormalizedUser(me.id) : null),
      display_name: me?.name ?? me?.verifiedName ?? null,
      connected_at: new Date().toISOString(),
      last_error: null,
    });
    log.info({ phone: me?.id }, 'connected');
    await syncGroups(); // skipped if a full reload ran in the last 10 minutes
  }

  if (update.connection === 'close') {
    connected = false;
    sock = null;
    // Baileys closes with a Boom error carrying the WhatsApp status code.
    const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    log.info({ code, stopReason }, 'connection closed');

    if (code === DisconnectReason.loggedOut || stopReason === 'logout') {
      await auth?.clear();
      await setQr(null);
      await setStatus({ status: 'logged_out', phone_e164: null, display_name: null, connected_at: null });
      return;
    }
    if (stopReason === 'qr_expired') {
      await setQr(null);
      await setStatus({ status: 'not_linked' });
      await reportError('The QR code expired before it was scanned. Click "Link WhatsApp" to try again.');
      return;
    }
    if (stopReason === 'shutdown') return;
    if (code === DisconnectReason.restartRequired) {
      // Normal right after a successful scan: reconnect straight away.
      reconnectDelay = 0;
      scheduleReconnect();
      return;
    }
    await setStatus({ status: 'disconnected' });
    await reportError(`WhatsApp connection lost (code ${code ?? 'unknown'}). Reconnecting…`);
    scheduleReconnect();
  }
}

const FULL_SYNC_MIN_GAP_MS = 10 * 60_000;
let lastFullSync = 0;
let syncBlockedUntil = 0;

/**
 * Reloads the whole group list. WhatsApp rate-limits this call, so it runs at
 * most every 10 minutes (unless a person asks), and backs off when told to.
 */
/** Reconnects after a delay; if reconnecting itself fails (e.g. no internet), tries again with a longer wait. */
function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(Math.max(reconnectDelay * 2, 2_000), 60_000); // 2 s floor, 60 s cap
  setTimeout(() => {
    connect('resume').catch((e: Error) => {
      sock = null;
      log.warn({ err: e.message, retryInMs: reconnectDelay }, 'reconnect failed - will retry');
      scheduleReconnect();
    });
  }, delay);
}

async function syncGroups(opts: { requested?: boolean } = {}): Promise<number | string> {
  if (!sock || !connected) return 0;
  const now = Date.now();
  if (now < syncBlockedUntil) return `WhatsApp asked us to slow down - try again after ${new Date(syncBlockedUntil).toLocaleTimeString('en-IN')}`;
  if (!opts.requested && now - lastFullSync < FULL_SYNC_MIN_GAP_MS) return 0;
  lastFullSync = now;
  try {
    const all = await sock.groupFetchAllParticipating();
    const rows = Object.values(all).map((g) => ({
      jid: g.id,
      name: g.subject ?? '',
      description: g.desc ?? null,
      participant_count: g.participants?.length ?? null,
    }));
    const { data, error } = await db.rpc('dv_sync_groups', { p_groups: rows });
    if (error) throw new Error(error.message);
    await refreshConfig();
    log.info({ count: rows.length }, 'group list loaded');
    return (data as number) ?? rows.length;
  } catch (e) {
    const msg = (e as Error).message;
    if (/rate-overlimit/i.test(msg)) {
      syncBlockedUntil = Date.now() + 5 * 60_000;
      setTimeout(() => void syncGroups(), 5 * 60_000 + 5_000);
      await reportError('WhatsApp temporarily limited loading the group list. Retrying automatically in 5 minutes.');
      return 'WhatsApp asked us to slow down - retrying in 5 minutes';
    }
    await reportError(`Could not load groups: ${msg}`);
    return 0;
  }
}

/** Adds or updates specific groups without reloading the whole list. Never touches permissions. */
async function upsertGroups(list: { id?: string; subject?: string; desc?: string; participants?: unknown[] }[]) {
  const rows = list
    .filter((g): g is typeof g & { id: string } => !!g.id && isGroupJid(g.id))
    .map((g) => ({
      jid: g.id,
      is_member: true,
      ...(g.subject !== undefined ? { name: g.subject } : {}),
      ...(g.desc !== undefined ? { description: g.desc } : {}),
      ...(g.participants ? { participant_count: g.participants.length } : {}),
    }));
  if (!rows.length) return;
  // One row at a time: a batch would fill fields missing from some rows with NULL.
  for (const row of rows) {
    const { error } = await db.from('wa_groups').upsert(row, { onConflict: 'jid' });
    if (error) log.warn({ err: error.message, jid: row.jid }, 'group update failed');
  }
  await refreshConfig();
}

/** A message arrived from a group the CRM hasn't seen: register it (switched off) so it appears on the Groups page. */
async function registerUnknownGroup(jid: string) {
  try {
    const meta = await sock!.groupMetadata(jid);
    await upsertGroups([{ id: jid, subject: meta.subject, desc: meta.desc, participants: meta.participants }]);
  } catch {
    await upsertGroups([{ id: jid }]);
  }
  log.info({ jid }, 'new group registered (switched off until enabled in the CRM)');
}

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------
function textOf(content: proto.IMessage | undefined): { text: string | null; media: string | null } {
  if (!content) return { text: null, media: null };
  const type = getContentType(content);
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null;
  const media = type && /image|video|audio|document|sticker/i.test(type) ? type.replace(/Message$/, '') : null;
  return { text, media };
}

async function senderPhone(s: WASocket, jid: string | null | undefined, alt: string | null | undefined): Promise<string | null> {
  const direct = phoneFromJid(alt) ?? phoneFromJid(jid);
  if (direct) return direct;
  if (jid && isLidJid(jid)) {
    try {
      return phoneFromJid(await s.signalRepository.lidMapping.getPNForLID(jid));
    } catch {
      return null;
    }
  }
  return null;
}

async function onMessage(s: WASocket, m: WAMessage) {
  const chat = m.key.remoteJid;
  if (!account.enabled) {
    log.info({ chat }, 'ignored: Digital Volunteer is switched off (WhatsApp account page > Turn on)');
    return; // emergency switch: read nothing
  }
  if (!chat || chat === 'status@broadcast' || chat.endsWith('@broadcast') || chat.endsWith('@newsletter')) return;
  if (m.key.fromMe) {
    log.info({ chat }, 'ignored: sent by the linked number itself');
    return;
  }

  const content = normalizeMessageContent(m.message);
  const { text, media } = textOf(content);
  if (!text && !media) {
    // Poll votes, reactions and receipts are normal and frequent: keep them out of the info log.
    // A message with a stub type and no content means it could not be decrypted.
    log.debug({ chat, stub: m.messageStubType ?? null, parts: Object.keys(m.message ?? {}) }, 'ignored: no readable text');
    return;
  }

  const group = isGroupJid(chat);
  if (group) {
    const g = groups.get(chat);
    if (!g) {
      await registerUnknownGroup(chat);
      return;
    }
    if (!g.enabled || !g.allow_read || !g.is_member) {
      // Not permitted: not stored at all. Logged (without content) so it's clear why nothing happened.
      log.info({ group: chat, enabled: g.enabled, allow_read: g.allow_read }, 'ignored: group not enabled for reading');
      return;
    }
  }

  const senderJid = group ? m.key.participant : chat;
  const senderAlt = group ? m.key.participantAlt : m.key.remoteJidAlt;
  const phone = await senderPhone(s, senderJid, senderAlt);
  const sentAt = new Date(Number(m.messageTimestamp ?? Date.now() / 1000) * 1000).toISOString();

  const { data, error } = await db.rpc('dv_ingest_message', {
    p_chat_jid: chat,
    p_provider_message_id: m.key.id ?? `${chat}:${sentAt}`,
    p_direction: 'in',
    p_sender_jid: senderJid ?? null,
    p_sender_phone: phone,
    p_sender_name: m.pushName ?? null,
    p_body: text,
    p_media_type: media,
    p_sent_at: sentAt,
  });
  if (error) {
    await reportError(`Could not store an incoming message: ${error.message}`);
    return;
  }
  if (!data) return; // duplicate delivery: already handled
  // senderKnown: did we learn the sender's phone number? (WhatsApp often hides it behind a private id.)
  log.info({ id: data, chat, senderKnown: !!phone }, 'message stored');
  const groupId = group ? ((await db.from('wa_groups').select('id').eq('jid', chat).maybeSingle()).data?.id ?? null) : null;
  await processMessage(db, { id: data as string, groupId, text }, log).catch((e: Error) =>
    log.warn({ err: e.message, id: data }, 'processing failed - left for a person'),
  );
}

// ---------------------------------------------------------------------------
// Outgoing messages
// ---------------------------------------------------------------------------
type OutboxRow = { id: string; chat_jid: string; body: string | null; media_path: string | null };
let sending = false;

async function drainOutbox() {
  if (sending || !sock || !connected || !account.enabled) return;
  sending = true;
  try {
    const { data, error } = await db.rpc('dv_claim_outbox', { p_limit: 5 });
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as OutboxRow[]) {
      try {
        if (row.media_path) throw new Error('Sending images is not available yet');
        const sent = await sock.sendMessage(row.chat_jid, { text: row.body ?? '' });
        const id = sent?.key.id ?? null;
        if (id && sent?.message) {
          sentCache.set(id, sent.message);
          if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value!);
        }
        await db.rpc('dv_complete_outbox', { p_id: row.id, p_ok: true, p_provider_message_id: id });
        if (id) {
          await db.rpc('dv_ingest_message', {
            p_chat_jid: row.chat_jid, p_provider_message_id: id, p_direction: 'out', p_sender_jid: null,
            p_sender_phone: null, p_sender_name: null, p_body: row.body, p_media_type: null,
            p_sent_at: new Date().toISOString(), p_outbox_id: row.id,
          });
        }
      } catch (e) {
        await db.rpc('dv_complete_outbox', { p_id: row.id, p_ok: false, p_error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
  } catch (e) {
    await reportError(`Outbox error: ${(e as Error).message}`);
  } finally {
    sending = false;
  }
}

// ---------------------------------------------------------------------------
// Commands from the CRM
// ---------------------------------------------------------------------------
async function runCommands() {
  const { data } = await db.from('wa_commands').select('id, command').is('done_at', null).order('requested_at').limit(5);
  for (const cmd of (data ?? []) as { id: number; command: string }[]) {
    let result = 'done';
    try {
      if (cmd.command === 'link') {
        if (connected) result = 'Already linked';
        else if (sock) result = 'Linking already in progress';
        else {
          // Fresh pairing: never reuse a half-finished or logged-out session.
          await (await usePostgresAuthState(db)).clear();
          await connect('link');
          result = 'QR code requested';
        }
      } else if (cmd.command === 'logout') {
        if (sock) {
          stopReason = 'logout';
          await sock.logout().catch(() => sock?.end(undefined));
        } else {
          await (await usePostgresAuthState(db)).clear();
          await setQr(null);
          await setStatus({ status: 'logged_out', phone_e164: null, display_name: null, connected_at: null });
        }
        result = 'Unlinked';
      } else if (cmd.command === 'sync_groups') {
        if (!connected) result = 'Not connected';
        else {
          const r = await syncGroups({ requested: true });
          result = typeof r === 'number' ? `${r} group(s) found` : r;
        }
      }
    } catch (e) {
      result = `Failed: ${(e as Error).message}`;
    }
    await db.from('wa_commands').update({ done_at: new Date().toISOString(), result: result.slice(0, 500) }).eq('id', cmd.id);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function heartbeat() {
  await refreshConfig();
  await setStatus({ gateway_seen_at: new Date().toISOString() });
}

async function main() {
  log.info('Digital Volunteer gateway starting');
  // A network blip must never kill the gateway: log it and carry on (reconnects retry by themselves).
  process.on('unhandledRejection', (e) => log.error({ err: e instanceof Error ? e.message : String(e) }, 'unexpected error (continuing)'));

  await heartbeat().catch((e: Error) => log.warn({ err: e.message }, 'first heartbeat failed'));
  await connect('resume').catch((e: Error) => {
    sock = null;
    log.warn({ err: e.message }, 'could not connect at start - will retry');
    scheduleReconnect();
  });

  setInterval(() => void heartbeat().catch((e: Error) => log.error({ err: e.message }, 'heartbeat')), 20_000);
  setInterval(() => void runCommands().catch((e: Error) => log.error({ err: e.message }, 'commands')), 3_000);
  setInterval(() => void drainOutbox(), 3_000);

  const shutdown = async () => {
    stopReason = 'shutdown';
    sock?.end(undefined);
    await setStatus({ status: 'disconnected', last_error: 'Gateway stopped', last_error_at: new Date().toISOString() });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
