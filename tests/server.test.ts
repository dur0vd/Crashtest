import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { openDb } from '../server/db';
import { PRESETS } from '../src/presets';
import legacy from './fixtures/legacy-minimal.json';

let clock = 1_000_000;
const sent: Record<string, string> = {};
const servers: { close(): void }[] = [];

async function start() {
  const server = createApp({ db: openDb(':memory:'), mailer: { sendCode: async (e, c) => { sent[e] = c; } }, now: () => clock });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as any };
  };
  const login = async (email: string) => {
    await call('POST', '/api/auth/request', { email });
    return (await call('POST', '/api/auth/verify', { email, code: sent[email] })).json.token as string;
  };
  return { call, login };
}

afterEach(() => { for (const s of servers.splice(0)) s.close(); clock += 3600_000; });

describe('сервер: вход', () => {
  it('код → токен; неверный код и повторная отправка отклоняются', async () => {
    const { call } = await start();
    expect((await call('POST', '/api/auth/request', { email: 'не почта' })).status).toBe(400);
    expect((await call('POST', '/api/auth/request', { email: 'a@b.ru' })).status).toBe(200);
    expect((await call('POST', '/api/auth/request', { email: 'a@b.ru' })).status).toBe(429);
    expect((await call('POST', '/api/auth/verify', { email: 'a@b.ru', code: '000000x' })).status).toBe(400);
    const ok = await call('POST', '/api/auth/verify', { email: 'a@b.ru', code: sent['a@b.ru'] });
    expect(ok.status).toBe(200);
    expect(ok.json.token).toBeTruthy();
    expect((await call('POST', '/api/auth/verify', { email: 'a@b.ru', code: sent['a@b.ru'] })).status).toBe(400);
  });

  it('просроченный код и блокировка после 5 ошибок', async () => {
    const { call } = await start();
    await call('POST', '/api/auth/request', { email: 'c@d.ru' });
    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/verify', { email: 'c@d.ru', code: 'bad' });
    expect((await call('POST', '/api/auth/verify', { email: 'c@d.ru', code: sent['c@d.ru'] })).status).toBe(400);
  });

  it('без токена сцены недоступны', async () => {
    const { call } = await start();
    expect((await call('GET', '/api/scenes')).status).toBe(401);
  });
});

describe('сервер: облачные сцены', () => {
  it('создание, список, чтение, обновление, удаление', async () => {
    const { call, login } = await start();
    const t = await login('u@x.ru');
    const preset = PRESETS[0].build();
    const created = await call('POST', '/api/scenes', { scene: preset }, t);
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect((await call('GET', '/api/scenes', undefined, t)).json.scenes).toHaveLength(1);
    const got = await call('GET', `/api/scenes/${id}`, undefined, t);
    expect(got.json.scene.name).toBe(preset.name);

    const upd = await call('PUT', `/api/scenes/${id}`, { scene: { ...preset, name: 'Новое имя' }, baseUpdatedAt: created.json.updatedAt }, t);
    expect(upd.status).toBe(200);
    const stale = await call('PUT', `/api/scenes/${id}`, { scene: preset, baseUpdatedAt: created.json.updatedAt }, t);
    expect(stale.status).toBe(409);
    expect(stale.json.scene.name).toBe('Новое имя');

    expect((await call('DELETE', `/api/scenes/${id}`, undefined, t)).status).toBe(200);
    expect((await call('GET', `/api/scenes/${id}`, undefined, t)).status).toBe(404);
  });

  it('чужую сцену не видно, мусор отклоняется, старый формат нормализуется', async () => {
    const { call, login } = await start();
    const a = await login('a@x.ru');
    const b = await login('b@x.ru');
    const id = (await call('POST', '/api/scenes', { scene: legacy }, a)).json.id as string;
    expect((await call('GET', `/api/scenes/${id}`, undefined, b)).status).toBe(404);
    expect((await call('POST', '/api/scenes', { scene: 42 }, a)).status).toBe(400);
    const stored = (await call('GET', `/api/scenes/${id}`, undefined, a)).json.scene;
    expect(Array.isArray(stored.roads)).toBe(true);
  });

  it('удаление аккаунта убирает сцены и сессию', async () => {
    const { call, login } = await start();
    const t = await login('z@x.ru');
    await call('POST', '/api/scenes', { scene: PRESETS[0].build() }, t);
    expect((await call('DELETE', '/api/account', undefined, t)).status).toBe(200);
    expect((await call('GET', '/api/scenes', undefined, t)).status).toBe(401);
  });
});
