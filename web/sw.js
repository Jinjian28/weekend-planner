/* Service worker: app-shell cache + push notifications */
const CACHE = 'wk-__BUILD__';
const SHELL = ['/', '/app.js?v=__BUILD__', '/app.css?v=__BUILD__', '/manifest.webmanifest?v=__BUILD__', '/icon-192.png?v=__BUILD__', '/apple-touch-icon.png?v=__BUILD__'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // network first, fall back to cache (offline)
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && (req.mode === 'navigate' || SHELL.includes(url.pathname + url.search))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)).catch(() => {});
      }
      return res;
    } catch (e) {
      const cached = await caches.match(req.mode === 'navigate' ? '/' : req);
      if (cached) return cached;
      throw e;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: '周末去哪儿', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || '周末去哪儿';
  const options = {
    body: data.body || '有新消息',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };
  event.waitUntil((async () => {
    let shown = true, err = '';
    try { await self.registration.showNotification(title, options); } catch (e) { shown = false; err = String(e && e.message || e); }
    try { if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(1); } catch (e) { /* ignore */ }
    // tell any open page (used by the in-app push self-check)
    try {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) c.postMessage({ type: 'push-received', title, shown, err, check: data.check || '' });
    } catch (e) { /* ignore */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        try { await c.focus(); } catch (e) { /* ignore */ }
        c.postMessage({ type: 'open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
