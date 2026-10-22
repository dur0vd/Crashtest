import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/analysis/context';
import { checkRouteTransport, continuesRouteLane } from '../src/analysis/route-transport';
import { prepare } from '../src/analysis/technical';
import { angDiff } from '../src/geom';
import { emptyScene, type Actor, type Road, type RouteContext, type RouteLane, type Scene } from '../src/scene';
import { DT, type Timeline, type Track } from '../src/sim';

// Independently authored positions and speeds. These observations do not use
// the simulator's path follower to establish the legal manoeuvre under test.
type Key = { t: number; x: number; y: number; h: number; v: number };
const duration = 20;
const noExemption: RouteContext = { regularService: false, schoolBus: false, taxi: false, regionalBusLaneEligible: false };
const lane = (options: Partial<RouteLane> = {}): RouteLane => ({ id: 'route-lane', fromS: 0, toS: 400,
  offset: 5.25, width: 3.5, direction: 'forward', signIds: ['route-sign'], boundary: 'dashed', rightmost: true,
  source: 'Условная геометрия независимого теста', ...options });
const road = (options: Partial<Road> = {}): Road => ({ id: 'road', pts: [{ x: -200, y: 0 }, { x: 200, y: 0 }],
  lanes: 2, center: 'dashed', oneWay: false, smooth: false, zone: 'city', routeLanes: [lane()], ...options });

function measured(keys: Key[], routeContext: RouteContext, roads: Road[] = [road()]): Ctx {
  const first = keys[0];
  const actor: Actor = { id: 'vehicle', kind: 'vehicle', type: 'car', x: first.x, y: first.y, heading: first.h,
    speed: first.v * 3.6, color: '#3a8', delay: 0, flags: { drunk: false, noLicense: false, flees: false },
    path: keys.slice(1).map(key => ({ x: key.x, y: key.y, v: key.v * 3.6 })), routeContext };
  const scene: Scene = { ...emptyScene(), env: { accidentDate: '2026-10-21T12:00', duration, surface: 'dry', federalCity: 'other' },
    roads, actors: [actor], signs: [{ id: 'route-sign', kind: '5.14.1', x: -150, y: 8, angle: 0 }] };
  const n = Math.round(duration / DT) + 1;
  const track: Track = { id: actor.id, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n),
    v: new Float32Array(n), present: new Uint8Array(n).fill(1), free: new Uint8Array(n), waypointTimes: keys.slice(1).map(key => key.t) };
  for (let frame = 0; frame < n; frame++) {
    const time = frame * DT;
    let index = keys.findIndex((key, i) => i > 0 && key.t > time);
    if (index < 0) index = keys.length - 1;
    const a = keys[index - 1], b = keys[index];
    const fraction = Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
    track.x[frame] = a.x + (b.x - a.x) * fraction;
    track.y[frame] = a.y + (b.y - a.y) * fraction;
    track.h[frame] = a.h + angDiff(a.h, b.h) * fraction;
    track.v[frame] = a.v + (b.v - a.v) * fraction;
  }
  const timeline: Timeline = { dt: DT, n, duration, mu: 0.7, tracks: new Map([[actor.id, track]]), collisions: [] };
  const ctx: Ctx = { ...prepare(scene, timeline), findings: [], events: [], priorityGraphs: [],
    onc: new Map(), lightViolations: new Map(), stopSkipped: new Map(), pedEntry: new Map() };
  return ctx;
}
const violations = (ctx: Ctx) => {
  checkRouteTransport(ctx, finding => ctx.findings.push({ causal: false, ...finding }));
  return ctx.findings.filter(finding => finding.actorId === 'vehicle' && finding.severity === 'violation' && finding.refs.includes('pdd:18.2'));
};

