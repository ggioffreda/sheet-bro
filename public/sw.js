/*
 * sheet-bro service worker.
 *
 * This file is hand-written and copied verbatim by Vite from public/ into
 * dist/sw.js. After the Vite build, scripts/stamp-sw.mjs rewrites the two
 * placeholder tokens below with the real asset manifest and a content hash
 * derived from that manifest. No runtime manifest fetch, no importScripts,
 * no third-party code.
 *
 * Behaviour:
 *   - Precache: index.html + every file in ASSET_MANIFEST that isn't
 *     explicitly runtime-only (currently: sql-wasm WASM).
 *   - Navigations: network-first, fall back to the cached index.html when
 *     offline. Synthesise a new Response with defence-in-depth security
 *     headers added. (Authoritative headers must still come from the
 *     server; these are a safety net for hosts that cannot set them.)
 *   - Same-origin GETs for files in ASSET_MANIFEST: cache-first.
 *   - sql-wasm*.wasm: runtime cache on first successful fetch so users
 *     who never touch SQL pay no download.
 *   - Anything else (including cross-origin and non-GET): pass through
 *     untouched; never cached.
 *
 * Update flow: no skipWaiting() on install. A new SW stays in `waiting`
 * until all tabs close OR a client posts {type:'SKIP_WAITING'}. The app's
 * "update available" toast is the only code path that sends that message.
 */

const CACHE_VERSION = '__CACHE_VERSION__'
const ASSET_MANIFEST = __ASSET_MANIFEST__
const PRECACHE = `sheet-bro-precache-${CACHE_VERSION}`
const RUNTIME = `sheet-bro-runtime-${CACHE_VERSION}`

// Matches both the URL pathname form ('/sheet-bro/assets/sql-wasm.wasm') at
// runtime and the bare manifest-entry form ('assets/sql-wasm.wasm') at install.
const WASM_PATTERN = /(^|\/)assets\/sql-wasm[^/]*\.wasm$/

const ORIGIN = self.location.origin
// Derived from the registration scope so the same SW works under any
// deployment base (root '/', or a subpath like '/sheet-bro/' on GitHub
// Pages). ASSET_MANIFEST entries are stamped as base-relative paths.
const BASE = new URL(self.registration.scope).pathname
const INDEX_PATH = `${BASE}index.html`

const EXTRA_NAV_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'interest-cohort=(), geolocation=(), camera=(), microphone=()',
}

function isPrecacheable(url) {
  if (url.origin !== ORIGIN) return false
  if (WASM_PATTERN.test(url.pathname)) return false
  if (!url.pathname.startsWith(BASE)) return false
  return ASSET_MANIFEST.includes(url.pathname.slice(BASE.length))
}

function isRuntimeCacheable(url) {
  return url.origin === ORIGIN && WASM_PATTERN.test(url.pathname)
}

function isNavigationRequest(req) {
  return req.mode === 'navigate' || (req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html'))
}

function withExtraHeaders(response) {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(EXTRA_NAV_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE)
    await cache.addAll(ASSET_MANIFEST.filter((p) => !WASM_PATTERN.test(p)))
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(
      keys
        .filter((k) => k !== PRECACHE && k !== RUNTIME)
        .map((k) => caches.delete(k)),
    )
  })())
})

self.addEventListener('message', (event) => {
  // Only accept same-origin clients, and only the one documented command.
  // Verify the source via clients.matchAll — the bare `source.url` check is
  // trivial to forge from a cross-origin realm by spoofing the postMessage
  // payload; matching by client id ties the message to a real live client
  // tracked by this SW.
  if (!event.source) return
  const sourceId = event.source.id
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ includeUncontrolled: true })
    if (!list.some((c) => c.id === sourceId && c.url.startsWith(ORIGIN + '/'))) return
    if (event.data && event.data.type === 'SKIP_WAITING') {
      self.skipWaiting()
    }
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }

  if (url.origin !== ORIGIN) return

  if (isNavigationRequest(req)) {
    event.respondWith((async () => {
      try {
        const net = await fetch(req)
        if (net && net.ok && net.type === 'basic') {
          const ct = net.headers.get('content-type') || ''
          if (ct.startsWith('text/html')) {
            const cache = await caches.open(PRECACHE)
            cache.put(INDEX_PATH, net.clone()).catch(() => {})
          }
          return withExtraHeaders(net)
        }
        return net
      } catch {
        const cache = await caches.open(PRECACHE)
        const cached = await cache.match(INDEX_PATH)
        if (cached) return withExtraHeaders(cached)
        return new Response('offline', { status: 503, statusText: 'offline' })
      }
    })())
    return
  }

  if (isPrecacheable(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(PRECACHE)
      const hit = await cache.match(req)
      if (hit) return hit
      const net = await fetch(req)
      if (net && net.ok && net.type === 'basic') {
        cache.put(req, net.clone()).catch(() => {})
      }
      return net
    })())
    return
  }

  if (isRuntimeCacheable(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME)
      const hit = await cache.match(req)
      if (hit) return hit
      const net = await fetch(req)
      if (net && net.ok && net.type === 'basic') {
        cache.put(req, net.clone()).catch(() => {})
      }
      return net
    })())
    return
  }
})
