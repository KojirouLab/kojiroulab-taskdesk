// タスクデスク Service Worker — app-shell caching for offline / installed-app use.
// Bump CACHE_NAME on every deploy (same timestamp pattern as index.html's ?v= query strings)
// so returning clients pick up the new version instead of a stale cached shell.
const CACHE_NAME = "taskdesk-shell-202608201433";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワーク優先: オンラインなら常に最新を取りに行き、キャッシュは
// オフライン時のフォールバックとしてのみ使う(キャッシュ優先だと、デプロイ後も
// 端末側が古いJSを表示し続けてしまう「反映されない」問題の原因になるため)。
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
