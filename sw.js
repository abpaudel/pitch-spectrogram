// Service worker for offline use. Network first, so an online visit
// always gets the latest files; the cache is only the fallback. Every
// successful response for a file in FILES refreshes its cached copy, and
// activation drops cached entries no longer listed in FILES.

const CACHE = 'pitch-spectrogram';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/capture-worklet.js',
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
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok && URLS.has(req.url)) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
