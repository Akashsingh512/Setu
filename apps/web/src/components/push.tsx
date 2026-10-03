'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from './ui';

const VAPID_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
const DISMISS_KEY = 'push-prompt-dismissed';

type PushState = 'loading' | 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Turns the browser's terse subscribe errors into something a volunteer can act on. */
function explainPushError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError') return 'Notifications are blocked for this site. Allow them in your browser settings, then try again.';
  if ('brave' in navigator) {
    return 'Brave blocks notifications by default. Open brave://settings/privacy, turn on "Use Google services for push messaging", restart Brave and try again.';
  }
  if (name === 'AbortError' || /push service/i.test(e instanceof Error ? e.message : '')) {
    return "Your browser couldn't reach its notification service. A VPN, firewall, ad-blocker or privacy extension is usually the cause - turn it off for a moment and try again, or use Chrome or Edge.";
  }
  return 'Could not turn on notifications on this device. Please try again, or use Chrome or Edge.';
}

async function registration() {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/** Subscribes this browser (prompting only if `prompt`) and stores the subscription for the signed-in user. */
async function subscribe(prompt: boolean): Promise<PushState> {
  if (prompt && Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return result === 'denied' ? 'denied' : 'off';
  }
  if (Notification.permission !== 'granted') return Notification.permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const options = { userVisibleOnly: true, applicationServerKey: base64UrlToBytes(VAPID_KEY) };
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe(options);
    } catch (first) {
      // A stale subscription (e.g. made with another key) blocks a new one: clear it and retry once.
      try {
        await (await reg.pushManager.getSubscription())?.unsubscribe();
        sub = await reg.pushManager.subscribe(options);
      } catch {
        throw new Error(explainPushError(first));
      }
    }
  }
  const { error } = await createClient().rpc('register_push_token', { p_token: JSON.stringify(sub.toJSON()), p_platform: 'web' });
  if (error) throw new Error(error.message);
  return 'on';
}

async function detect(): Promise<PushState> {
  if (!VAPID_KEY || !('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window) || !('Notification' in window)) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted') {
    // Already allowed on this device: make sure it's linked to whoever is signed in now.
    return subscribe(false).catch(() => 'off' as const);
  }
  return 'off';
}

/** Removes this device's subscription (used on sign-out, so the next person doesn't get alerts). */
export async function unsubscribeThisDevice(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // Best effort: the server drops dead subscriptions on the next send anyway.
  }
}

function usePushState() {
  const [state, setState] = useState<PushState>('loading');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void detect().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);
  const enable = async () => {
    setError(null);
    try {
      setState(await subscribe(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn on notifications.');
    }
  };
  return { state, error, enable };
}

const HELP: Partial<Record<PushState, string>> = {
  'ios-install': 'On iPhone: tap the Share button in Safari, choose "Add to Home Screen", then open the CRM from the home-screen icon and turn notifications on there.',
  denied: 'Notifications are blocked for this site. Allow them in your browser or phone settings for this site, then reload the page.',
  unsupported: "This browser can't receive notifications. On Android use Chrome; on iPhone add the CRM to your Home Screen first.",
};

/** Full control, for the Profile page. */
export function PushSettings() {
  const { state, error, enable } = usePushState();
  return (
    <div className="space-y-3 text-sm">
      {state === 'on' ? (
        <p>
          <span className="font-medium text-ok">On for this device.</span> You&apos;ll get an alert when leads are assigned to you, follow-ups are due and programs change.
        </p>
      ) : state === 'off' ? (
        <>
          <p className="text-ink-muted">Get an alert on this phone or computer when a lead is assigned to you or a follow-up is due.</p>
          <Button onClick={enable}>Turn on notifications</Button>
        </>
      ) : state === 'loading' ? (
        <p className="text-ink-muted">Checking…</p>
      ) : (
        <p className="text-ink-muted">{HELP[state]}</p>
      )}
      {error ? <p className="text-danger">{error}</p> : null}
      <p className="text-xs text-ink-muted">Each device is set up separately. Alerts never show lead names or numbers on the lock screen.</p>
    </div>
  );
}

/** A dismissible nudge shown inside the app until notifications are on. Also keeps the device registered. */
export function PushPrompt() {
  const { state, error, enable } = usePushState();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return typeof window !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || (state !== 'off' && state !== 'ios-install')) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm" role="status">
      <p className="min-w-0 flex-1">{state === 'off' ? 'Get a phone alert the moment a lead is assigned to you.' : HELP['ios-install']}</p>
      {state === 'off' ? (
        <Button onClick={enable} className="min-h-9">
          Turn on alerts
        </Button>
      ) : null}
      <button type="button" onClick={dismiss} className="text-ink-muted hover:text-ink">
        Not now
      </button>
      {error ? <p className="w-full text-danger">{error}</p> : null}
    </div>
  );
}
