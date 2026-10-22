import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import type { Ctx } from '../src/analysis/context';
import { checkRouteTransport, routeLaneAt, routeLanePermission, routePriority, routeSignException } from '../src/analysis/route-transport';
import { prepare } from '../src/analysis/technical';
import { angDiff } from '../src/geom';
import { MARKING_BY_ID } from '../src/markings';
import { emptyScene, type Actor, type Road, type RouteContext, type RouteLane, type Scene, type Sign } from '../src/scene';
import { DT, type Collision, type Timeline, type Track } from '../src/sim';

// Authored observations are independent of the simulated path follower. All
// dimensions, positions and times below are synthetic conditions of these tests.
type Key = { t: number; x: number; y: number; h?: number; v?: number };
type Observed = { actor: Actor; keys: Key[] };
type Contact = { a: string; b: string; t: number };
const duration = 8;
const road = (options: Partial<Road> = {}): Road => ({ id: 'road', pts: [{ x: -200, y: 0 }, { x: 200, y: 0 }],
  lanes: 2, center: 'dashed', oneWay: false, smooth: false, zone: 'city', ...options });
const noExemption: RouteContext = { regularService: false, schoolBus: false, taxi: false,
  regionalBusLaneEligible: false, laneUse: 'through' };
const lane = (options: Partial<RouteLane> = {}): RouteLane => ({ id: 'route-lane', fromS: 0, toS: 400,
  offset: 5.25, width: 3.5, direction: 'forward', signIds: ['bus-sign'], boundary: 'dashed', rightmost: true,
  source: 'Синтетический обмер для проверки', ...options });
const sign = (kind = '5.14.1', options: Partial<Sign> = {}): Sign => ({ id: 'bus-sign', kind, x: -150, y: 8, angle: 0, ...options });

