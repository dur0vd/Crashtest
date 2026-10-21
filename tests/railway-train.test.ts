import { describe, expect, it } from 'vitest';
import { prepare } from '../src/analysis/technical';
import { analyzeLegal, subjectOf } from '../src/analysis/legal';
import type { RulesSection } from '../src/analysis/types';
import { buildGeo, trackAt } from '../src/geo';
import { actorLabels, actorSpec, actorTitle, dimsOf, emptyScene, normalizeScene, VEHICLES, type Actor, type Scene, type TramTrack } from '../src/scene';
import { simulate } from '../src/sim';

// Deliberately synthetic inputs exercise the calculation, not a real train's
// measured characteristics. They must never become catalogue defaults.
const syntheticTrain = (): Actor => ({ id: 'train', kind: 'vehicle', type: 'tram', x: 0, y: 0,
  heading: 0, speed: 72, delay: 0, color: '#f80', path: [],
  flags: { drunk: false, noLicense: false, flees: false },
  railwayTrain: { mass: 100_000, length: 8, width: 3, brakeDecel: 0.5,
    source: 'Синтетические входные данные теста; не натурные измерения' } });
const track = (id = 'railway', y = 0, kind: TramTrack['kind'] = 'railway'): TramTrack => ({ id, kind,
  pts: [{ x: -1_000, y }, { x: 1_000, y }], separated: true, smooth: false });
function trainScene(): Scene {
  const scene = emptyScene();
  scene.env.duration = 45;
  scene.tracks = [track()];
  scene.actors = [syntheticTrain()];
  return scene;
}

describe('явно заданная модель состава', () => {
  it('использует введённую массу и габариты вместо каталога трамвая', () => {
    const scene = trainScene(), actor = scene.actors[0];
    expect(actorSpec(actor)).toEqual({ mass: 100_000, length: 8, width: 3 });
    expect(dimsOf(actor)).toMatchObject({ mass: 100_000, length: 8, width: 3, shift: 0 });
    expect(actorSpec({ ...actor, railwayTrain: undefined }).mass).toBe(VEHICLES.tram.mass);
    expect(actorTitle(actor, actorLabels(scene))).toContain('(поезд)');
    const context = prepare(scene, simulate(scene));
    expect(context.infos.get(actor.id)).toMatchObject({ mass: 100_000, hl: 4, hw: 1.5, brake: 0.5 });
  });

  it('тормозит по заданному j: v=20−0,5t и S=v₀t−jt²/2', () => {
    const scene = trainScene();
    scene.actors[0].path = [{ x: 400, y: 0, v: 0, hold: 10 }];
    const timeline = simulate(scene), result = timeline.tracks.get('train')!;
    const tenSeconds = Math.round(10 / timeline.dt);
    // The existing fixed-step integrator has a finite discretisation error.
    expect(Math.abs(result.v[tenSeconds] - 15)).toBeLessThan(0.03);
    expect(Math.abs(result.x[tenSeconds] - 175)).toBeLessThan(0.5);
    expect(Math.abs(result.x.at(-1)! - 20 ** 2 / (2 * 0.5))).toBeLessThan(0.5);
    expect(result.v.at(-1)).toBe(0);
    expect(Math.abs(result.waypointTimes![0] - 20 / 0.5)).toBeLessThan(0.1);
    expect([...result.v].every((v, k, speeds) => k === 0 || speeds[k - 1] - v <= 0.5 * timeline.dt + 1e-5)).toBe(true);
  });

  it('не подменяет замедление состава коэффициентом сцепления автодороги', () => {
    const dry = trainScene(), ice = trainScene();
    for (const scene of [dry, ice]) scene.actors[0].path = [{ x: 400, y: 0, v: 0 }];
    ice.env.surface = 'ice';
    const A = simulate(dry).tracks.get('train')!, B = simulate(ice).tracks.get('train')!;
    expect(B.v).toEqual(A.v);
    expect(B.x).toEqual(A.x);
    expect(prepare(ice, simulate(ice)).infos.get('train')!.brake).toBe(0.5);
  });

  it('не выдаёт трамвайную тягу за неизвестную тягу состава', () => {
    const scene = trainScene();
    scene.actors[0].speed = 0;
    scene.actors[0].path = [{ x: 100, y: 0, v: 36 }];
    const result = simulate(scene).tracks.get('train')!;
    expect([...result.v].every(v => v === 0)).toBe(true);
    expect([...result.x].every(x => x === 0)).toBe(true);
  });

  it('не применяет трамвайный порог схода после сильного удара', () => {
    const scene = trainScene();
    scene.env.duration = 5;
    scene.actors[0].derail = true; // Direct callers cannot enable the tram threshold either.
    scene.obstacles = [{ id: 'obstacle', x: 50, y: 0, w: 1, h: 20, angle: 0, kind: 'barrier' }];
    const timeline = simulate(scene), result = timeline.tracks.get('train')!;
    expect(timeline.collisions).toHaveLength(1);
    expect(timeline.collisions[0].rel).toBeGreaterThan(5.5);
    expect([...result.free].every(value => value === 0)).toBe(true);
    expect([...result.y].every(y => y === 0)).toBe(true);
    expect(result.v.at(-1)).toBeLessThan(20);
  });
});

