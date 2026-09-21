const CACHE_NAME = 'horax-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Instalación - cachea lo que pueda (si falta un archivo, no se rompe todo)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(ASSETS_TO_CACHE.map(url => cache.add(url)))
    )
  );
  self.skipWaiting();
});

// Activación - borra las cachés viejas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Fetch - RED PRIMERO: siempre trae la versión más nueva de app.js / index.html / css.
// Si no hay internet, usa la copia guardada.
self.addEventListener('fetch', event => {
  const req = event.request;
  // Solo archivos propios: no tocar CDNs (pdf.js, iconos, fuentes) ni pedidos que no sean GET
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(req).then(cached =>
          cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)
        )
      )
  );
});