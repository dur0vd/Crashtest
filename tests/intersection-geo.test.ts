import { describe, expect, it } from 'vitest';
import { buildGeo, classifyIntersectionMovement, intersectionAt } from '../src/geo';
import { type Actor, type Road, emptyScene, normalizeScene } from '../src/scene';

const road = (id: string, pts: { x: number; y: number }[], extra: Partial<Road> = {}): Road => ({
  id, pts, lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false, ...extra,
});
const cross = () => {
  const scene = emptyScene();
  scene.roads = [road('h', [{ x: -80, y: 0 }, { x: 80, y: 0 }]), road('v', [{ x: 0, y: -80 }, { x: 0, y: 80 }])];
  return scene;
};
const actor = (path: Actor['path']): Actor => ({
  id: 'a', kind: 'vehicle', type: 'car', x: -60, y: 1.75, heading: 0, speed: 20,
  delay: 0, color: '#000', path, flags: { drunk: false, noLicense: false, flees: false },
});

describe('перекрёсток как геометрическая сущность', () => {
  it('находит один крестообразный перекрёсток с четырьмя подходами и оценочным контуром', () => {
    const geo = buildGeo(cross());
    expect(geo.intersections).toHaveLength(1);
    const junction = geo.intersections[0];
    expect(junction.roadIds).toEqual(['h', 'v']);
    expect(junction.approaches).toHaveLength(4);
    expect(junction.boundarySource).toBe('automatic-estimate');
    expect(junction.regulated).toBe(false);
    expect(junction.equal).toBe(true);
    expect(intersectionAt(geo, { x: 2, y: 2 })).toBe(junction);
    expect(intersectionAt(geo, { x: 10, y: 0 })).toBeUndefined();
  });

  it('находит Т-образное примыкание, включая конец оси на кромке дороги', () => {
    const scene = cross();
    scene.roads[1].pts = [{ x: 0, y: -80 }, { x: 0, y: -3.5 }];
    const junction = buildGeo(scene).intersections[0];
    expect(junction).toBeDefined();
    expect(junction.approaches).toHaveLength(3);
  });

  it('исключает прилегающую территорию и простое продолжение дороги', () => {
    const scene = cross();
    scene.roads[1].role = 'adjacent';
    expect(buildGeo(scene).intersections).toHaveLength(0);
    scene.roads[1] = road('v', [{ x: 80, y: 0 }, { x: 100, y: 0 }]);
    expect(buildGeo(scene).intersections).toHaveLength(0);
  });

  it('заменяет оценку обмеренной границей и сохраняет её при миграции', () => {
    const scene = cross();
    scene.intersectionBounds = [{ id: 'survey-1', roadIds: ['h', 'v'], boundary: [
      { x: -8, y: -8 }, { x: 8, y: -8 }, { x: 8, y: 8 }, { x: -8, y: 8 }, { x: -8, y: -8 },
    ] }];
    const loaded = normalizeScene(JSON.parse(JSON.stringify(scene)));
    const geo = buildGeo(loaded);
    expect(geo.intersections).toHaveLength(1);
    expect(geo.intersections[0].boundarySource).toBe('survey');
    expect(intersectionAt(geo, { x: 7, y: 7 })?.id).toBe('survey-1');
    expect(intersectionAt(geo, { x: 9, y: 9 })).toBeUndefined();
    expect(geo.intersections[0].approaches.map(a => Math.max(Math.abs(a.point.x), Math.abs(a.point.y)))).toEqual([8, 8, 8, 8]);
  });

  it('разделяет два перекрёстка одних дорог, если они далеко друг от друга', () => {
    const scene = cross();
    scene.roads[1].pts = [{ x: -40, y: -50 }, { x: -40, y: 50 }, { x: 40, y: 50 }, { x: 40, y: -50 }];
    expect(buildGeo(scene).intersections).toHaveLength(2);
  });

  it('учитывает светофор, его выключение и различное покрытие', () => {
    const scene = cross();
    scene.lights = [{ id: 'l', x: -8, y: 4, angle: 0, green: 20, yellow: 3, red: 20, offset: 0, lineLength: 3.5 }];
    expect(buildGeo(scene).intersections[0].regulated).toBe(true);
    scene.lights[0].mode = 'flashing-yellow';
    expect(buildGeo(scene).intersections[0].regulated).toBe(false);
    scene.roads[1].surfacePriority = 'unpaved';
    const junction = buildGeo(scene).intersections[0];
    expect(junction.equal).toBe(false);
    expect(junction.approaches.filter(a => a.roadId === 'v').every(a => a.priority === 'secondary')).toBe(true);
  });

  it('8.13 отмечает два подхода главной дороги, меняющей направление', () => {
    const scene = cross();
    scene.signs = [{ id: 's', kind: '2.1', x: -10, y: 5, angle: 0, plates: ['8.13'], mainDirections: [0, Math.PI / 2] }];
    const junction = buildGeo(scene).intersections[0];
    expect(junction.approaches.filter(a => a.priority === 'main')).toHaveLength(2);
    expect(junction.approaches.filter(a => a.priority === 'secondary')).toHaveLength(2);
  });

  it('кольцо с одним примыканием остаётся одним перекрёстком с центром в островке', () => {
    const scene = emptyScene();
    const ring = Array.from({ length: 33 }, (_, i) => ({ x: 20 * Math.cos(i * Math.PI / 16), y: 20 * Math.sin(i * Math.PI / 16) }));
    scene.roads = [road('ring', ring, { role: 'roundabout', oneWay: true }),
      road('entry', [{ x: -70, y: 0 }, { x: -20, y: 0 }])];
    const geo = buildGeo(scene);
    expect(geo.intersections).toHaveLength(1);
    expect(geo.intersections[0].roundabout).toBe(true);
    expect(geo.intersections[0].center.x).toBeCloseTo(0, 5);
    expect(geo.intersections[0].center.y).toBeCloseTo(0, 5);
    expect(geo.intersections[0].approaches.some(a => a.roadId === 'entry')).toBe(true);
    const a = actor([{ x: -20, y: 0, v: 20 }, { x: -14.14, y: 14.14, v: 20 }, { x: 0, y: 20, v: 20 }]);
    Object.assign(a, { x: -14.14, y: -14.14, heading: Math.PI * 3 / 4 });
    expect(classifyIntersectionMovement(geo, a, geo.intersections[0]).entryRoadId).toBe('ring');
  });

  it('односторонние подходы разделяют разрешённый въезд и выезд', () => {
    const scene = cross();
    scene.roads[0].oneWay = true;
    const approaches = buildGeo(scene).intersections[0].approaches.filter(a => a.roadId === 'h');
    expect(approaches).toHaveLength(2);
    expect(approaches.find(a => a.heading === 0)).toMatchObject({ entry: true, exit: false });
    expect(approaches.find(a => Math.abs(a.heading) > 3)).toMatchObject({ entry: false, exit: true });
  });
});