function observed(id: string, keys: Key[], options: Partial<Actor> = {}): Observed {
  const first = keys[0], next = keys[1] ?? first;
  const speed = first.v ?? Math.hypot(next.x - first.x, next.y - first.y) / Math.max(DT, next.t - first.t);
  return { keys, actor: { id, kind: 'vehicle', type: 'car', x: first.x, y: first.y,
    heading: first.h ?? Math.atan2(next.y - first.y, next.x - first.x), speed: speed * 3.6,
    delay: 0, color: '#28b', flags: { drunk: false, noLicense: false, flees: false },
    path: keys.slice(1).map(key => ({ x: key.x, y: key.y, v: (key.v ?? speed) * 3.6 })), ...options } };
}
function moving(options: Partial<Actor> = {}, y = 5.25): Observed {
  return observed('vehicle', [{ t: 0, x: -30, y, h: 0, v: 10 }, { t: duration, x: 50, y, h: 0, v: 10 }],
    { routeContext: { ...noExemption }, ...options });
}
function trackFor(spec: Observed, n: number): Track {
  const track: Track = { id: spec.actor.id, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n),
    v: new Float32Array(n), present: new Uint8Array(n).fill(1), free: new Uint8Array(n), waypointTimes: spec.keys.slice(1).map(key => key.t) };
  for (let frame = 0; frame < n; frame++) {
    const time = frame * DT;
    let index = spec.keys.findIndex((key, i) => i > 0 && key.t > time);
    if (index < 0) index = spec.keys.length - 1;
    const a = spec.keys[Math.max(0, index - 1)], b = spec.keys[index];
    const fraction = Math.max(0, Math.min(1, (time - a.t) / Math.max(DT, b.t - a.t)));
    track.x[frame] = a.x + (b.x - a.x) * fraction;
    track.y[frame] = a.y + (b.y - a.y) * fraction;
    track.h[frame] = a.h !== undefined && b.h !== undefined ? a.h + angDiff(a.h, b.h) * fraction
      : a.h ?? Math.atan2(b.y - a.y, b.x - a.x);
    track.v[frame] = a.v !== undefined && b.v !== undefined ? a.v + (b.v - a.v) * fraction
      : a.v ?? Math.hypot(b.x - a.x, b.y - a.y) / Math.max(DT, b.t - a.t);
  }
  return track;
}
function timeline(specs: Observed[], contacts: Contact[] = []): Timeline {
  const n = Math.round(duration / DT) + 1;
  const tracks = new Map(specs.map(spec => [spec.actor.id, trackFor(spec, n)]));
  const collisions: Collision[] = contacts.map((contact, idx) => {
    const frame = Math.round(contact.t / DT), a = tracks.get(contact.a)!, b = tracks.get(contact.b)!;
    const velocity = (track: Track) => ({ x: Math.cos(track.h[frame]) * track.v[frame], y: Math.sin(track.h[frame]) * track.v[frame] });
    const vA = velocity(a), vB = velocity(b);
    return { idx, frame, t: contact.t, a: contact.a, b: contact.b, kind: 'vv',
      point: { x: (a.x[frame] + b.x[frame]) / 2, y: (a.y[frame] + b.y[frame]) / 2 }, n: { x: 1, y: 0 },
      vA, vB, rel: Math.hypot(vA.x - vB.x, vA.y - vB.y), dvA: 0, dvB: 0 };
  });
  return { dt: DT, n, duration, mu: 0.7, tracks, collisions };
}
function sceneFor(specs: Observed[], options: Partial<Scene> = {}): Scene {
  const scene = emptyScene();
  scene.env.accidentDate = '2026-10-21T12:00';
  scene.env.duration = duration;
  scene.env.federalCity = 'other';
  scene.roads = [road({ routeLanes: [lane()] })];
  scene.signs = [sign()];
  scene.actors = specs.map(spec => spec.actor);
  return Object.assign(scene, options);
}
function context(scene: Scene, tl: Timeline): Ctx {
  return { ...prepare(scene, tl), findings: [], priorityGraphs: [], events: [], onc: new Map(),
    lightViolations: new Map(), stopSkipped: new Map(), pedEntry: new Map() };
}
function run(specs: Observed[], options: Partial<Scene> = {}, contacts: Contact[] = []): Ctx {
  const ctx = context(sceneFor(specs, options), timeline(specs, contacts));
  checkRouteTransport(ctx, finding => ctx.findings.push({ causal: false, ...finding }));
  return ctx;
}
const withRef = (ctx: Ctx, actorId: string, ref: string) => ctx.findings.filter(finding => finding.actorId === actorId && finding.refs.includes(ref));
const violated = (ctx: Ctx, actorId: string, ref: string) => withRef(ctx, actorId, ref).filter(finding => finding.severity === 'violation');
const permission = (spec: Observed, options: Partial<Scene> = {}) => {
  const ctx = context(sceneFor([spec], options), timeline([spec])), info = ctx.infos.get(spec.actor.id)!;
  const hit = routeLaneAt(ctx, info, 0);
  expect(hit).not.toBeNull();
  return routeLanePermission(ctx, info, hit!);
};

