try { importScripts('./version.js'); } catch {}

const APP_VERSION = self.EDUMIX_VERSION || '1.6.11';
const CACHE_NAME = `edumix-cache-v${APP_VERSION}`;
// Mantén el shell mínimo y coherente: evita diferencias y claves ambiguas
const APP_SHELL = [
  './index.html',
  './styles.css',
  './version.js',
  './app.js',
  './modules/app-dialog.js',
  './modules/playlist-crud.js',
  './modules/track-crud.js',
  './modules/track-utils.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const APP_SHELL_PATHS = new Set(
  APP_SHELL.map(entry => {
    try {
      return new URL(entry, self.location.origin).pathname;
    } catch {
      return entry.replace(/^\./, '');
    }
  })
);

function shouldCacheResponse(response) {
  return Boolean(response && response.ok && (response.type === 'basic' || response.type === 'default'));
}

function isAppShellRequest(requestUrl) {
  if (!requestUrl) return false;
  if (APP_SHELL_PATHS.has(requestUrl.pathname)) return true;
  return requestUrl.pathname === self.location.pathname || requestUrl.pathname === '/';
}

async function updateCache(request, response) {
  if (!shouldCacheResponse(response)) return response;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

async function networkFirstPage(request) {
  try {
    const response = await fetch(request);
    if (shouldCacheResponse(response)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put('./index.html', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('./index.html');
    if (cached) return cached;
    return new Response('<!doctype html><title>Offline</title><h1>Sin conexión</h1><p>Vuelve a intentarlo.</p>', {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      status: 200,
    });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const networkPromise = fetch(request)
    .then(response => updateCache(request, response))
    .catch(() => null);
  if (cached) {
    return cached;
  }
  const networkResponse = await networkPromise;
  return networkResponse || new Response('', { status: 503, statusText: 'Offline' });
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
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
  if (request.headers.has('range')) {
    // No interceptar rangos parciales para evitar romper streams/audio seek.
    return;
  }
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    // No controlar peticiones externas: deja que el navegador gestione
    return;
  }

  if (isAppShellRequest(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(request)
        .then(response => updateCache(request, response))
        .catch(() => {
          if (request.destination === 'document') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 503, statusText: 'Offline' });
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
