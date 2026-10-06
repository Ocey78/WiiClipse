const CACHE_PREFIX = `wiiclipse:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v4`;
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './src/bootstrap.js', './src/app.js', './src/capabilities.js', './src/game-file.js', './src/input-state.js',
  './src/dolphin-worker-client.js', './src/dolphin-worker.js', './src/dolphin-wasm-adapter.js',
  './src/webgl-renderer.js', './src/audio-sink.js', './src/audio-ring.js', './src/audio-worklet.js',
  './src/frame-scheduler.js'
];
self.addEventListener('install', (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(ASSETS);
  await self.skipWaiting();
})()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));

function isolated(response) {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  // Core binaries can be large: let HTTP caching handle them rather than duplicating them in Cache Storage.
  const cacheable = !new URL(request.url).pathname.includes('/core/');
  const responsePromise = (async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (cacheable && response.ok) await cache.put(request, response.clone());
      return isolated(response);
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return isolated(cached);
      throw error;
    }
  })();
  event.respondWith(responsePromise);
});
