const WMS365_CACHE = "wms365-mobile-shell-v5";
const CRITICAL_NETWORK_FIRST = new Set([
  "/mobile-bridge.js",
  "/mobile-pick",
  "/mobile-pick.html",
  "/mobile-count",
  "/mobile-count.html",
  "/site.webmanifest",
  "/device-profiles.json"
]);
const SHELL_URLS = [
  "/login",
  "/login.html",
  "/mobile?mode=mobile",
  "/index.html",
  "/mobile-count",
  "/mobile-count.html",
  "/mobile-pick",
  "/mobile-pick.html",
  "/mobile-bridge.js",
  "/site.webmanifest",
  "/marketing-logo.svg",
  "/device-profiles.json",
  "/device-resources",
  "/device-resources.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(WMS365_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== WMS365_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function offlinePage() {
  return new Response(
    "<!doctype html><title>WMS365 Offline</title><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><body style=\"font-family:system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5f6;color:#20303a\"><main style=\"padding:24px;max-width:420px\"><h1 style=\"margin:0 0 8px;font-size:24px\">WMS365 is offline</h1><p style=\"line-height:1.5;color:#657582\">Reconnect and refresh. Any supported mobile actions already queued on this device will sync when the connection returns.</p></main></body>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(WMS365_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/mobile?mode=mobile") || offlinePage()))
    );
    return;
  }

  if (CRITICAL_NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (request.method === "GET" && response.ok) {
            const copy = response.clone();
            caches.open(WMS365_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (request.method === "GET" && response.ok) {
            const copy = response.clone();
            caches.open(WMS365_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
