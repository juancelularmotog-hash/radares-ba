/* Service worker: permite abrir la app sin conexión y guarda los pedazos de mapa ya vistos.
   Con internet siempre usa la versión más nueva de la app; sin internet, la última guardada. */
const VERSION = 'radares-ba-v2.0.11';
const APP = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'lib/leaflet.css', 'lib/leaflet.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'
];
const CACHE_MAPA = 'radares-ba-mapa-v2';
const MAX_MAPA = 3000;
const HOSTS_MAPA = ['tile.openstreetmap.org', 'tile.openstreetmap.fr', 'fonts.gstatic.com', 'fonts.googleapis.com'];

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

  // Mapa y tipografías: lo guardado primero; si no está, se descarga y se guarda.
  if (HOSTS_MAPA.some((h) => url.hostname.endsWith(h))) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE_MAPA);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); recortar(c); }
      return r;
    })());
    return;
  }

  // Archivos de la app y lista de radares: primero internet, y si no hay, lo guardado.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      try {
        const r = await fetch(req, { cache: 'no-store' });
        if (r.ok) c.put(req, r.clone());
        return r;
      } catch (err) {
        const hit = await c.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })());
  }
});
