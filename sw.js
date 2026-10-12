/* Offline-Speicher für die App-Dateien. Rezeptdaten und Fotos verwaltet store.js. */
const SHELL = "rb-shell-v44";
const FILES = ["./", "index.html", "store.js", "jszip.min.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png", "lang.js", "welt.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("rb-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // GitHub-API & CDNs direkt
  // Netz zuerst und immer beim Server nachfragen (damit Updates sofort ankommen), sonst aus dem Speicher
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match("index.html"))));
});
