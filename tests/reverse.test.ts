import { describe, expect, it } from 'vitest';
import { angDiff } from '../src/geom';
import { emptyScene, normalizeScene, type Actor, type Scene } from '../src/scene';
import { DT, simulate } from '../src/sim';

function car(speed: number, path: Actor['path'] = []): Actor {
  return { id: 'car', kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed, path,
    color: '#00aaff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } };
}
function sceneWith(actor: Actor, duration = 10): Scene {
  const scene = emptyScene();
  scene.env.duration = duration;
  scene.actors = [actor];
  return scene;
}

describe('движение задним ходом', () => {
  it('отрицательная начальная скорость без маршрута перемещает назад, сохраняя курс кузова', () => {
    const timeline = simulate(sceneWith(car(-36), 4));
    const track = timeline.tracks.get('car')!;
    expect(track.x.at(-1)).toBeCloseTo(-40, 2);
    expect(track.v.at(-1)).toBeCloseTo(10, 5);
    expect([...track.reversing!].every(value => value === 1)).toBe(true);
    expect([...track.h].every(h => Math.abs(angDiff(0, h)) < 1e-5)).toBe(true);
  });

  it('знак скорости целевой точки задаёт движение к ней задним ходом', () => {
    const actor = car(18, [{ x: -40, y: 0, v: -18 }]);
    const timeline = simulate(sceneWith(actor, 4));
    const track = timeline.tracks.get('car')!;
    expect(track.x.at(-1)).toBeCloseTo(-20, 2);
    expect(track.v.at(-1)).toBeCloseTo(5, 5);
    expect(track.reversing![0]).toBe(1);
    expect(track.h[0]).toBeCloseTo(0, 6);
    expect(Math.abs(angDiff(0, track.h[0]))).toBeLessThan(1e-5);
    expect(actor.speed).toBe(18);
    expect(actor.path[0].v).toBe(-18);
  });

  it('задний ход создаёт физический контакт с препятствием позади', () => {
    const scene = sceneWith(car(-18), 5);
    scene.obstacles = [{ id: 'barrier', x: -15, y: 0, w: 1, h: 5, angle: 0, kind: 'barrier' }];
    const timeline = simulate(scene);
    expect(timeline.collisions).toHaveLength(1);
    const contact = timeline.collisions[0];
    expect(contact.kind).toBe('vo');
    expect(contact.vA.x).toBeCloseTo(-5, 5);
    expect(contact.vA.y).toBeCloseTo(0, 5);
    expect(contact.rel).toBeGreaterThan(4.9);
    expect(contact.dvA).toBeGreaterThan(0);
    expect(contact.point.x).toBeLessThan(-14);
    expect(timeline.tracks.get('car')!.free[contact.frame]).toBe(1);
  });

  it('при контакте двух ТС вектор скорости не путается с направлением кузова', () => {
    const scene = sceneWith(car(-18), 5);
    scene.actors.push({ ...car(0), id: 'parked', x: -15 });
    const timeline = simulate(scene);
    const contact = timeline.collisions.find(c => c.kind === 'vv')!;
    expect(contact).toBeDefined();
    expect(contact.vA.x).toBeCloseTo(-5, 5);
    expect(contact.vB.x).toBe(0);
    expect(contact.rel).toBeGreaterThan(4.9);
    expect(timeline.tracks.get('parked')!.x.at(-1)).toBeLessThan(-15);
  });

  it('смена знака добавляет остановку даже при ненулевой скорости предыдущей точки', () => {
    const actor = car(18, [{ x: 10, y: 0, v: 18 }, { x: -30, y: 0, v: -18 }]);
    const timeline = simulate(sceneWith(actor, 14));
    const track = timeline.tracks.get('car')!;
    const switched = [...track.reversing!].findIndex(value => value === 1);
    expect(switched).toBeGreaterThan(1);
    expect(track.v[switched - 1]).toBe(0);
    expect(track.waypointTimes![0]).toBeCloseTo((switched - 1) * DT, 9);
    expect(track.x[switched]).toBeLessThan(track.x[switched - 1]);
    expect([...track.h].every(h => Math.abs(angDiff(0, h)) < 1e-5)).toBe(true);
    expect(track.x.at(-1)).toBeLessThan(0);
    expect(actor.path[0].v).toBe(18); // implicit stop changes the runtime, not source evidence
  });

  it('в точке переключения сохраняет паузу и неподвижный курс кузова', () => {
    const actor = car(18, [{ x: 10, y: 0, v: 0, hold: 1.5 }, { x: -30, y: 0, v: -18 }]);
    const timeline = simulate(sceneWith(actor, 15));
    const track = timeline.tracks.get('car')!;
    const stopped = Math.round(track.waypointTimes![0] / DT);
    expect(track.v[stopped]).toBe(0);
    for (let k = stopped; k <= stopped + 1.5 / DT; k++) {
      expect(track.v[k]).toBe(0);
      expect(track.x[k]).toBe(track.x[stopped]);
      expect(Math.abs(angDiff(0, track.h[k]))).toBeLessThan(1e-5);
    }
    const switched = [...track.reversing!].findIndex(value => value === 1);
    expect(switched * DT).toBeGreaterThanOrEqual(track.waypointTimes![0] + 1.5);
    expect(track.waypointTimes![1]).toBeGreaterThan(track.waypointTimes![0] + 1.5);
  });

  it('на льду тормозит за точкой переключения без разворота кузова на ходу или скачка назад', () => {
    const scene = sceneWith(car(36, [{ x: 10, y: 0, v: 36 }, { x: -100, y: 0, v: -36 }]), 30);
    scene.env.surface = 'ice';
    const timeline = simulate(scene);
    const track = timeline.tracks.get('car')!;
    const stopped = Math.round(track.waypointTimes![0] / DT);
    expect(track.x[stopped]).toBeGreaterThan(40);
    expect(track.v[stopped]).toBe(0);
    expect([...track.x].slice(0, stopped + 1).every((x, k, xs) => !k || x >= xs[k - 1])).toBe(true);
    expect([...track.h].every(h => Math.abs(angDiff(0, h)) < 1e-5)).toBe(true);
    expect(track.x[stopped + 1]).toBeLessThanOrEqual(track.x[stopped]);
    expect(track.x.at(-1)).toBeLessThan(0);
    expect([...track.x, ...track.y, ...track.v].every(Number.isFinite)).toBe(true);
  });
});

describe('фактические времена путевых точек', () => {
  it('сохраняет абсолютные времена с учётом задержки и первого пересечения', () => {
    const actor = car(36, [{ x: 10, y: 0, v: 36 }, { x: 20, y: 0, v: 36 }]);
    actor.delay = 2;
    const timeline = simulate(sceneWith(actor, 6));
    const track = timeline.tracks.get('car')!;
    expect(track.waypointTimes).toHaveLength(2);
    for (let n = 0; n < 2; n++) {
      const reached = track.waypointTimes![n];
      expect(reached).toBeCloseTo(3 + n, 1);
      const frame = Math.round(reached / DT);
      expect(track.x[frame]).toBeGreaterThanOrEqual((n + 1) * 10);
      expect(track.x[frame - 1]).toBeLessThan((n + 1) * 10);
    }
  });

  it('не выдаёт расчётное время за фактическое для точки, не достигнутой до окончания или контакта', () => {
    const scene = sceneWith(car(18, [{ x: 100, y: 0, v: 18 }]), 2);
    const result = simulate(scene);
    expect(result.tracks.get('car')!.waypointTimes).toEqual([-1]);
    expect(JSON.parse(JSON.stringify(result.tracks.get('car')!.waypointTimes))).toEqual([-1]);
  });

  it('при стопе на льду фиксирует остановку после перелёта, а паузу считает после неё', () => {
    const scene = sceneWith(car(36, [{ x: 10, y: 0, v: 0, hold: 2 }, { x: 150, y: 0, v: 36 }]), 20);
    scene.env.surface = 'ice';
    const timeline = simulate(scene);
    const track = timeline.tracks.get('car')!;
    const stopped = Math.round(track.waypointTimes![0] / DT);
    expect(track.x[stopped]).toBeGreaterThan(10);
    expect(track.v[stopped]).toBe(0);
    expect(track.v[stopped + Math.floor(2 / DT)]).toBe(0);
  });
});

describe('миграция сцены для манёвров', () => {
  it('сохраняет отрицательные скорости ТС, сигналы и подтверждённые факты', () => {
    const raw = sceneWith(car(-100, [{ x: -20, y: 0, v: -80, signal: 'right', signalAt: 1.25 }]));
    raw.actors[0].maneuverContext = { oncomingClear: false, longVehicleException: true };
    raw.roads = [{ id: 'road', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], lanes: 1, center: 'dashed', oneWay: true, zone: 'city', smooth: false,
      features: ['bridge', 'tunnel', 'bridge'], laneRole: 'acceleration', visibility: 80 }];
    const scene = normalizeScene(JSON.parse(JSON.stringify(raw)));
    expect(scene.actors[0].speed).toBe(-50);
    expect(scene.actors[0].path[0]).toMatchObject({ v: -50, signal: 'right', signalAt: 1.25 });
    expect(scene.actors[0].maneuverContext).toEqual({ oncomingClear: false, longVehicleException: true });
    expect(scene.actors[0].maneuverContext).not.toHaveProperty('expectedStraight');
    expect(scene.roads[0]).toMatchObject({ features: ['bridge', 'tunnel'], laneRole: 'acceleration', visibility: 80 });
  });

  it('старые точки получают none, неверные времена и недостоверные значения отбрасываются', () => {
    const raw = sceneWith(car(18, [{ x: 10, y: 0, v: 18 }]));
    const invalid = JSON.parse(JSON.stringify(raw));
    invalid.actors[0].path.push({ x: 20, y: 0, v: -10, signal: 'bad', signalAt: -1, hold: -3 });
    invalid.actors[0].maneuverContext = { oncomingClear: 'yes', keptRight: false, handSignal: 'bad', unknown: true };
    invalid.roads = [{ id: 'road', pts: [], lanes: 1, features: ['bridge', 'bad', 'bridge'], visibility: -1, laneRole: 'bad' }];
    const scene = normalizeScene(invalid);
    expect(scene.actors[0].path[0].signal).toBe('none');
    expect(scene.actors[0].path[1]).toMatchObject({ v: -10, signal: 'none' });
    expect(scene.actors[0].path[1]).not.toHaveProperty('signalAt');
    expect(scene.actors[0].path[1]).not.toHaveProperty('hold');
    expect(scene.actors[0].maneuverContext).toEqual({ keptRight: false });
    expect(scene.roads[0].features).toEqual(['bridge']);
    expect(scene.roads[0]).not.toHaveProperty('visibility');
    expect(scene.roads[0]).not.toHaveProperty('laneRole');
  });

  it('отрицательная скорость пешехода не трактуется как задний ход транспортного средства', () => {
    const actor = { ...car(-18, [{ x: -20, y: 0, v: -18 }]), kind: 'pedestrian', type: 'adult' };
    const scene = normalizeScene(sceneWith(actor as Actor));
    expect(scene.actors[0].speed).toBe(0);
    expect(scene.actors[0].path[0].v).toBe(0);
  });
});


it('сохраняет только явно заданные положительные параметры заблаговременности', () => {
  const raw = sceneWith(car(18));
  expect(normalizeScene(raw).env).not.toHaveProperty('signalLeadSeconds');
  raw.env.signalLeadSeconds = 3;
  raw.env.signalLeadMeters = 15;
  expect(normalizeScene(raw).env).toMatchObject({ signalLeadSeconds: 3, signalLeadMeters: 15 });
  raw.env.signalLeadSeconds = 0;
  raw.env.signalLeadMeters = Infinity;
  const normalized = normalizeScene(raw);
  expect(normalized.env).not.toHaveProperty('signalLeadSeconds');
  expect(normalized.env).not.toHaveProperty('signalLeadMeters');
});


it('нулевая установленная видимость остаётся измеренным значением, а не неизвестностью', () => {
  const raw = sceneWith(car(0));
  raw.roads = [{ id: 'road', pts: [], lanes: 1, center: 'dashed', oneWay: false, smooth: false, zone: 'city', visibility: 0 }];
  expect(normalizeScene(raw).roads[0].visibility).toBe(0);
});
