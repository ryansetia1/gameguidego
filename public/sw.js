// @ts-nocheck -- runs in ServiceWorkerGlobalScope, not the app's Window scope.
// Minimal service worker: installable, network-first runtime cache, plus a
// one-page offline shell ("/") so saved answers (device copy) open offline.
// Any page navigation that fails offline falls back to the cached shell.
// ponytail: the shell's JS chunks are cached at runtime on the first online
// visit, not precached; a first-ever visit while offline still fails. Upgrade
// path: a versioned precache list from the build manifest.
const CACHE = "gg-runtime-v2";
const SHELL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Evict stale bundles: drop every cache that isn't the current one, so a
  // deploy can't be masked by a previously-cached JS chunk.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches
          .open(CACHE)
          .then((cache) => cache.put(request, copy))
          .catch(() => {});
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then((hit) => hit || (request.mode === "navigate" ? caches.match(SHELL) : undefined)),
      ),
  );
});