describe('манёвр по въезду и выезду полного пути', () => {
  it('распознаёт типичный наружный поворот по полному маршруту', () => {
    const geo = buildGeo(cross());
    const a = actor([{ x: -6, y: 1.75, v: 20 }, { x: -1.75, y: 6, v: 20 }, { x: -1.75, y: 40, v: 20 }]);
    a.x = -30;
    expect(classifyIntersectionMovement(geo, a, geo.intersections[0])).toMatchObject({
      maneuver: 'right', entryRoadId: 'h', exitRoadId: 'v',
    });
  });

  it('использует местный переход дорог, когда наружный поворот обходит оценочную границу', () => {
    const geo = buildGeo(cross());
    const a = actor([{ x: -8, y: 1.75, v: 20 }, { x: -1.75, y: 8, v: 20 }, { x: -1.75, y: 40, v: 20 }]);
    a.x = -30;
    expect(classifyIntersectionMovement(geo, a, geo.intersections[0])).toMatchObject({
      maneuver: 'right', entryRoadId: 'h', exitRoadId: 'v', routeSource: 'nearby-road-transition',
    });
  });

  it('не обходит обмеренную границу предположением о местном переходе дорог', () => {
    const scene = cross();
    scene.intersectionBounds = [{ id: 'survey', roadIds: ['h', 'v'], boundary: [
      { x: -3.5, y: -3.5 }, { x: 3.5, y: -3.5 }, { x: 3.5, y: 3.5 }, { x: -3.5, y: 3.5 },
    ] }];
    const geo = buildGeo(scene);
    const a = actor([{ x: -8, y: 1.75, v: 20 }, { x: -1.75, y: 8, v: 20 }, { x: -1.75, y: 40, v: 20 }]);
    a.x = -30;
    expect(classifyIntersectionMovement(geo, a, geo.intersections[0]).maneuver).toBe('unknown');
  });

  it('не связывает с перекрёстком удалённый переход между теми же дорогами', () => {
    const scene = cross();
    scene.roads[0].pts.push({ x: 80, y: 80 });
    scene.roads[1].pts.push({ x: 80, y: 80 });
    const geo = buildGeo(scene);
    const a = actor([{ x: 80, y: 75, v: 20 }, { x: 75, y: 80, v: 20 }, { x: 0, y: 80, v: 20 }]);
    Object.assign(a, { x: 80, y: 40, heading: Math.PI / 2 });
    expect(classifyIntersectionMovement(geo, a, geo.intersections.find(j => Math.abs(j.center.x) < 1)!).maneuver).toBe('unknown');
  });

  it.each([
    ['straight', [{ x: 60, y: 1.75, v: 20 }]],
    ['right', [{ x: -6, y: 1.75, v: 20 }, { x: -1.75, y: 6, v: 20 }, { x: -1.75, y: 60, v: 20 }]],
    ['left', [{ x: -6, y: 1.75, v: 20 }, { x: 1.75, y: -6, v: 20 }, { x: 1.75, y: -60, v: 20 }]],
    ['uturn', [{ x: -5, y: 1.75, v: 20 }, { x: 1, y: 0, v: 20 }, { x: -5, y: -1.75, v: 20 }, { x: -60, y: -1.75, v: 20 }]],
  ] as const)('%s: не зависит от кадра столкновения до окончания манёвра', (maneuver, path) => {
    const geo = buildGeo(cross());
    const movement = classifyIntersectionMovement(geo, actor(path.map(p => ({ ...p }))), geo.intersections[0]);
    expect(movement.maneuver).toBe(maneuver);
    expect(movement.entryRoadId).toBe('h');
    expect(movement.exitRoadId).toBe(maneuver === 'right' || maneuver === 'left' ? 'v' : 'h');
  });

  it('возвращает unknown для пути, не пересекающего этот перекрёсток', () => {
    const geo = buildGeo(cross());
    const a = actor([{ x: -100, y: 1.75, v: 20 }]);
    expect(classifyIntersectionMovement(geo, a, geo.intersections[0]).maneuver).toBe('unknown');
  });
});

it('миграция задаёт прежние сигналы и безопасно отклоняет неверные новые параметры', () => {
  const scene = cross();
  scene.lights = [{ id: 'l', x: -8, y: 4, angle: 0, green: 20, yellow: 3, red: 20, offset: 0, lineLength: 3.5 }];
  const loaded = normalizeScene(JSON.parse(JSON.stringify(scene)));
  expect(loaded.lights[0]).toMatchObject({ mode: 'cycle', kind: 'vehicle', stopLine: true });
  expect(loaded.roads[0]).toMatchObject({ role: 'road', surfacePriority: 'hard' });
  const malformed = normalizeScene({ ...scene, lights: [{ ...scene.lights[0], kind: 'controller', controllerGesture: 'bad' }],
    intersectionBounds: [{ id: 'bad', roadIds: ['h', 'v'], boundary: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }] }] });
  expect(malformed.lights[0].controllerGesture).toBe('arm-up');
  expect(malformed.intersectionBounds).toEqual([]);
});
