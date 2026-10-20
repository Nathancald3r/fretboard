// Offline support: always try the network first (so updates show up right away),
// and fall back to the last cached copy when offline.
const CACHE = 'fretboard-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // no-cache: revalidate with the server so new HTML never runs with stale JS
      // from the browser's HTTP cache (GitHub Pages sends max-age=600).
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request)) || Response.error();
    }
  })());
});
