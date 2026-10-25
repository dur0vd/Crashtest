import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { offlinePlugin } from '../tools/offline-plugin';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function worker(failInstall = false, version = 'v2', stores = new Map<string, Map<string, Response>>(), staleHttpCache = false) {
  const events = new Map<string, (event: Record<string, unknown>) => void>();
  const precacheModes: string[] = [];
  let networkCalls = 0;
  let networkResponse = () => new Response('сеть');
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
        async addAll(paths: (string | Request)[]) {
          if (failInstall) throw new Error('Сеть оборвалась');
          paths.forEach(input => {
            const mode = typeof input === 'string' ? 'default' : input.cache;
            precacheModes.push(mode);
            const path = typeof input === 'string' ? input : './' + new URL(input.url).pathname.slice('/Crashtest/'.length);
            const body = staleHttpCache && path === './index.html' && mode !== 'reload' ? '<script src="assets/stale.js"></script>' : path;
            store.set(key(input), new Response(body));
          });
        },
        async match(request: string | { url: string }) { return store.get(key(request))?.clone(); },
        async put(request: string | { url: string }, response: Response) { store.set(key(request), response); },
      };
    },
  };
  const source = readFileSync('public/sw.js', 'utf8')
    .replace('__CACHE_VERSION__', version)
    .replace('/* __PRECACHE_URLS__ */', JSON.stringify(['./index.html', './assets/a.js', './signs/1.png']));
  runInNewContext(source, { URL, Request, Response, caches,
    fetch: async () => { networkCalls++; if (!online) throw new Error('Офлайн'); return networkResponse(); },
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
  return { dispatch, stores, precacheModes, respond: (fn: () => Response) => { networkResponse = fn; }, offline: () => { online = false; }, calls: () => networkCalls, skipped: () => skipped, claimed: () => claimed };
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

  it('после незавершённого обновления офлайн использует целиком установленную сборку', async () => {
    const active = worker(false, 'v1');
    await active.dispatch('install');
    active.respond(() => new Response('<script src="assets/new.js"></script>'));
    const request = { url: 'https://example.test/Crashtest/', method: 'GET', mode: 'navigate' };
    const onlinePage = await active.dispatch('fetch', { request }) as Response;
    expect(await onlinePage.text()).toContain('new.js');
    const update = worker(true, 'v2', active.stores);
    await expect(update.dispatch('install')).rejects.toThrow();
    expect(update.skipped()).toBe(false);
    active.offline();
    const offlinePage = await active.dispatch('fetch', { request }) as Response;
    expect(await offlinePage.text()).toBe('./index.html');
    const script = await active.dispatch('fetch', { request: { url: 'https://example.test/Crashtest/assets/a.js', method: 'GET', mode: 'cors' } }) as Response;
    expect(await script.text()).toBe('./assets/a.js');
  });

  it('при HTTP-ошибке навигации открывает установленный index', async () => {
    const sw = worker();
    await sw.dispatch('install');
    sw.respond(() => new Response('Сервис недоступен', { status: 503 }));
    const response = await sw.dispatch('fetch', { request: { url: 'https://example.test/Crashtest/', method: 'GET', mode: 'navigate' } }) as Response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('./index.html');
  });

  it('при установке обходит старую HTML в HTTP-кэше для всех ресурсов снимка', async () => {
    const sw = worker(false, 'v2', new Map(), true);
    await sw.dispatch('install');
    sw.offline();
    const response = await sw.dispatch('fetch', { request: { url: 'https://example.test/Crashtest/', method: 'GET', mode: 'navigate' } }) as Response;
    expect(await response.text()).toBe('./index.html');
    expect(sw.precacheModes).toEqual(['reload', 'reload', 'reload']);
  });

  it('меняет версию кэша при изменении только алгоритма worker и включает public в список', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'crashtest-offline-build-'));
    const source = readFileSync('public/sw.js', 'utf8');
    try {
      mkdirSync(join(directory, 'public', 'signs'), { recursive: true });
      writeFileSync(join(directory, 'index.html'), '<!doctype html><html lang="ru"><body>Тест</body></html>');
      writeFileSync(join(directory, 'public', 'signs', 'unopened.png'), 'неоткрытая картинка');
      const generate = async (template: string) => {
        writeFileSync(join(directory, 'public', 'sw.js'), template);
        await build({ root: directory, base: './', configFile: false, logLevel: 'silent', plugins: [offlinePlugin()], build: { outDir: 'dist' } });
        return readFileSync(join(directory, 'dist', 'sw.js'), 'utf8');
      };
      const first = await generate(source);
      const second = await generate(source + '\n// Уточнён алгоритм обновления.\n');
      const version = (text: string) => text.match(/const VERSION = '([^']+)'/)![1];
      expect(first).toContain('"./index.html"');
      expect(first).toContain('"./signs/unopened.png"');
      expect(first).not.toContain('"./sw.js"');
      expect(version(second)).not.toBe(version(first));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('не перехватывает ресурсы другого проекта на том же хосте', async () => {
    const sw = worker();
    expect(await sw.dispatch('fetch', { request: { url: 'https://example.test/Other/', method: 'GET', mode: 'navigate' } })).toBeUndefined();
    expect(sw.calls()).toBe(0);
  });
});
