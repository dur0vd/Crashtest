// Список ресурсов и версия автоматически подставляются после сборки Vite.
const VERSION = '__CACHE_VERSION__';
const PRECACHE = [/* __PRECACHE_URLS__ */].flat();
const SCOPE = new URL(self.registration.scope);
const PREFIX = `crashtest-${encodeURIComponent(SCOPE.pathname)}-`;
const CACHE = PREFIX + VERSION;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // HTTP-кэш не должен подмешивать старый index в новый снимок ресурсов.
    await cache.addAll(PRECACHE.map(path => new Request(new URL(path, SCOPE).href, { cache: 'reload' })));
    // Новая версия активируется лишь после успешной загрузки ВСЕХ ресурсов.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE && (key.startsWith(PREFIX) || /^crashtest-v\d+$/.test(key))).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const navigation = event.request.mode === 'navigate' || url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (navigation) {
      try {
        const response = await fetch(event.request);
        // Навигация не меняет установленный снимок: новая HTML может ссылаться
        // на чанки версии, чей предкэш ещё не завершён.
        if (response.ok) return response;
      } catch {
        // Сеть недоступна: ниже используем целиком установленную сборку.
      }
      return (await cache.match(event.request)) || (await cache.match(new URL('index.html', SCOPE).href)) || Response.error();
    }
    return (await cache.match(event.request)) || fetch(event.request);
  })());
});
