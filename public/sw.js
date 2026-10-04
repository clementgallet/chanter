/* Offline shell + cached library. Bump VERSION when shell files change in a way that must not be served stale. */
const VERSION = 'v4';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const SHELL_FILES = [
  './', 'style.css', 'config.js', 'manifest.webmanifest', 'vendor/abcjs-basic-min.js', 'lib/abc.js',
  'js/app.js', 'js/store.js', 'js/player.js', 'js/detect-ui.js', 'js/detect-worker.js', 'js/detector.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-180.png',
];
const BASE = new URL('./', self.registration.scope);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES.map((f) => new URL(f, BASE).href)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const rel = url.pathname.startsWith(BASE.pathname) ? url.pathname.slice(BASE.pathname.length) : url.pathname;

  if (rel.startsWith('api/') || rel.startsWith('data/')) {
    if (rel.endsWith('.abc') && rel.startsWith('api/')) return;
    // library data: freshest copy when online, last known copy when offline
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } })))
    );
    return;
  }

  // app shell: network first (updates apply at once), cached copy when offline
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match(new URL('./', BASE).href) : Response.error())))
  );
});
