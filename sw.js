// Service worker: cache the app shell for fast/offline start. Market data is always fetched live (never cached).
const CACHE = "pocketsignal-v1";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/analysis.js", "js/indicators.js", "js/data.js",
  "manifest.webmanifest", "fonts/Cairo-Regular.ttf", "fonts/Cairo-Bold.ttf", "fonts/Cairo-Black.ttf",
  "icons/icon-192.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;                       // APIs: straight to network
  // network-first so updates arrive immediately; fall back to cache when offline
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
