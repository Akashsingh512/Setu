// Delivers pending notifications to devices.
//
// Woken (no body needed) by the notifications insert trigger via pg_net and by
// a once-a-minute cron sweep. It only ever sends what the database has queued
// (claim_push_batch hands each notification out once), so an extra call just
// flushes the queue early. Web Push for browsers / installed PWA; Expo push
// service for the mobile app.
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional EXPO_ACCESS_TOKEN).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type Token = { token: string; platform: 'web' | 'ios' | 'android' };
type Item = { id: string; type: string; title: string; body: string | null; data: Record<string, unknown>; tokens: Token[] };

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.org', vapidPublic, vapidPrivate);
}

/** Where tapping the notification should open (app-relative path). */
function linkFor(n: Item): string {
  const d = n.data ?? {};
  const ids = Array.isArray(d.lead_ids) ? (d.lead_ids as string[]) : [];
  if (typeof d.lead_id === 'string') return `/leads/${d.lead_id}`;
  if (ids.length === 1) return `/leads/${ids[0]}`;
  if (ids.length > 1) return '/leads';
  if (n.type === 'registration_pending') return '/volunteers';
  if (n.type === 'seva_request_pending' || n.type === 'seva_assigned') return '/digital-volunteer/seva';
  if (n.type.startsWith('session_')) return '/upcoming';
  if (n.type === 'leads_need_attention') return '/leads?view=attention';
  return '/notifications';
}

async function sendWeb(n: Item, t: Token): Promise<'sent' | 'dead' | 'failed'> {
  if (!vapidPublic || !vapidPrivate) return 'failed';
  try {
    const sub = JSON.parse(t.token);
    await webpush.sendNotification(
      sub,
      JSON.stringify({ title: n.title, body: n.body ?? '', url: linkFor(n), tag: n.id }),
      { TTL: 60 * 60 * 12, urgency: n.type === 'lead_assigned' ? 'high' : 'normal' },
    );
    return 'sent';
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    // 404/410: the subscription is gone (permission revoked, browser data cleared).
    if (code === 404 || code === 410 || e instanceof SyntaxError) return 'dead';
    console.error('web push failed', code, (e as Error).message);
    return 'failed';
  }
}

async function sendExpo(items: { n: Item; t: Token }[]): Promise<Map<string, 'sent' | 'dead' | 'failed'>> {
  const out = new Map<string, 'sent' | 'dead' | 'failed'>();
  if (!items.length) return out;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const token = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers,
        body: JSON.stringify(
          chunk.map(({ n, t }) => ({ to: t.token, title: n.title, body: n.body ?? '', sound: 'default', priority: 'high', data: { url: linkFor(n), notification_id: n.id } })),
        ),
      });
      const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
      chunk.forEach(({ n, t }, j) => {
        const r = json.data?.[j];
        out.set(`${n.id}|${t.token}`, r?.status === 'ok' ? 'sent' : r?.details?.error === 'DeviceNotRegistered' ? 'dead' : 'failed');
      });
    } catch (e) {
      console.error('expo push failed', (e as Error).message);
      chunk.forEach(({ n, t }) => out.set(`${n.id}|${t.token}`, 'failed'));
    }
  }
  return out;
}

async function processBatch(): Promise<number> {
  const { data, error } = await supabase.rpc('claim_push_batch', { p_limit: 100 });
  if (error) throw new Error(error.message);
  const batch = (data ?? []) as Item[];
  if (!batch.length) return 0;

  const results: { id: string; status: 'sent' | 'failed' }[] = [];
  const dead = new Set<string>();
  const expo = await sendExpo(batch.flatMap((n) => n.tokens.filter((t) => t.platform !== 'web').map((t) => ({ n, t }))));

  await Promise.all(
    batch.map(async (n) => {
      const outcomes = await Promise.all(
        n.tokens.map((t) => (t.platform === 'web' ? sendWeb(n, t) : Promise.resolve(expo.get(`${n.id}|${t.token}`) ?? 'failed'))),
      );
      outcomes.forEach((o, i) => o === 'dead' && dead.add(n.tokens[i]!.token));
      // Delivered if it reached at least one of the person's devices.
      results.push({ id: n.id, status: outcomes.includes('sent') ? 'sent' : 'failed' });
    }),
  );

  const { error: doneError } = await supabase.rpc('complete_push_batch', { p_results: results, p_dead_tokens: [...dead] });
  if (doneError) throw new Error(doneError.message);
  return batch.length;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const started = Date.now();
  let processed = 0;
  try {
    // Drain the queue, but stay well inside the function time limit.
    while (Date.now() - started < 20_000) {
      const n = await processBatch();
      processed += n;
      if (n < 100) break;
    }
    return Response.json({ processed });
  } catch (e) {
    console.error(e);
    return Response.json({ error: 'dispatch failed', processed }, { status: 500 });
  }
});
