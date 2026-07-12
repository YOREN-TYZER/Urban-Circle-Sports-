// Urban Circle Sports — Service Worker
//
// Strategy: network-first for everything in this app.
// This project gets updated frequently, so we deliberately do NOT do a
// classic "cache-first" PWA setup — that would risk showing people an old,
// stale version of the app after every update (exactly the kind of bug
// this project has already run into with browser caching). Instead:
//   - Online: always fetch fresh from the network (cache is just a backup).
//   - Offline: fall back to whatever was last cached, so the app still
//     opens instead of showing a browser error page.
//
// Supabase API requests are never intercepted here — they always go
// straight to the network, since that data is live and shouldn't be
// cached at all.

const CACHE_NAME = 'uc-sports-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './script.js',
  './style.css',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept Supabase (or any cross-origin) requests — those must
  // always hit the network live.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((networkResp) => {
        const copy = networkResp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return networkResp;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
