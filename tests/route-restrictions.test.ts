import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/analysis/context';
import { boxAt, posAt, prepare } from '../src/analysis/technical';
import { checkMarkingRules, checkSignRules, type Kit } from '../src/restrictions';
import { emptyScene, type Actor, type RouteContext, type Sign, type VehicleType } from '../src/scene';
import { DT, type Timeline, type Track } from '../src/sim';

/** Independent observations of a right turn or a stop after an active sign.
 * The active sign gate is supplied as measured input to the restriction layer. */
function measured(type: VehicleType, facts: RouteContext | undefined, motion: 'turn' | 'stop' = 'turn'): Ctx {
  const scene = emptyScene();
  scene.env.duration = 8;
  scene.roads = [{ id: 'road', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 2,
    center: 'dashed', oneWay: false, smooth: false, zone: 'city' }];
  if (motion === 'turn') scene.roads.push({ id: 'cross-road', pts: [{ x: 21.75, y: -100 }, { x: 21.75, y: 100 }],
    lanes: 2, center: 'dashed', oneWay: false, smooth: false, zone: 'city' });
  const actor: Actor = { id: 'vehicle', kind: 'vehicle', type, x: 0, y: 1.75, heading: 0,
    speed: 36, delay: 0, color: '#28b', flags: { drunk: false, noLicense: false, flees: false },
    routeContext: facts, path: motion === 'turn'
      ? [{ x: 20, y: 1.75, v: 36 }, { x: 20, y: 61.75, v: 36 }]
      : [{ x: 20, y: 1.75, v: 0, hold: 8 }] };
  scene.actors = [actor];
  const n = Math.round(8 / DT) + 1;
  const track: Track = { id: actor.id, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n),
    v: new Float32Array(n), present: new Uint8Array(n).fill(1), free: new Uint8Array(n) };
  for (let frame = 0; frame < n; frame++) {
    const time = frame * DT;
    track.x[frame] = Math.min(20, time * 10);
    track.y[frame] = motion === 'turn' ? 1.75 + Math.max(0, time - 2) * 10 : 1.75;
    track.h[frame] = motion === 'turn' && time >= 2 ? Math.PI / 2 : 0;
    track.v[frame] = motion === 'stop' && time >= 2 ? 0 : 10;
  }
  const timeline: Timeline = { dt: DT, n, duration: 8, mu: 0.7, tracks: new Map([[actor.id, track]]), collisions: [] };
  return { ...prepare(scene, timeline), findings: [], events: [], priorityGraphs: [], onc: new Map(),
    lightViolations: new Map(), stopSkipped: new Map(), pedEntry: new Map() };
}
function kit(ctx: Ctx): Kit {
  return { add: finding => {
    const full = { causal: false, ...finding };
    ctx.findings.push(full);
    return full;
  }, boxAt, posAt, reasonToBrake: () => false };
}
function signs(ctx: Ctx, kind: string): Ctx {
  const sign: Sign = { id: 'control', kind, x: 0, y: 8, angle: 0 };
  ctx.scene.signs.push(sign);
  ctx.gates = [{ actorId: 'vehicle', sign, frame: 0, dist: 0 }];
  checkSignRules(ctx, kit(ctx));
  return ctx;
}
const findings = (ctx: Ctx, ref: string) => ctx.findings.filter(finding => finding.refs.includes(ref));

