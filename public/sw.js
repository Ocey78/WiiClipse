const CACHE = 'dolphin-web-v2';
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  '../src/app.js', '../src/capabilities.js', '../src/game-file.js', '../src/input-state.js',
  '../src/dolphin-worker-client.js', '../src/dolphin-worker.js', '../src/dolphin-wasm-adapter.js',
  '../src/webgl-renderer.js', '../src/audio-sink.js'
];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && new URL(event.request.url).origin === self.location.origin) {
      caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    }
    return response;
  })));
});