describe('раздельные железнодорожные и трамвайные пути', () => {
  it('поезд выбирает железную дорогу, даже если трамвайный путь ближе', () => {
    const scene = trainScene();
    scene.tracks = [track('tram', 0, 'tram'), track('railway', 1)];
    scene.actors[0].y = 0.1;
    scene.env.duration = 1;
    expect(simulate(scene).tracks.get('train')!.y[0]).toBe(1);
    const tram = { ...scene.actors[0], railwayTrain: undefined };
    scene.actors = [tram];
    expect(simulate(scene).tracks.get('train')!.y[0]).toBe(0);
  });

  it('явная ссылка выбирает нужный железнодорожный путь', () => {
    const scene = trainScene();
    scene.tracks = [track('nearby', 0), track('selected', 3)];
    scene.actors[0].railwayTrain!.trackId = 'selected';
    expect(simulate(scene).tracks.get('train')!.y[0]).toBe(3);
  });

  it.each(['missing', 'tram-only', 'too-far', 'bad-link'] as const)('ошибка %s не превращает поезд в свободно движущийся трамвай', condition => {
    const scene = trainScene();
    if (condition === 'missing') scene.tracks = [];
    if (condition === 'tram-only') scene.tracks = [track('tram', 0, 'tram')];
    if (condition === 'too-far') scene.tracks = [track('far', 5)];
    if (condition === 'bad-link') scene.actors[0].railwayTrain!.trackId = 'absent';
    expect(() => simulate(scene)).toThrow(/Поезд train.*железнодорожный путь/);
  });

  it('железная дорога не становится трамвайной полосой для п. 8.5', () => {
    const scene = trainScene();
    expect(trackAt(buildGeo(scene), { x: 10, y: 0 })).toBeNull();
    scene.tracks.push(track('tram', 0, 'tram'));
    expect(trackAt(buildGeo(scene), { x: 10, y: 0 })!.tg.item.id).toBe('tram');
  });
});

