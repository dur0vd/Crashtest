import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FREE_MODELS, canRun, markRun, modelKey, verifyCode, type License } from '../src/license';
import keys from '../src/license-keys.json';
import { PRESETS } from '../src/presets';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

function issue(data: object, key = privateKey): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `CT1.${payload}.${signature}`;
}

describe('код активации', () => {
  const data = { plan: 'school', name: 'Автошкола «Старт»', until: '2026-11-30', id: 'abc' };

  it('принимает код, подписанный ключом из списка', async () => {
    const r = await verifyCode(issue(data), [jwk], '2026-10-27');
    expect(r).toEqual({ plan: 'school', name: 'Автошкола «Старт»', until: '2026-11-30', id: 'abc' });
  });
  it('принимает код с пробелами и переносами строк', async () => {
    const code = issue(data);
    expect(typeof await verifyCode(` ${code.slice(0, 40)}\n${code.slice(40)} `, [jwk], '2026-10-27')).toBe('object');
  });
  it('отклоняет изменённые данные', async () => {
    const [, , sig] = issue(data).split('.');
    const forged = Buffer.from(JSON.stringify({ ...data, until: '2099-01-01' })).toString('base64url');
    expect(typeof await verifyCode(`CT1.${forged}.${sig}`, [jwk], '2026-10-27')).toBe('string');
  });
  it('отклоняет код чужого ключа', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(typeof await verifyCode(issue(data, other), [jwk], '2026-10-27')).toBe('string');
  });
  it('отклоняет истёкший код, последний день ещё действует', async () => {
    expect(typeof await verifyCode(issue(data), [jwk], '2026-11-30')).toBe('object');
    expect(await verifyCode(issue(data), [jwk], '2026-12-01')).toMatch(/истёк 30\.11\.2026/);
  });
  it('отклоняет мусор', async () => {
    for (const s of ['', 'abc', 'CT1.a.b', 'CT2.x.y']) expect(typeof await verifyCode(s, [jwk], '2026-10-27')).toBe('string');
  });
  it('в приложении есть хотя бы один открытый ключ и нет закрытых', () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys as JsonWebKey[]) expect(k.d).toBeUndefined();
  });
});

describe('пробный режим', () => {
  const lic: License = { plan: 'personal', name: 'Иван', until: '2026-11-30', id: 'x' };

  it(`разрешает ${FREE_MODELS} разных моделей, повторный запуск бесплатен`, () => {
    let trial = { used: [] as string[] };
    for (let n = 0; n < FREE_MODELS; n++) {
      expect(canRun(trial, `m${n}`, null, '2026-10-27')).toBe(true);
      trial = markRun(trial, `m${n}`);
    }
    expect(canRun(trial, 'new', null, '2026-10-27')).toBe(false);
    expect(canRun(trial, 'm0', null, '2026-10-27')).toBe(true);
    expect(markRun(trial, 'm0').used).toHaveLength(FREE_MODELS);
  });
  it('с действующей подпиской ограничений нет, с истёкшей — снова пробный режим', () => {
    const full = { used: ['a', 'b', 'c', 'd', 'e'] };
    expect(canRun(full, 'new', lic, '2026-11-30')).toBe(true);
    expect(canRun(full, 'new', lic, '2026-12-01')).toBe(false);
  });
  it('перемещение и скорости не меняют модель, новый участник — меняет', () => {
    const s = PRESETS[0].build();
    const key = modelKey(s);
    s.actors[0].x += 10;
    s.actors[0].speed += 20;
    expect(modelKey(s)).toBe(key);
    s.actors.push({ ...s.actors[0], id: 'extra' });
    expect(modelKey(s)).not.toBe(key);
    expect(new Set(PRESETS.map((p) => modelKey(p.build()))).size).toBe(PRESETS.length);
  });
});
