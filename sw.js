/* Service worker: permite abrir la app sin conexión y guarda los pedazos de mapa ya vistos. */
const VERSION = 'radares-ba-v1.0.0';
const APP = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'lib/leaflet.css', 'lib/leaflet.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'
];
const CACHE_MAPA = 'radares-ba-mapa';
const MAX_MAPA = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== CACHE_MAPA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function recortar(cache) {
  const ks = await cache.keys();
  if (ks.length > MAX_MAPA) await Promise.all(ks.slice(0, ks.length - MAX_MAPA).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Lista de radares: siempre intenta la versión nueva; si no hay red, usa la guardada.
  if (url.origin === location.origin && url.pathname.endsWith('/data/radares.json')) {
    e.respondWith(
      fetch(req).then((r) => {
        const copia = r.clone();
        caches.open(VERSION).then((c) => c.put('data/radares.json', copia));
        return r;
      }).catch(() => caches.match('data/radares.json'))
    );
    return;
  }

  // Pedazos de mapa y tipografías: primero lo guardado.
  if (url.hostname.endsWith('basemaps.cartocdn.com') || url.hostname.endsWith('fonts.gstatic.com') || url.hostname.endsWith('fonts.googleapis.com')) {
    e.respondWith(
      caches.open(CACHE_MAPA).then((c) => c.match(req).then((hit) => hit || fetch(req).then((r) => {
        if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); recortar(c); }
        return r;
      })))
    );
    return;
  }

  // Archivos de la app: responde con lo guardado y actualiza en segundo plano.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.open(VERSION).then((c) => c.match(req).then((hit) => {
        const red = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
        return hit || red;
      }))
    );
  }
});
