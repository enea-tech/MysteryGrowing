// GROW 420 — Service Worker v6
// Strategie:
//  • pagina (navigate)   → network-first (timeout 5s) con fallback su cache: gli aggiornamenti arrivano
//                          subito, ma l'app si apre anche offline
//  • asset same-origin / CDN / font → stale-while-revalidate: risposta istantanea dalla cache,
//                          aggiornamento in background
//  • Supabase / richieste non-GET → mai toccate (niente dati sensibili in cache)
const CACHE_NAME = 'grow420-v6';
const MAX_RUNTIME_ENTRIES = 160;

const PHASE_ICONS = ['01_Setup', '02_Germinazione', '03_Seedling', '04_Vegetativa', '05_Pre-Fioritura',
                     '06_Fioritura', '07_Flushing', '08_Raccolta', '09_Essiccazione', '10_Curing'];

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/logo.jpg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/stage0.png', './assets/stage1.png', './assets/stage2.png',
  './assets/stage3.png', './assets/stage4.png', './assets/stage5.png',
  './assets/bud-pixel-1.png', './assets/bud-pixel-2.png', './assets/bud-pixel-3.png',
  ...PHASE_ICONS.map(n => './assets/' + n + '.png'),
  'https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Permanent+Marker&family=Orbitron:wght@400;700;900&family=Inter:wght@300;400;600;800&display=swap'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Install: precache "shell". Per-asset (allSettled): se un file manca o la rete balbetta, gli altri
// vengono comunque salvati e l'installazione non fallisce (cache.addAll() è atomico).
// Path RELATIVI: funzionano anche su GitHub Pages in sottocartella (/mysteryOFgrowing/).
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(new Request(url, { cache: 'reload' })).catch(err => console.warn('[SW] precache fallita:', url, err && err.message))
        )
      )
    )
  );
});

// Activate: elimina le vecchie cache e prendi il controllo
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('grow420-') && k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) {
    // elimina i più vecchi, ma mai gli asset di base
    const base = new Set(STATIC_ASSETS.map(u => new URL(u, self.registration.scope).href));
    const removable = keys.filter(k => !base.has(k.url));
    await Promise.all(removable.slice(0, keys.length - max).map(k => cache.delete(k)));
  }
}

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE_NAME);
  const net = fetch(request);
  try {
    const res = await Promise.race([
      net,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    if (res && res.ok) {
      cache.put('./index.html', res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = (await cache.match(request, { ignoreSearch: true })) ||
                   (await cache.match('./index.html')) ||
                   (await cache.match('./'));
    if (cached) return cached;
    try { return await net; } catch (e) {
      return new Response('<h1>Offline</h1><p>Apri l\'app una volta con la connessione attiva per usarla offline.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const update = fetch(request).then(res => {
    // clone SUBITO e in modo sincrono: dopo il return il body sarebbe già consumato
    if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
      const copy = res.clone();
      cache.put(request, copy).then(() => trimCache(cache, MAX_RUNTIME_ENTRIES)).catch(() => {});
    }
    return res;
  }).catch(() => null);
  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  const res = await update;
  return res || new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.hostname.endsWith('supabase.co')) return;               // dati utente: solo rete
  if (request.headers.has('range')) return;                        // audio/video: lascia fare al browser

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});

// Background Sync: promemoria e log
self.addEventListener('sync', event => {
  if (event.tag === 'grow-sync') event.waitUntil(syncGrowData());
});
async function syncGrowData() {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage({ type: 'SYNC_REQUIRED' }));
}

// Push notifications
self.addEventListener('push', event => {
  let data = { title: 'GROW 420', body: 'Promemoria grow' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) {
    try { data.body = event.data.text(); } catch (_) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'assets/icon-192.png',
      badge: 'assets/icon-72.png',
      tag: data.tag || 'grow-reminder',
      requireInteraction: true,
      data: { url: data.url || './index.html#reminders' }
    })
  );
});

// Tap sulla notifica: porta in primo piano l'app (o aprila)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './index.html#reminders';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
