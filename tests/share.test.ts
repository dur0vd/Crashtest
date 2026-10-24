import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { normalizeScene } from '../src/scene';
import { encodeShare, decodeShare, sceneFromHash } from '../src/share';
import { simulate } from '../src/sim';
import { analyze } from '../src/analysis';
import minimal from './fixtures/legacy-minimal.json';
import signs from './fixtures/legacy-signs.json';
import actor from './fixtures/legacy-actor.json';

describe('совместимость сохранений и ссылок', () => {
  for (const preset of PRESETS) it(`ссылка: ${preset.title}`, () => {
    const scene = preset.build();
    expect(decodeShare(encodeShare(scene))).toEqual(normalizeScene(scene));
    expect(sceneFromHash(`#s=${encodeShare(scene)}`)).toEqual(normalizeScene(scene));
  });

  for (const fixture of [minimal, signs, actor]) it(`старое сохранение: ${fixture.name}`, () => {
    const scene = normalizeScene(fixture);
    expect(scene.version).toBe(1);
    expect(scene.markings).toEqual([]);
    expect(() => analyze(scene, simulate(scene))).not.toThrow();
    expect(decodeShare(encodeShare(scene))).toEqual(scene);
  });

  it('сохраняет кириллицу и emoji без мутации исходной сцены', () => {
    const scene = PRESETS[0].build();
    scene.name = 'Ёжик 🚗 у перехода';
    const before = JSON.stringify(scene);
    expect(decodeShare(encodeShare(scene)).name).toBe(scene.name);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('понимает ссылку, закодированную прежней версией', () => {
    expect(decodeShare('eyJuYW1lIjoiT2xkIiwidmVyc2lvbiI6MX0').name).toBe('Old');
  });

  it.each(['', '#', '#s=', '#s=!!!', '#s=a', '#s=bnVsbA', '#s=W10', '#s=7w', '#other=abc'])('повреждённая ссылка %s безопасно отклоняется', hash => {
    expect(sceneFromHash(hash)).toBeNull();
  });

  it('отбрасывает повреждённых участников и геометрию', () => {
    const scene = normalizeScene({ roads: [{ id: 'r1', pts: 'bad' }], actors: [{ id: 'a1', kind: 'vehicle', type: 'unknown', x: 0, y: 0 }, {}, null], env: { duration: 'bad', surface: 'unknown' } });
    expect(scene.roads).toEqual([]);
    expect(scene.actors).toEqual([]);
    expect(() => analyze(scene, simulate(scene))).not.toThrow();
  });

  it.each(['toString', '__proto__', 'constructor'])('отбрасывает свойство прототипа вместо покрытия: %s', surface => {
    const raw = { ...PRESETS.find(p => p.id === 'head-on')!.build(), env: { surface, duration: 8 } };
    const scene = normalizeScene(raw);
    expect(scene.env.surface).toBe('dry');
    expect(raw.env.surface).toBe(surface);
    const timeline = simulate(scene);
    expect(timeline.mu).toBe(0.7);
    expect(timeline.collisions.length).toBeGreaterThan(0);
    for (const track of timeline.tracks.values()) expect(Array.from(track.v).every(Number.isFinite)).toBe(true);
  });

  it('отбрасывает объект вместо названия покрытия без преобразования ключа', () => {
    expect(normalizeScene({ env: { surface: { toString: null } } }).env.surface).toBe('dry');
  });
});
