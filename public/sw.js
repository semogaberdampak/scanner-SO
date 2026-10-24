// Service worker: menyimpan "cangkang" aplikasi agar cepat terbuka & bisa di-install.
// Data (API Apps Script) TIDAK di-cache, selalu diambil langsung dari server.
const CACHE = 'scanstock-v5';
const ASSETS = [
  './',
  'index.html',
  'config.js',
  'manifest.webmanifest',
  'vendor/html5-qrcode.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API & domain lain: langsung ke jaringan

  // config.js: ambil dari jaringan dulu supaya perubahan (mis. POLL_SECONDS) langsung berlaku
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Stale-while-revalidate: tampil cepat dari cache, lalu perbarui di latar belakang
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
