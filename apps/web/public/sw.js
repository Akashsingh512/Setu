// Service worker: shows push notifications and opens the right page on tap, and keeps
// one page for offline use: /capture ("Add lead"), which contains no CRM data (leads
// typed there are saved on the phone and sent when online). Every other page is never
// cached - CRM data must always be live.

const OFFLINE_CACHE = 'setu-offline-v1';
const OFFLINE_PAGE = '/capture';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== OFFLINE_CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The offline page itself (full page loads only, not Next.js data requests).
  if (url.pathname === OFFLINE_PAGE && !url.searchParams.has('_rsc') && !req.headers.get('RSC')) {
    event.respondWith(offlinePage(req));
    return;
  }
  // Its scripts, styles and fonts: served from the cache when we have them (they never change).
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(caches.open(OFFLINE_CACHE).then(async (cache) => (await cache.match(req)) || fetch(req)));
  }
});

/** Network first (always the latest version when online), the saved copy when offline. */
async function offlinePage(req) {
  const cache = await caches.open(OFFLINE_CACHE);
  try {
    const res = await fetch(req);
    // Only a real page: a redirect to /login (signed out) is never stored.
    if (res.ok && !res.redirected && (res.headers.get('content-type') || '').includes('text/html')) {
      const html = await res.clone().text();
      await cache.put(OFFLINE_PAGE, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
      await keepAssets(cache, html);
    }
    return res;
  } catch {
    const saved = await cache.match(OFFLINE_PAGE);
    return (
      saved ||
      new Response('You are offline. Open Setu once with internet, then "Add lead" will work offline on this phone.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    );
  }
}

// Stops at quotes, spaces, ")" (CSS url()) and backslashes (escaped quotes in inline JSON).
const assetUrls = (text) => [...new Set(text.match(/\/_next\/static\/[^"'\s)\\]+/g) || [])];

/** Stores the files the page uses (and the fonts its styles use), and drops ones from older versions. */
async function keepAssets(cache, html) {
  const urls = assetUrls(html);
  for (const u of urls.filter((u) => u.endsWith('.css'))) {
    try {
      const css = await (await fetch(u)).text();
      urls.push(...assetUrls(css).filter((m) => !urls.includes(m)));
    } catch {
      // Fonts are optional: the page still works with the system font.
    }
  }
  await Promise.all(
    urls.map(async (u) => {
      if (!(await cache.match(u))) await cache.add(u).catch(() => {});
    }),
  );
  const keep = new Set([OFFLINE_PAGE, ...urls].map((u) => new URL(u, self.location.origin).href));
  for (const key of await cache.keys()) if (!keep.has(key.url)) await cache.delete(key);
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Setu', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Setu', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: data.tag,
      data: { url: data.url || '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/notifications', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        return existing.navigate(url);
      }
      return self.clients.openWindow(url);
    })(),
  );
});