describe('18.2: полоса задаётся геометрией и установленными знаками', () => {
  it.each(['5.14', '5.14.1', '5.11.1', '5.13.1', '5.13.2'])('%s подтверждает назначение заданной полосы', kind => {
    expect(violated(run([moving()], { signs: [sign(kind)] }), 'vehicle', 'pdd:18.2')).toHaveLength(1);
  });
  it('обычная соседняя полоса не становится выделенной', () => {
    expect(violated(run([moving({}, 1.75)]), 'vehicle', 'pdd:18.2')).toHaveLength(0);
  });
  it('одна разметка 1.23.1 не подменяет установленные пунктом знаки', () => {
    const ctx = run([moving()], { signs: [], markings: [{ id: 'bus-mark', kind: '1.23.1', pts: [{ x: 0, y: 5.25 }] }] });
    expect(violated(ctx, 'vehicle', 'pdd:18.2')).toHaveLength(0);
  });
  it('выход за измеренную продольную границу не продолжает полосу бесконечно', () => {
    const vehicle = moving();
    const ctx = context(sceneFor([vehicle], { roads: [road({ routeLanes: [lane({ toS: 150 })] })] }), timeline([vehicle]));
    expect(routeLaneAt(ctx, ctx.infos.get('vehicle')!, 0)).toBeNull();
  });
  it('связанный знак 5.14.3 завершает эту полосу', () => {
    const vehicle = observed('vehicle', [{ t: 0, x: 20, y: 5.25, h: 0, v: 10 }, { t: duration, x: 100, y: 5.25, h: 0, v: 10 }], { routeContext: { ...noExemption } });
    const scene = sceneFor([vehicle], { roads: [road({ routeLanes: [lane({ signIds: ['bus-sign', 'end'] })] })],
      signs: [sign(), sign('5.14.3', { id: 'end', x: 0, y: 5.25 })] });
    const ctx = context(scene, timeline([vehicle]));
    expect(routeLaneAt(ctx, ctx.infos.get('vehicle')!, 0)).toBeNull();
  });
  it('неизвестная причина полностью неподвижного положения не становится запрещённой остановкой', () => {
    const vehicle = observed('vehicle', [{ t: 0, x: 0, y: 5.25, h: 0, v: 0 }, { t: duration, x: 0, y: 5.25, h: 0, v: 0 }], { routeContext: { ...noExemption } });
    const ctx = run([vehicle]);
    expect(violated(ctx, 'vehicle', 'pdd:18.2')).toHaveLength(0);
    expect(withRef(ctx, 'vehicle', 'pdd:18.2').some(finding => finding.severity === 'contributing' && finding.trace?.stopCauseUnknown === true)).toBe(true);
  });
  it('предшествующее запрещённое движение по полосе не исчезает из-за последующей остановки', () => {
    const vehicle = observed('vehicle', [{ t: 0, x: -30, y: 5.25, h: 0, v: 10 }, { t: 2, x: -10, y: 5.25, h: 0, v: 0 },
      { t: duration, x: -10, y: 5.25, h: 0, v: 0 }], { routeContext: { ...noExemption } });
    expect(violated(run([vehicle]), 'vehicle', 'pdd:18.2')).toHaveLength(1);
  });
});

