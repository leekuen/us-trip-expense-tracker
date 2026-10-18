const CACHE_NAME = 'us-expense-shell-v7';
const SHELL_FILES = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache.addAll() uses a plain fetch, which GitHub Pages' Cache-Control:
      // max-age=600 on these files can serve stale from the browser's own
      // HTTP cache even when this install is clearly meant to grab the
      // latest version. { cache: 'reload' } forces each request to bypass
      // that and hit the network.
      Promise.all(SHELL_FILES.map((url) => fetch(url, { cache: 'reload' }).then((resp) => cache.put(url, resp))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only intercept same-origin GET requests for the app shell. Apps Script sync
// calls are cross-origin POSTs and must always hit the network untouched.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