describe('18.2: временное использование определяется наблюдаемым манёвром', () => {
  it('медленное сквозное движение после въезда не получает бессрочный допуск', () => {
    const ctx = measured([
      { t: 0, x: -20, y: 14, h: 0, v: 2 },
      { t: 4, x: -12, y: 5.25, h: 0, v: 2 },
      { t: duration, x: 20, y: 5.25, h: 0, v: 2 },
    ], { ...noExemption, laneUse: 'enter-road', routeVehiclesUnimpeded: true });
    expect(violations(ctx).some(finding => finding.t !== undefined && finding.t > 4)).toBe(true);
  });

  it('посадочная остановка включает непосредственный выход в общую полосу без помех', () => {
    const ctx = measured([
      { t: 0, x: -40, y: 1.75, h: 0, v: 10 },
      { t: 1, x: -30, y: 5.25, h: 0, v: 10 },
      { t: 3, x: -20, y: 5.25, h: 0, v: 0 },
      { t: 5, x: -20, y: 5.25, h: 0, v: 0 },
      { t: 7, x: -10, y: 1.75, h: 0, v: 7 },
      { t: duration, x: 81, y: 1.75, h: 0, v: 7 },
    ], { ...noExemption, laneUse: 'passenger-stop', routeVehiclesUnimpeded: true });
    expect(violations(ctx)).toHaveLength(0);
  });

  it('флаг поворота не создаёт неопределённое исключение при наблюдаемом прямом транзите', () => {
    const ctx = measured([
      { t: 0, x: -30, y: 5.25, h: 0, v: 4 },
      { t: duration, x: 50, y: 5.25, h: 0, v: 4 },
    ], { ...noExemption, laneUse: 'turn' });
    expect(violations(ctx)).toHaveLength(1);
  });

  it('следование изгибу той же дороги не превращается в поворот для исключения', () => {
    const curved = road({ pts: [{ x: -100, y: 0 }, { x: 0, y: 0 }, { x: 80, y: 80 }],
      routeLanes: [lane({ toS: 210 })] });
    const ctx = measured([
      { t: 0, x: -20, y: 5.25, h: 0, v: 8 },
      { t: 1, x: -5, y: 5.25, h: 0, v: 8 },
      { t: 3, x: 10.43, y: 17.85, h: Math.PI / 4, v: 8 },
      { t: duration, x: 50, y: 57.42, h: Math.PI / 4, v: 4 },
    ], { ...noExemption, laneUse: 'turn', routeVehiclesUnimpeded: true }, [curved]);
    const findings = violations(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].t).toBe(0);
  });
});

describe('18.2: исключение направляющих знаков требует продолжения по полосе после перекрёстка', () => {
  const junctionRoads = () => [
    road({ pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], routeLanes: [lane({ toS: 200 })] }),
    road({ id: 'cross-road', pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }], routeLanes: undefined }),
  ];
  it('нескольких метров в полосе до перекрёстка недостаточно для последующего выезда с неё', () => {
    const ctx = measured([
      { t: 0, x: -15, y: 5.25, h: 0, v: 5 },
      { t: 2, x: -5, y: 5.25, h: 0, v: 5 },
      { t: 3, x: 0, y: 5.25, h: 0, v: 5 },
      { t: 6, x: 5.25, y: -10, h: -Math.PI / 2, v: 5 },
      { t: duration, x: 5.25, y: -80, h: -Math.PI / 2, v: 5 },
    ], { ...noExemption, taxi: true }, junctionRoads());
    expect(continuesRouteLane(ctx, ctx.infos.get('vehicle')!, 0)).toBe(false);
  });

  it('наблюдаемое продолжение той же выделенной полосы после перекрёстка учитывается', () => {
    const ctx = measured([
      { t: 0, x: -15, y: 5.25, h: 0, v: 5 },
      { t: duration, x: 85, y: 5.25, h: 0, v: 5 },
    ], { ...noExemption, taxi: true }, junctionRoads());
    expect(continuesRouteLane(ctx, ctx.infos.get('vehicle')!, 0)).toBe(true);
  });
});
