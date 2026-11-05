// Minimal service worker: makes the app installable and lets the shell start offline.
// Only same-origin GETs are cached; Supabase requests always go to the network.
const CACHE = 'kalika-track-v5'

self.addEventListener('install', () => self.skipWaiting())

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
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request)),
    )
    return
  }

  // Everything else (index.html, manifest, icons): network-first so deployments show up immediately.
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
