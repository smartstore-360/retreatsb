const V = 'dclm-v21', F = ['./', 'index.html', 'app.js', 'config.js', 'style.css', 'manifest.json', 'logo.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(F)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => clients.claim())));
// Network-first (so updates always show), cache fallback (so it works offline). API calls are never intercepted.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
  e.respondWith(fetch(e.request, { signal: ctl.signal, cache: 'no-cache' }).then(r => { clearTimeout(t); if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