describe('сохранение известных и неизвестных железнодорожных фактов', () => {
  it('старый путь остаётся трамвайным, отсутствие коллекции переездов остаётся неизвестным', () => {
    const raw = trainScene();
    delete raw.tracks[0].kind;
    delete raw.railwayCrossings;
    const result = normalizeScene(raw);
    expect(result.tracks[0].kind).toBe('tram');
    expect(result.railwayCrossings).toBeUndefined();
  });

  it('не назначает неизвестным состояниям шлагбаума/сигнала/остановки отрицательные значения', () => {
    const raw = trainScene();
    raw.railwayCrossings = [{ id: 'crossing', x: 0, y: 0, angle: 0, width: 8, length: 1.52,
      stopLineDistance: 0, exitBlocked: false, source: 'Синтетическая геометрия' }];
    raw.actors[0].railwayContext = { forcedStop: false, clearingCrossing: true };
    raw.actors[0].derail = true;
    const result = normalizeScene(raw);
    expect(result.railwayCrossings![0]).toEqual(raw.railwayCrossings[0]);
    expect(result.railwayCrossings![0]).not.toHaveProperty('barrier');
    expect(result.railwayCrossings![0]).not.toHaveProperty('lightPresent');
    expect(result.railwayCrossings![0]).not.toHaveProperty('stopLinePresent');
    expect(result.actors[0].railwayContext).toEqual({ forcedStop: false, clearingCrossing: true });
    expect(result.actors[0].railwayContext).not.toHaveProperty('generalAlarm');
    expect(result.actors[0]).not.toHaveProperty('derail');
  });

  it.each(['mass', 'length', 'width', 'brakeDecel', 'source', 'type'] as const)('не заменяет недостоверное поле %s параметрами трамвая', field => {
    const raw = trainScene();
    if (field === 'source') raw.actors[0].railwayTrain!.source = ' ';
    else if (field === 'type') raw.actors[0].type = 'car';
    else raw.actors[0].railwayTrain![field] = 0;
    expect(() => normalizeScene(raw)).toThrow(/Поезд train/);
    expect(() => simulate(raw)).toThrow(/Поезд train/);
  });

  it('отбрасывает поддельные bool и отрицательные расстояния, сохраняя измеренный ноль', () => {
    const raw = JSON.parse(JSON.stringify(trainScene()));
    raw.railwayCrossings = [{ id: 'crossing', x: 0, y: 0, angle: 0, width: 8, length: 1.52,
      lightPresent: 'no', regulated: false, stopLineDistance: 0, controlDistance: -1 }];
    raw.actors[0].railwayContext = { generalAlarm: 'yes', forcedStop: true, stopMessengers: 'bad' };
    const result = normalizeScene(raw);
    expect(result.railwayCrossings![0]).toMatchObject({ regulated: false, stopLineDistance: 0 });
    expect(result.railwayCrossings![0]).not.toHaveProperty('lightPresent');
    expect(result.railwayCrossings![0]).not.toHaveProperty('controlDistance');
    expect(result.actors[0].railwayContext).toEqual({ forcedStop: true });
  });
});

describe('граница дорожной квалификации для машиниста', () => {
  it('не назначает машинисту 12.7, 12.8 или 264 по трамвайному внутреннему типу', () => {
    const scene = trainScene();
    const train = scene.actors[0];
    train.flags = { drunk: true, noLicense: true, flees: true };
    const rules: RulesSection = { priorityGraphs: [],
      actors: [{ actorId: train.id, status: 'causal-violation', text: 'Синтетическое причинное событие', trace: {} }],
      findings: [{ actorId: train.id, severity: 'violation', title: 'Синтетическое причинное нарушение', detail: '',
        refs: ['pdd:8.1'], causal: true, requirement: 'pdd:8.1', compliance: 'не выполнено', prevention: true,
        trace: { ruleCodes: ['rule:maneuver-priority'] } }],
      collisions: [{ title: 'Синтетический контакт', description: '', trace: {}, tech: [], notes: [],
        harm: [{ actorId: 'victim', level: 'fatal', trace: {} }],
        collision: { idx: 0, t: 1, frame: 40, a: train.id, b: 'obstacle', kind: 'vo',
          point: { x: 20, y: 0 }, n: { x: 1, y: 0 }, vA: { x: 20, y: 0 }, vB: { x: 0, y: 0 },
          rel: 20, dvA: 1, dvB: 0 } }] };
    expect(subjectOf(train)).toMatchObject({ roadSubject: false, administrativeSubject: false, licenseRequired: false });
    const result = analyzeLegal(scene, rules);
    const verdict = result.section.verdicts[0];
    expect(verdict.legal.flatMap(item => item.refs)).toEqual([]);
    expect(verdict.legal[0].text).toContain('не реализована');
    expect(verdict.trace.legalScope).toBe('railway-not-implemented');
    expect(result.section.duties).toEqual([]);
  });
});
