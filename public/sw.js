// Service worker: lets the app shell start offline. Data sync is handled by the app itself
// (src/store.js); Supabase requests are cross-origin and always go to the network.
const CACHE = 'kalika-track-v6'
const SHELL = ['./', './manifest.json', './icons/icon-192.png', './icons/apple-touch-icon.png']

self.addEventListener('install', (event) => {
  // Precache the shell including the hashed JS/CSS that index.html references, so the very
  // first offline start works, not just the ones after a second online visit.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(SHELL)
      const html = await (await cache.match('./')).text()
      const assets = [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((match) => match[1])
      await cache.addAll(assets)
    })().catch((error) => console.warn('kalika-track sw: precache incomplete', error)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  // Hashed build assets never change, so cache-first is safe.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetchAndCache(request)))
    return
  }

  // Page loads (also with "?code=…" after login) fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchAndCache(new Request('./', { credentials: 'same-origin' })).catch(() => caches.match('./')),
    )
    return
  }

  // Everything else (manifest, icons): network-first so deployments show up immediately.
  event.respondWith(fetchAndCache(request).catch(() => caches.match(request)))
})

async function fetchAndCache(request) {
  const response = await fetch(request)
  if (response.ok) {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy))
  }
  return response
}
