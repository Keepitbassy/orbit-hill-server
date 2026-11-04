const CACHE = 'orbit-hill-online-v1';
self.addEventListener('install', (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(['/', '/index.html', '/style.css', '/config.js', '/js/main.js', '/js/net.js']);
  self.skipWaiting();
})()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const response = await fetch(event.request);
    if (response.ok && new URL(event.request.url).origin === location.origin) cache.put(event.request, response.clone());
    return response;
  })());
});
