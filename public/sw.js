// Простой офлайн-кэш: приложение целиком работает без сети.
// Имя кэша содержит версию сборки: tools/stamp-sw.mjs подставляет её в dist/sw.js после vite build,
// поэтому после обновления старый кэш удаляется и пользователи получают новые файлы.
const CACHE = 'crashtest-__APP_VERSION__';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest', './icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
