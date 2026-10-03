// Leads saved on this device while offline, and sending them when the internet is back.
//
// Each lead gets an id made here (ref). The database remembers it, so sending the same
// lead again after a dropped connection returns the lead made the first time instead
// of creating a second one (add_lead_from_device). Items belong to the account that
// saved them: another account signed in on the same phone never sends them.
//
// Browser-only: call these from effects or event handlers.
import type { SupabaseClient } from '@supabase/supabase-js';

export type OfflineLeadInput = {
  full_name: string;
  phone: string; // E.164, checked before saving
  whatsapp_phone: string | null;
  email: string | null;
  source: string;
  source_detail: string | null;
  met_on: string | null;
  meeting_notes: string | null;
  course_id: string | null;
  team_id: string | null;
};

export type OfflineLead = {
  ref: string;
  ownerId: string;
  savedAt: string;
  lead: OfflineLeadInput;
  assignToMe: boolean;
  state: 'pending' | 'synced' | 'duplicate' | 'error';
  message?: string;
  leadId?: string;
  leadCode?: string;
};

/** What the offline page needs to work with no network, refreshed whenever the app is online. */
export type OfflineContext = {
  userId: string;
  role: 'super_admin' | 'teacher' | 'volunteer';
  teamId: string | null;
  phoneCountry: string;
  courses: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  savedAt: string;
};

const QUEUE_KEY = 'setu.offlineLeads.v1';
const CONTEXT_KEY = 'setu.offlineContext.v1';
export const QUEUE_EVENT = 'setu:offline-leads';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: nothing more we can do on this device.
  }
}

export const loadQueue = (): OfflineLead[] => read<OfflineLead[]>(QUEUE_KEY, []);
export const loadContext = (): OfflineContext | null => read<OfflineContext | null>(CONTEXT_KEY, null);
export function saveContext(ctx: OfflineContext) {
  write(CONTEXT_KEY, ctx);
  window.dispatchEvent(new Event(QUEUE_EVENT));
}

// For useSyncExternalStore: the stored text is a stable snapshot (same string = no re-render).
function rawItem(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
export const rawQueue = () => rawItem(QUEUE_KEY);
export const rawContext = () => rawItem(CONTEXT_KEY);
export function parseJson<T>(raw: string, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
/** Fires on changes from this tab (QUEUE_EVENT) and other tabs (storage). */
export function subscribeStore(onChange: () => void): () => void {
  window.addEventListener(QUEUE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(QUEUE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}
export function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}
export const isOnline = () => navigator.onLine;

function saveQueue(items: OfflineLead[]) {
  write(QUEUE_KEY, items);
  window.dispatchEvent(new Event(QUEUE_EVENT));
}

export function enqueueLead(item: Omit<OfflineLead, 'state' | 'savedAt'>): void {
  saveQueue([...loadQueue(), { ...item, state: 'pending', savedAt: new Date().toISOString() }]);
}

export function removeLead(ref: string): void {
  saveQueue(loadQueue().filter((i) => i.ref !== ref));
}

export function retryLead(ref: string): void {
  saveQueue(loadQueue().map((i) => (i.ref === ref ? { ...i, state: 'pending' as const, message: undefined } : i)));
}

/** Pending items for this account (others' items on a shared phone are left alone). */
export const pendingFor = (userId: string | null | undefined) => loadQueue().filter((i) => i.state === 'pending' && (!userId || i.ownerId === userId));

let running: Promise<number> | null = null;

/**
 * Sends every pending lead of the signed-in account. Returns how many were sent.
 * A network failure leaves the lead pending for next time; a refusal (e.g. not in a
 * team) marks it so the person can see why, retry, or delete it.
 */
export function syncOfflineLeads(supabase: SupabaseClient): Promise<number> {
  if (running) return running;
  running = sendPending(supabase).finally(() => {
    running = null;
  });
  return running;
}

const KEEP_DONE_MS = 7 * 86_400_000;

async function sendPending(supabase: SupabaseClient): Promise<number> {
  // Sent items stay visible for a week, then are tidied away.
  const now = Date.now();
  const queue = loadQueue();
  const kept = queue.filter((i) => i.state === 'pending' || i.state === 'error' || now - new Date(i.savedAt).getTime() < KEEP_DONE_MS);
  if (kept.length !== queue.length) saveQueue(kept);

  if (!navigator.onLine) return 0;
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return 0;
  let sent = 0;
  for (const item of pendingFor(userId)) {
    const { data: r, error } = await supabase.rpc('add_lead_from_device', {
      p_client_ref: item.ref,
      p_lead: item.lead,
      p_assign_to_me: item.assignToMe,
    });
    // Re-read: the person may have deleted the item meanwhile, or another tab changed it.
    const queue = loadQueue();
    const at = queue.findIndex((i) => i.ref === item.ref);
    if (at < 0) continue;
    if (error) {
      // No code = the request never reached the database (offline, timeout); PGRST3xx = login
      // expired. Either way the lead is fine: try again later.
      if (!error.code || error.code.startsWith('PGRST3') || !navigator.onLine) break;
      queue[at] = { ...queue[at]!, state: 'error', message: error.message };
    } else {
      const res = r as { id?: string; lead_code?: string; duplicate?: boolean; lead_id?: string };
      queue[at] = res.duplicate
        ? { ...queue[at]!, state: 'duplicate', leadId: res.lead_id, leadCode: res.lead_code, message: undefined }
        : { ...queue[at]!, state: 'synced', leadId: res.id, leadCode: res.lead_code, message: undefined };
      sent += 1;
    }
    saveQueue(queue);
  }
  return sent;
}