describe('18.2: допуски устанавливаются отдельно от каталожного типа', () => {
  it('обычный автомобиль при известных отрицательных исключениях не допущен', () => {
    expect(permission(moving())).toBe(false);
  });
  it('каталожный автобус без установленного регулярного маршрута не получает автоматический допуск', () => {
    const vehicle = moving({ type: 'bus', routeContext: { ...noExemption, regularService: undefined } });
    expect(permission(vehicle)).toBeNull();
    expect(violated(run([vehicle]), 'vehicle', 'pdd:18.2')).toHaveLength(0);
    expect(withRef(run([vehicle]), 'vehicle', 'pdd:18.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it.each(['bus', 'trolleybus', 'tram'] as const)('подтверждённый регулярный %s допущен', type => {
    expect(permission(moving({ type, routeContext: { ...noExemption, regularService: true } }))).toBe(true);
  });
  it('нерегулярный автобус при известных прочих исключениях не получает допуск от типа', () => {
    expect(permission(moving({ type: 'bus' }))).toBe(false);
  });
  it('школьный автобус допущен независимо от регулярности маршрута', () => {
    expect(permission(moving({ type: 'bus', routeContext: { ...noExemption, schoolBus: true } }))).toBe(true);
  });
  it('легковое такси допущено по установленному использованию', () => {
    expect(permission(moving({ routeContext: { ...noExemption, taxi: true } }))).toBe(true);
  });
  it('неизвестное использование легкового автомобиля как такси не считается отрицательным фактом', () => {
    expect(permission(moving({ routeContext: { ...noExemption, taxi: undefined } }))).toBeNull();
  });
  it.each(['moscow', 'saint-petersburg', 'sevastopol'] as const)('региональный допуск в %s учитывает полный установленный набор условий', federalCity => {
    const vehicle = moving({ type: 'bus', routeContext: { ...noExemption, regionalBusLaneEligible: true } });
    const scene = sceneFor([vehicle]); scene.env.federalCity = federalCity;
    expect(permission(vehicle, scene)).toBe(true);
  });
  it('региональное исключение не переносится в другой субъект', () => {
    expect(permission(moving({ type: 'bus', routeContext: { ...noExemption, regionalBusLaneEligible: true } }))).toBe(false);
  });
  it('велосипедисту разрешена правая полоса', () => {
    expect(permission(moving({ type: 'bicycle' }))).toBe(true);
  });
  it('велосипедисту не даётся то же исключение для левой полосы', () => {
    expect(permission(moving({ type: 'bicycle' }, 1.75), { roads: [road({ routeLanes: [lane({ offset: 1.75, rightmost: false })] })] })).toBe(false);
  });
});

function temporaryScenario(laneUse: 'turn' | 'enter-road' | 'passenger-stop', unimpeded?: boolean, boundary: RouteLane['boundary'] = 'dashed'): Ctx {
  const keys: Key[] = laneUse === 'turn' ? [
    { t: 0, x: -20, y: 5.25, h: 0, v: 5 }, { t: 2, x: -10, y: 5.25, h: 0, v: 5 },
    { t: 4, x: 0, y: 14, h: Math.PI / 2, v: 5 }, { t: duration, x: 0, y: 34, h: Math.PI / 2, v: 5 },
  ] : laneUse === 'enter-road' ? [
    { t: 0, x: -20, y: 14, h: 0, v: 5 }, { t: 2, x: -10, y: 5.25, h: 0, v: 5 },
    { t: 4, x: 0, y: 1.75, h: 0, v: 5 }, { t: duration, x: 20, y: 1.75, h: 0, v: 5 },
  ] : [
    { t: 0, x: -20, y: 5.25, h: 0, v: 5 }, { t: 2, x: -10, y: 5.25, h: 0, v: 0 },
    { t: 4, x: -10, y: 5.25, h: 0, v: 0 }, { t: 6, x: 0, y: 1.75, h: 0, v: 5 },
    { t: duration, x: 10, y: 1.75, h: 0, v: 5 },
  ];
  const vehicle = observed('vehicle', keys, { routeContext: { ...noExemption, laneUse, routeVehiclesUnimpeded: unimpeded } });
  return run([vehicle], { roads: [road({ routeLanes: [lane({ boundary })] })] });
}

describe('18.2: ограниченные заезды через прерывистую границу', () => {
  it.each(['turn', 'enter-road', 'passenger-stop'] as const)('%s с наблюдаемым манёвром и без помех допускается', laneUse => {
    expect(violated(temporaryScenario(laneUse, true), 'vehicle', 'pdd:18.2')).toHaveLength(0);
  });
  it.each(['turn', 'enter-road', 'passenger-stop'] as const)('%s с установленной помехой не даёт исключения', laneUse => {
    expect(violated(temporaryScenario(laneUse, false), 'vehicle', 'pdd:18.2')).toHaveLength(1);
  });
  it('неизвестная помеха при фактическом пассажирском манёвре не считается отсутствующей', () => {
    const ctx = temporaryScenario('passenger-stop');
    expect(violated(ctx, 'vehicle', 'pdd:18.2')).toHaveLength(0);
    expect(withRef(ctx, 'vehicle', 'pdd:18.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('сплошная граница не получает исключение прерывистой', () => {
    expect(violated(temporaryScenario('enter-road', true, 'solid'), 'vehicle', 'pdd:18.2')).toHaveLength(1);
  });
  it('проезд вдоль всей полосы после посадочной остановки не разрешается одним назначением laneUse', () => {
    const vehicle = observed('vehicle', [{ t: 0, x: -20, y: 5.25, h: 0, v: 0 },
      { t: 2, x: -20, y: 5.25, h: 0, v: 0 }, { t: duration, x: 70, y: 5.25, h: 0, v: 15 }],
      { routeContext: { ...noExemption, laneUse: 'passenger-stop', routeVehiclesUnimpeded: true } });
    expect(violated(run([vehicle]), 'vehicle', 'pdd:18.2').length).toBeGreaterThan(0);
  });
});

function busDeparture(type: Actor['type'] = 'bus', verified: boolean | undefined = false) {
  const bus = observed('bus', [{ t: 0, x: 0, y: 8, h: 0, v: 0 }, { t: 2, x: 0, y: 8, h: 0, v: 0 },
    { t: 4, x: 12, y: 5.25, h: 0, v: 6 }, { t: duration, x: 36, y: 5.25, h: 0, v: 6 }],
    { type, routeContext: { ...noExemption, departureStopId: 'stop', departureChecks: [{ otherId: 'ordinary', yieldingVerified: verified }] } });
  const ordinary = observed('ordinary', [{ t: 0, x: -28, y: 5.25, h: 0, v: 10 }, { t: duration, x: 52, y: 5.25, h: 0, v: 10 }], { routeContext: { ...noExemption } });
  const scene = sceneFor([ordinary, bus], { roads: [road()], signs: [sign('5.16', { id: 'stop-sign', x: 0, y: 9 })],
    routeStops: [{ id: 'stop', roadId: 'road', x: 0, y: 8, heading: 0, signId: 'stop-sign', source: 'Синтетическая остановка' }] });
  const tl = timeline([ordinary, bus], [{ a: 'ordinary', b: 'bus', t: 4 }]);
  return { bus, ordinary, scene, tl, ctx: context(scene, tl) };
}

describe('18.3: начало движения от обозначенной остановки', () => {
  it.each(['bus', 'trolleybus'] as const)('%s имеет приоритет в городе после фактической остановки', type => {
    const data = busDeparture(type);
    const relation = routePriority(data.ctx, 'ordinary', 'bus', data.tl.collisions[0]);
    expect(relation?.from).toBe('ordinary');
    expect(relation?.to).toBe('bus');
    expect(relation?.refs).toContain('pdd:18.3');
    expect(relation?.failureEstablished).toBe(true);
  });
  it('для 18.3 не выдумывается дополнительное условие регулярного маршрута', () => {
    const data = busDeparture();
    expect(data.bus.actor.routeContext!.regularService).toBe(false);
    expect(routePriority(data.ctx, 'ordinary', 'bus', data.tl.collisions[0])?.refs).toContain('pdd:18.3');
  });
  it('обязанности обоих водителей сохраняются при столкновении', () => {
    const data = busDeparture(), report = analyze(data.scene, data.tl);
    expect(report.rules.findings.some(finding => finding.actorId === 'ordinary' && finding.severity === 'violation'
      && finding.causal && finding.refs.includes('pdd:18.3'))).toBe(true);
    expect(report.rules.findings.some(finding => finding.actorId === 'bus' && finding.severity === 'violation'
      && finding.causal && finding.refs.includes('pdd:18.3'))).toBe(true);
  });
  it('неизвестная проверка уступания не становится известным отсутствием проверки', () => {
    const data = busDeparture();
    delete data.bus.actor.routeContext!.departureChecks![0].yieldingVerified;
    const report = analyze(data.scene, data.tl);
    expect(report.rules.findings.some(finding => finding.actorId === 'bus' && finding.severity === 'violation' && finding.refs.includes('pdd:18.3'))).toBe(false);
    expect(report.rules.findings.some(finding => finding.actorId === 'bus' && finding.severity === 'contributing' && finding.refs.includes('pdd:18.3'))).toBe(true);
  });
  it('за городом этот специальный приоритет не возникает', () => {
    const data = busDeparture(); data.scene.roads[0].zone = 'outside';
    const ctx = context(data.scene, data.tl);
    expect(routePriority(ctx, 'ordinary', 'bus', data.tl.collisions[0])).toBeNull();
  });
  it('грузовик не получает автобусный приоритет от остановочного знака', () => {
    const data = busDeparture('truck');
    expect(routePriority(data.ctx, 'ordinary', 'bus', data.tl.collisions[0])).toBeNull();
  });
  it('несвязанное место остановки не доказывает условия 18.3', () => {
    const data = busDeparture(); data.bus.actor.routeContext!.departureStopId = 'elsewhere';
    expect(routePriority(data.ctx, 'ordinary', 'bus', data.tl.collisions[0])).toBeNull();
  });
  it('движущийся с начала наблюдения автобус не считается отъезжающим по одному близкому знаку', () => {
    const data = busDeparture();
    const rolling = observed('bus', [{ t: 0, x: -12, y: 8, h: 0, v: 6 }, { t: duration, x: 36, y: 5.25, h: 0, v: 6 }],
      { type: data.bus.actor.type, routeContext: data.bus.actor.routeContext });
    const scene = sceneFor([data.ordinary, rolling], { roads: data.scene.roads, signs: data.scene.signs, routeStops: data.scene.routeStops });
    const tl = timeline([data.ordinary, rolling], [{ a: 'ordinary', b: 'bus', t: 4 }]);
    expect(routePriority(context(scene, tl), 'ordinary', 'bus', tl.collisions[0])).toBeNull();
  });
  it('неподтверждённый знак остановки не заменяется пустой коллекцией', () => {
    const data = busDeparture(); data.scene.signs = [];
    expect(routePriority(context(data.scene, data.tl), 'ordinary', 'bus', data.tl.collisions[0])).toBeNull();
  });
});

function crossingTram(depotExit: boolean | undefined = false) {
  const tram = observed('tram', [{ t: 0, x: 0, y: -30, h: Math.PI / 2, v: 7.5 }, { t: duration, x: 0, y: 30, h: Math.PI / 2, v: 7.5 }],
    { type: 'tram', routeContext: { depotExit } });
  const ordinary = observed('ordinary', [{ t: 0, x: -30, y: 1.75, h: 0, v: 7.5 }, { t: duration, x: 30, y: 1.75, h: 0, v: 7.5 }]);
  const scene = sceneFor([ordinary, tram], { roads: [road({ lanes: 1 })], signs: [], tracks: [{ id: 'tram-track', kind: 'tram',
    pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }], smooth: false, separated: false }] });
  const tl = timeline([ordinary, tram], [{ a: 'ordinary', b: 'tram', t: 4 }]);
  return { scene, tl, ctx: context(scene, tl), tram, ordinary };
}

describe('18.1: трамвай вне перекрёстка', () => {
  it('пересечение трамвайного пути с одной дорогой даёт трамваю преимущество', () => {
    const data = crossingTram(), relation = routePriority(data.ctx, 'ordinary', 'tram', data.tl.collisions[0]);
    expect(relation?.from).toBe('ordinary'); expect(relation?.to).toBe('tram');
    expect(relation?.refs).toContain('pdd:18.1');
  });
  it('установленный выезд из депо исключает именно это преимущество', () => {
    const data = crossingTram(true);
    expect(routePriority(data.ctx, 'ordinary', 'tram', data.tl.collisions[0])).toBeNull();
  });
  it('неизвестный выезд из депо не назначает установленное нарушение 18.1', () => {
    const data = crossingTram();
    delete data.tram.actor.routeContext!.depotExit;
    const report = analyze(data.scene, data.tl);
    expect(report.rules.findings.some(finding => finding.actorId === 'ordinary' && finding.severity === 'violation' && finding.refs.includes('pdd:18.1'))).toBe(false);
  });
  it('на перекрёстке двух дорог используется раздел 13, а не правило вне перекрёстков', () => {
    const data = crossingTram();
    data.scene.roads.push(road({ id: 'cross-road', lanes: 1, pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }));
    expect(routePriority(context(data.scene, data.tl), 'ordinary', 'tram', data.tl.collisions[0])).toBeNull();
  });
  it('железнодорожный состав не получает трамвайное преимущество 18.1', () => {
    const data = crossingTram(); data.tram.actor.railwayTrain = { mass: 100000, length: 20, width: 3, brakeDecel: 0.7, source: 'Синтетические параметры' };
    expect(routePriority(data.ctx, 'ordinary', 'tram', data.tl.collisions[0])).toBeNull();
  });
});

describe('маршрутные исключения знаков и исправление остановочной разметки', () => {
  it.each(['3.1', '3.2', '3.3', '3.18.1', '3.18.2', '3.19', '3.34', '5.15.1', '5.15.2'])('%s не действует на подтверждённый маршрутный автобус', kind => {
    const vehicle = moving({ type: 'bus', routeContext: { regularService: true } });
    const ctx = context(sceneFor([vehicle]), timeline([vehicle]));
    expect(routeSignException(ctx, ctx.infos.get('vehicle')!, sign(kind), 0)).toBe(true);
  });
  it('неизвестная регулярность сохраняет неопределённость исключения', () => {
    const vehicle = moving({ type: 'bus', routeContext: {} }), ctx = context(sceneFor([vehicle]), timeline([vehicle]));
    expect(routeSignException(ctx, ctx.infos.get('vehicle')!, sign('3.1'), 0)).toBeNull();
  });
  it('обычный нерегулярный автобус не освобождается от запрещающего знака', () => {
    const vehicle = moving({ type: 'bus' }), ctx = context(sceneFor([vehicle]), timeline([vehicle]));
    expect(routeSignException(ctx, ctx.infos.get('vehicle')!, sign('3.1'), 0)).toBe(false);
  });
  it('маршрутное исключение не переносится на знак 3.24', () => {
    const vehicle = moving({ type: 'bus', routeContext: { regularService: true } }), ctx = context(sceneFor([vehicle]), timeline([vehicle]));
    expect(routeSignException(ctx, ctx.infos.get('vehicle')!, sign('3.24', { value: 20 }), 0)).toBe(false);
  });
  it.each(['1.17.1', '1.17.2'])('%s обозначает остановочное место, а не абсолютный запрет остановки', kind => {
    expect(MARKING_BY_ID[kind].noStop).not.toBe(true);
  });
  it('1.17.2 соответствует трамвайной остановке, а не стоянке такси', () => {
    expect(MARKING_BY_ID['1.17.2'].name.toLowerCase()).toContain('трамва');
    expect(MARKING_BY_ID['1.17.2'].name.toLowerCase()).not.toContain('такси');
  });
});

describe('12.17: место и субъект квалификации', () => {
  it.each([
    ['moscow', 'koap:12.17#1.2'], ['saint-petersburg', 'koap:12.17#1.2'],
    ['sevastopol', 'koap:12.17#1.1'], ['other', 'koap:12.17#1.1'],
  ] as const)('%s выбирает %s по установленному месту', (federalCity, expected) => {
    const vehicle = moving(), scene = sceneFor([vehicle]); scene.env.federalCity = federalCity;
    const report = analyze(scene, timeline([vehicle]));
    const finding = report.findings.find(finding => finding.actorId === 'vehicle' && finding.severity === 'violation' && finding.refs.includes('pdd:18.2'));
    expect(finding?.refs).toContain(expected);
    expect(finding?.refs).not.toContain(expected === 'koap:12.17#1.1' ? 'koap:12.17#1.2' : 'koap:12.17#1.1');
  });
  it('неизвестный город не выбирает автоматически меньшую часть', () => {
    const vehicle = moving(), scene = sceneFor([vehicle]); delete scene.env.federalCity;
    const report = analyze(scene, timeline([vehicle]));
    const findings = report.findings.filter(finding => finding.actorId === 'vehicle' && finding.refs.includes('pdd:18.2'));
    expect(findings.some(finding => finding.severity === 'violation')).toBe(true);
    expect(findings.flatMap(finding => finding.refs).filter(ref => ref.startsWith('koap:12.17'))).toEqual([]);
  });
  it('неуступание автобусу по 18.3 не подменяется самостоятельным составом для его водителя', () => {
    const data = busDeparture(), report = analyze(data.scene, data.tl);
    expect(report.findings.some(finding => finding.actorId === 'ordinary' && finding.refs.includes('pdd:18.3') && finding.refs.includes('koap:12.17#1'))).toBe(true);
    expect(report.findings.some(finding => finding.actorId === 'bus' && finding.refs.includes('pdd:18.3') && finding.refs.includes('koap:12.17#1'))).toBe(false);
  });
});
