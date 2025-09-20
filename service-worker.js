const CACHE_NAME = 'edumix-cache-v1.2.5';
// Mantén el shell mínimo y coherente: evita duplicados y claves ambiguas
const APP_SHELL = [
  './index.html',
  './styles.css',
  // Solo la versión actual usada por index.html
  './app.js?v=1.2.5',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      // Activación inmediata de nuevas versiones del SW
      .then(() => self.skipWaiting())
      .catch(() => {
        // Si algo falla al precachear, no bloquees la instalación por completo
        // (se podrá rellenar la caché bajo demanda en los fetch)
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  const { request } = event;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // Guarda la última index.html válida para uso offline
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put('./index.html', copy).catch(() => {});
          });
        }
        return response;
      } catch (e) {
        const cached = await caches.match('./index.html');
        if (cached) return cached;
        // Último recurso: evita pantalla en blanco con una respuesta simple
        return new Response('<!doctype html><title>Offline</title><h1>Sin conexión</h1><p>Vuelve a intentarlo.</p>', {
          headers: { 'Content-Type': 'text/html; charset=UTF-8' },
          status: 200,
        });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) {
    // No controlar peticiones externas: deja que el navegador gestione
    return;
  }

  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => {
          if (request.destination === 'document') {
            return caches.match('./index.html');
          }
          return caches.match(request).then(match => match || new Response('', { status: 503, statusText: 'Offline' }));
        });
    })
  );
});

// Permite que el cliente solicite activar la nueva versión cuando haya un SW en espera
self.addEventListener('message', event => {
  try {
    if (event && event.data && event.data.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
  } catch {}
});