describe('маршрутный статус применяется в фактической проверке знаков', () => {
  it.each(['3.2', '3.3'])('нерегулярный трамвай не получает категориальное освобождение от %s', kind => {
    const ctx = signs(measured('tram', { regularService: false }), kind);
    expect(findings(ctx, `sign:${kind}`).some(finding => finding.severity === 'violation')).toBe(true);
  });
  it.each(['3.2', '3.3'])('неустановленный маршрут трамвая даёт неопределённость %s', kind => {
    const ctx = signs(measured('tram', {}), kind);
    expect(findings(ctx, `sign:${kind}`).some(finding => finding.severity === 'contributing')).toBe(true);
    expect(findings(ctx, `sign:${kind}`).some(finding => finding.severity === 'violation')).toBe(false);
  });
  it.each(['bus', 'tram'] as const)('подтверждённый маршрут %s освобождается от 3.18.1', type => {
    const ctx = signs(measured(type, { regularService: true }), '3.18.1');
    expect(findings(ctx, 'sign:3.18.1').some(finding => finding.severity === 'info')).toBe(true);
  });
  it.each(['bus', 'tram'] as const)('группа 4 освобождает маршрутный %s от 4.1.1 и без выделенки', type => {
    const ctx = signs(measured(type, { regularService: true }), '4.1.1');
    expect(findings(ctx, 'sign:4.1.1').some(finding => finding.severity === 'info')).toBe(true);
    expect(findings(ctx, 'sign:4.1.1').some(finding => finding.severity === 'violation')).toBe(false);
  });
  it('маршрутность не отменяет стрелу разметки 1.18', () => {
    const ctx = measured('tram', { regularService: true });
    ctx.scene.markings = [{ id: 'arrow', kind: '1.18', pts: [{ x: 0, y: 1.75 }], angle: 0, variant: 'straight' }];
    checkMarkingRules(ctx, kit(ctx));
    expect(findings(ctx, 'marking:1.18').some(finding => finding.severity === 'violation')).toBe(true);
  });
  it('маршрутность не отменяет габаритное ограничение', () => {
    const ctx = measured('tram', { regularService: true });
    ctx.scene.signs = [{ id: 'height', kind: '3.13', x: 0, y: 8, angle: 0, value: 1 }];
    ctx.gates = [{ actorId: 'vehicle', sign: ctx.scene.signs[0], frame: 0, dist: 0 }];
    checkSignRules(ctx, kit(ctx));
    expect(findings(ctx, 'sign:3.13').some(finding => finding.severity === 'violation')).toBe(true);
  });
  it.each(['5.15.1', '5.15.2'])('%s без заданных стрел не превращается в придуманное нарушение', kind => {
    const ctx = signs(measured('car', { taxi: false }), kind);
    const result = findings(ctx, `sign:${kind}`);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('contributing');
    expect(result[0].refs).toEqual([`sign:${kind}`]);
    expect(result[0].trace).toMatchObject({ missingSignDirections: true, compliance: 'не определить' });
  });
  it.each(['5.15.1', '5.15.2'])('%s сохраняет установленное маршрутное исключение', kind => {
    const ctx = signs(measured('bus', { regularService: true }), kind);
    expect(findings(ctx, `sign:${kind}`).some(finding => finding.severity === 'info'
      && finding.trace?.compliance === 'выполнено')).toBe(true);
  });
});

describe('3.27: соответствующий вид обозначенного места обязателен', () => {
  function stopped(type: VehicleType, facts: RouteContext, marker: string) {
    const ctx = measured(type, facts, 'stop');
    const stop = { id: 'stop', roadId: 'road', x: 20, y: 1.75, heading: 0 };
    if (marker.startsWith('5.')) {
      ctx.scene.signs.push({ id: 'stop-marker', kind: marker, x: 20, y: 8, angle: 0 });
      ctx.scene.routeStops = [{ ...stop, signId: 'stop-marker' }];
    } else {
      ctx.scene.markings.push({ id: 'stop-marker', kind: marker, pts: [{ x: 10, y: 3 }, { x: 30, y: 3 }] });
      ctx.scene.routeStops = [{ ...stop, markingId: 'stop-marker' }];
    }
    return signs(ctx, '3.27');
  }
  it.each([
    ['bus', { regularService: true }, '5.16'],
    ['tram', { regularService: true }, '5.17'],
    ['car', { taxi: true }, '5.18'],
    ['bus', { regularService: true }, '1.17.1'],
  ] as const)('%s с фактами %j получает исключение в месте %s', (type, facts, marker) => {
    const ctx = stopped(type, facts, marker);
    expect(findings(ctx, 'sign:3.27').some(finding => finding.severity === 'info')).toBe(true);
    expect(findings(ctx, 'sign:3.27').some(finding => finding.severity === 'violation')).toBe(false);
  });
  it.each([
    ['bus', { regularService: true }, '5.18'],
    ['car', { taxi: true }, '5.16'],
    ['tram', { regularService: true }, '1.17.2'],
  ] as const)('%s с фактами %j не получает исключение 3.27 по обозначению %s', (type, facts, marker) => {
    const ctx = stopped(type, facts, marker);
    expect(findings(ctx, 'sign:3.27').some(finding => finding.severity === 'violation')).toBe(true);
  });
});
