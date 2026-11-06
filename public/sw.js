const CACHE = 'orbit-hill-online-v2';
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith('orbit-hill-') && key !== CACHE)
    .map((key) => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === '/health') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Online play needs the current client and server protocol after deployments.
      const response = await fetch(event.request, { cache: 'no-cache' });
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      throw error;
    }
  })());
});
