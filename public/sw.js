// ============================================================
// NexusHome OS — Service Worker (v2.7)
//  · app instalável e abrindo sem rede (o shell fica em cache;
//    dados ao vivo continuam vindo do Supabase quando há conexão)
//  · notificações: push do servidor (notify-alert) e avisos locais
// ============================================================

const VERSION = 'nh-2.17.2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Supabase, CDNs: sempre rede
  if (req.mode === 'navigate') {
    // página: rede primeiro (versão nova após deploy), cache se offline
    event.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put('/index.html', copy));
      return res;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/')) {
    // arquivos com hash: cache primeiro, atualiza em segundo plano
    event.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

function show(data = {}) {
  const sev = data.severity || 'info';
  return self.registration.showNotification(data.title || 'NexusHome', {
    body: data.body || '',
    tag: data.tag || `nh-${sev}`,
    renotify: true,
    requireInteraction: sev === 'critical',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    vibrate: sev === 'critical' ? [300, 120, 300, 120, 300] : [120],
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  event.waitUntil(show(data));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'notify') event.waitUntil(show(event.data.payload));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus();
    return self.clients.openWindow(url);
  })());
});
