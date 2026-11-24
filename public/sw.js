/* global self, caches */
/*
 * Order Desk service worker: caches the APP SHELL ONLY (07-UI-SPEC).
 * - Never caches /api: prices, positions and results must always be live; a cached quote could mislead a trade.
 * - Hashed build assets (/_next/static) are immutable: cache-first.
 * - Page navigations go to the network; if that fails, the offline page explains what's going on.
 */
const SHELL = "od-shell-v1";
const OFFLINE = ["/offline.html", "/offline.css", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(OFFLINE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // live data only, never from a cache

  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.open(SHELL).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
  }
});
