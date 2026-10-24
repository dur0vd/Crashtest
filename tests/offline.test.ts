import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function worker(failInstall = false) {
  const events = new Map<string, (event: Record<string, unknown>) => void>();
  const stores = new Map<string, Map<string, Response>>();
  let networkCalls = 0;
  let online = true;
  let skipped = false;
  let claimed = false;
  const key = (input: string | { url: string }) => new URL(typeof input === 'string' ? input : input.url, 'https://example.test/Crashtest/').href;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async addAll(paths: string[]) {
          if (failInstall) throw new Error('Сеть оборвалась');
          paths.forEach(path => store.set(key(path), new Response(path)));
        },
        async match(request: string | { url: string }) { return store.get(key(request))?.clone(); },
        async put(request: string | { url: string }, response: Response) { store.set(key(request), response); },
      };
    },
  };
  const source = readFileSync('public/sw.js', 'utf8')
    .replace('__CACHE_VERSION__', 'v2')
    .replace('/* __PRECACHE_URLS__ */', JSON.stringify(['./index.html', './assets/a.js', './signs/1.png']));
  runInNewContext(source, { URL, Response, caches,
    fetch: async () => { networkCalls++; if (!online) throw new Error('Офлайн'); return new Response('сеть'); },
    self: {
      registration: { scope: 'https://example.test/Crashtest/' },
      addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => events.set(name, handler),
      skipWaiting: async () => { skipped = true; }, clients: { claim: async () => { claimed = true; } },
    },
  });
  const dispatch = async (name: string, extra = {}) => {
    let promise: Promise<unknown> | undefined;
    events.get(name)!({ ...extra, waitUntil: (value: Promise<unknown>) => { promise = value; }, respondWith: (value: Promise<unknown>) => { promise = value; } });
    return promise;
  };
  return { dispatch, stores, offline: () => { online = false; }, calls: () => networkCalls, skipped: () => skipped, claimed: () => claimed };
}

describe('офлайн-кэш приложения', () => {
  it('предкэширует ресурсы, включая неоткрытую картинку, до активации', async () => {
    const sw = worker();
    await sw.dispatch('install');
    expect(sw.skipped()).toBe(true);
    sw.offline();
    const response = await sw.dispatch('fetch', { request: { url: 'https://example.test/Crashtest/signs/1.png', method: 'GET', mode: 'cors' } }) as Response;
    expect(await response.text()).toBe('./signs/1.png');
    expect(sw.calls()).toBe(0);
  });

  it('не активирует неполную сборку при сбое установки', async () => {
    const sw = worker(true);
    await expect(sw.dispatch('install')).rejects.toThrow();
    expect(sw.skipped()).toBe(false);
  });

  it('при обновлении удаляет старые кэши своей области, сохраняя соседнее приложение', async () => {
    const sw = worker();
    sw.stores.set('crashtest-%2FCrashtest%2F-v1', new Map());
    sw.stores.set('crashtest-%2FOther%2F-v1', new Map());
    await sw.dispatch('install');
    await sw.dispatch('activate');
    expect([...sw.stores.keys()]).toEqual(['crashtest-%2FOther%2F-v1', 'crashtest-%2FCrashtest%2F-v2']);
    expect(sw.claimed()).toBe(true);
  });

  it('навигация сначала идёт в сеть, а офлайн возвращает предкэшированный index', async () => {
    const sw = worker();
    await sw.dispatch('install');
    const request = { url: 'https://example.test/Crashtest/', method: 'GET', mode: 'navigate' };
    sw.offline();
    const response = await sw.dispatch('fetch', { request }) as Response;
    expect(await response.text()).toBe('./index.html');
    expect(sw.calls()).toBe(1);
  });

  it('не перехватывает ресурсы другого проекта на том же хосте', async () => {
    const sw = worker();
    expect(await sw.dispatch('fetch', { request: { url: 'https://example.test/Other/', method: 'GET', mode: 'navigate' } })).toBeUndefined();
    expect(sw.calls()).toBe(0);
  });
});
