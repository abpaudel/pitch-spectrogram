// Service worker for offline use. Stale-while-revalidate: cached files
// are served immediately and refreshed in the background, so updates
// appear on the next visit. Activation drops entries not in FILES.

const CACHE = 'pitch-spectrogram';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/capture-worklet.js',
  'js/demo.js',
  'js/dsp.js',
  'js/view.js',
  'js/worker.js',
  'img/icons/icon.svg',
  'img/icons/icon.png',
  'img/icons/icon-192.png',
  'img/icons/icon-512.png',
  'img/icons/icon-maskable.png',
];
const URLS = new Set(FILES.map((f) => new URL(f, location).href));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.keys().then((reqs) => Promise.all(
      reqs.filter((r) => !URLS.has(r.url)).map((r) => c.delete(r)))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // no-store: a revalidated fetch can return a stale HTTP cache entry.
  const network = fetch(req, { cache: 'no-store' }).then((res) => {
    if (res.ok && URLS.has(req.url)) {
      const copy = res.clone();
      return caches.open(CACHE).then((c) => c.put(req, copy)).then(() => res);
    }
    return res;
  });
  e.waitUntil(network.then(() => {}, () => {}));
  e.respondWith(caches.match(req, { ignoreSearch: true })
    .then((hit) => hit || network)
    .catch(() => (req.mode === 'navigate' ? caches.match('./') : Response.error()))
    .then((res) => res || Response.error()));
});
