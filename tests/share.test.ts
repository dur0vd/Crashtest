import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { normalizeScene, type Scene } from '../src/scene';
import { encodeShare, decodeShare, sceneFromHash } from '../src/share';
import { simulate } from '../src/sim';
import { analyze } from '../src/analysis';
import minimal from './fixtures/legacy-minimal.json';
import signs from './fixtures/legacy-signs.json';
import actor from './fixtures/legacy-actor.json';
import malformed from './fixtures/malformed-nested.json';

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

  it('восстанавливает вложенные поля из повреждённого JSON перед рендером и разбором', () => {
    const before = JSON.stringify(malformed);
    const scene = sceneFromHash(`#s=${encodeShare(malformed as unknown as Scene)}`)!;
    expect(scene).not.toBeNull();
    expect(scene.sidewalks[0].width).toBeGreaterThan(0);
    expect(scene.sidewalks[0].radius).toBe(0);
    expect(scene.tracks[0]).toMatchObject({ radius: 0, separated: false });
    expect(scene.crosswalks[0]).toMatchObject({ angle: 0, width: 4, length: 8 });
    expect(scene.crosswalks[0].lightId).toBeUndefined();
    expect(scene.lights[0]).toMatchObject({ angle: 0, lineLength: 3.5, green: 10, yellow: 0, red: 12, offset: 0 });
    expect(scene.obstacles[0]).toMatchObject({ angle: 0, w: 2.2, h: 2.2 });
    expect(scene.signs[0]).toMatchObject({ angle: 0, plates: ['8.2.1'] });
    expect(scene.signs[0].value).toBeUndefined();
    expect(scene.signs[0].zoneLen).toBeUndefined();
    expect(scene.markings[0]).toMatchObject({ angle: 0, radius: 0 });
    expect(scene.markings[0].variant).toBeUndefined();
    expect(scene.roads[0]).toMatchObject({ center: 'dashed', zone: 'city', wl: [{ s: 0, w: 3.5 }, { s: 20, w: 0 }] });
    expect(scene.actors[0].cargo).toMatchObject({ secured: false, dangerous: false, front: 0, mass: 0 });
    const timeline = simulate(scene);
    expect(() => analyze(scene, timeline)).not.toThrow();
    for (const track of timeline.tracks.values()) {
      for (const key of ['x', 'y', 'h', 'v'] as const) expect(Array.from(track[key]).every(Number.isFinite)).toBe(true);
    }
    expect(decodeShare(encodeShare(scene))).toEqual(scene);
    expect(JSON.stringify(malformed)).toBe(before);
  });

  it.each(['constructor', '__proto__', 'toString'])('не использует свойство прототипа как вид знака или разметки: %s', kind => {
    const scene = normalizeScene({ signs: [{ id: 'g1', x: 0, y: 0, kind }], markings: [{ id: 'm1', pts: [{ x: 0, y: 0 }], kind }] });
    expect(scene.signs).toEqual([]);
    expect(scene.markings).toEqual([]);
  });

  it('не приводит объект типа участника к ключу словаря', () => {
    const scene = normalizeScene({ actors: [{ id: 'a1', x: 0, y: 0, kind: 'vehicle', type: { toString: null } }] });
    expect(scene.actors).toEqual([]);
  });

  it('сохраняет корректные размеры, радиусы, углы и нулевые фазы светофора', () => {
    const raw = {
      sidewalks: [{ id: 's1', pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }], width: 0.25, radius: 2.5, smooth: true }],
      tracks: [{ id: 't1', pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }], radius: 15, separated: true, smooth: false }],
      crosswalks: [{ id: 'c1', x: 0, y: 0, angle: -1.5, width: 1.2, length: 3.2, lightId: 'l1' }],
      lights: [{ id: 'l1', x: 0, y: 0, angle: 4.5, lineLength: 1.5, green: 0, yellow: 0, red: 10, offset: -5 }],
      signs: [{ id: 'g1', x: 0, y: 0, angle: -4.5, kind: '3.24', value: 40, zoneLen: 0, plates: ['8.2.1'] }],
      obstacles: [{ id: 'o1', x: 0, y: 0, angle: 0.25, kind: 'fence', w: 0.2, h: 0.1 }],
      markings: [{ id: 'm1', pts: [{ x: 0, y: 0 }], kind: '1.18', angle: -1, radius: 6, smooth: true, variant: 'straight-left', solidRight: true }],
    };
    const scene = normalizeScene(raw);
    expect(scene).toMatchObject(raw);
    expect(normalizeScene(scene)).toEqual(scene);
  });
});
