import { describe, expect, it } from 'vitest';
import { Cloud, CloudError, type CloudSession } from '../src/cloud';
import { PRESETS } from '../src/presets';

function setup(handler: (method: string, path: string, body: any) => { status?: number; json: unknown }) {
  let session: CloudSession | null = { token: 't'.repeat(30), email: 'a@b.ru' };
  const calls: string[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.test', '');
    calls.push(`${init.method} ${path}`);
    const r = handler(init.method!, path, init.body ? JSON.parse(init.body as string) : undefined);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const cloud = new Cloud({ fetch: fetchStub, baseUrl: 'https://api.test', load: () => session, store: s => { session = s; } });
  return { cloud, calls, get session() { return session; } };
}

describe('облачный клиент', () => {
  it('первое сохранение — POST, дальнейшие — PUT с baseUpdatedAt', async () => {
    const bodies: any[] = [];
    const t = setup((m, _p, b) => {
      bodies.push(b);
      return m === 'POST' ? { status: 201, json: { id: 'i'.repeat(36), updatedAt: 10 } } : { json: { updatedAt: 11 } };
    });
    const scene = PRESETS[0].build();
    await t.cloud.save(scene);
    await t.cloud.save(scene);
    expect(t.calls[0]).toBe('POST /api/scenes');
    expect(t.calls[1]).toMatch(/^PUT \/api\/scenes\//);
    expect(bodies[1].baseUpdatedAt).toBe(10);
    expect(t.session?.updatedAt).toBe(11);
  });

  it('конфликт отдаёт серверную версию', async () => {
    const remote = PRESETS[1].build();
    const t = setup((m) => m === 'PUT' ? { status: 409, json: { error: 'x', updatedAt: 99, scene: remote } } : { status: 201, json: { id: 'i'.repeat(36), updatedAt: 1 } });
    await t.cloud.save(PRESETS[0].build());
    const err = await t.cloud.save(PRESETS[0].build()).catch(e => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.status).toBe(409);
    expect(err.remote.updatedAt).toBe(99);
    expect(err.remote.scene.name).toBe(remote.name);
  });

  it('401 сбрасывает сессию, обрыв сети даёт понятную ошибку', async () => {
    const t = setup(() => ({ status: 401, json: { error: 'Нужен вход' } }));
    await expect(t.cloud.list()).rejects.toMatchObject({ status: 401 });
    expect(t.session).toBeNull();
    const offline = new Cloud({ fetch: (async () => { throw new TypeError('x'); }) as unknown as typeof fetch, baseUrl: '', load: () => ({ token: 't'.repeat(30), email: 'a@b.ru' }), store: () => {} });
    await expect(offline.list()).rejects.toMatchObject({ status: 0 });
  });

  it('вход сохраняет токен, выход стирает', async () => {
    const t = setup((_m, p) => ({ json: p.endsWith('verify') ? { token: 'z'.repeat(30), email: 'a@b.ru' } : { ok: true } }));
    await t.cloud.verify('a@b.ru', '123456', true);
    expect(t.session?.token).toBe('z'.repeat(30));
    await t.cloud.logout();
    expect(t.session).toBeNull();
  });
});
