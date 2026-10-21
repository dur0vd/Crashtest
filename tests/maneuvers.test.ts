import { describe, expect, it } from 'vitest';
import { checkManeuvers } from '../src/analysis/maneuvers';
import { prepare, collectGates } from '../src/analysis/technical';
import { buildPriorityGraphs } from '../src/analysis/intersections';
import { roadsAt } from '../src/geo';
import { angDiff, dot, fromAngle } from '../src/geom';
import { emptyScene, type Actor, type Road, type Scene, type TurnSignal } from '../src/scene';
import { DT, type Collision, type Timeline, type Track } from '../src/sim';
import type { Ctx } from '../src/analysis/context';
import type { DraftFinding } from '../src/analysis/types';
import pdd from '../src/data/pdd.json';

/** Observed tracks are deliberately independent of the path follower. They represent
 * measured positions, courses, speeds and arrival times rather than desired motion. */
type Key = { t: number; x: number; y: number; h?: number; v?: number; reverse?: boolean; signal?: TurnSignal; signalAt?: number };
type Observed = { actor: Actor; keys: Key[] };
const duration = 12;
function road(id = 'main', options: Partial<Road> = {}): Road {
  return { id, pts: [{ x: -150, y: 0 }, { x: 150, y: 0 }], lanes: 1, center: 'dashed', oneWay: false,
    zone: 'city', smooth: false, ...options };
}
function observed(id: string, keys: Key[], options: Partial<Actor> = {}): Observed {
  const first = keys[0], second = keys[1] ?? { ...first, x: first.x + 1 };
  const heading = first.h ?? Math.atan2(second.y - first.y, second.x - first.x);
  const speed = first.v ?? Math.hypot(second.x - first.x, second.y - first.y) / (second.t - first.t);
  const actor: Actor = { id, kind: 'vehicle', type: 'car', x: first.x, y: first.y, heading,
    speed: speed * 3.6 * (first.reverse ? -1 : 1), delay: 0, color: '#2288dd',
    path: keys.slice(1).map(k => ({ x: k.x, y: k.y, v: (k.v ?? speed) * 3.6 * (k.reverse ? -1 : 1), signal: k.signal ?? 'none', signalAt: k.signalAt })),
    flags: { drunk: false, noLicense: false, flees: false }, ...options };
  return { actor, keys };
}
function makeScene(specs: Observed[], roads: Road[] = [road()]): Scene {
  const scene = emptyScene();
  scene.env.accidentDate = '2026-10-20T12:00';
  scene.env.duration = duration;
  scene.roads = roads;
  scene.actors = specs.map(s => s.actor);
  return scene;
}
function trackFor(spec: Observed, n: number): Track {
  const track: Track = { id: spec.actor.id, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n),
    v: new Float32Array(n), present: new Uint8Array(n).fill(1), free: new Uint8Array(n), reversing: new Uint8Array(n),
    waypointTimes: spec.keys.slice(1).map(k => k.t) };
  for (let frame = 0; frame < n; frame++) {
    const time = frame * DT;
    let index = spec.keys.findIndex((k, i) => i > 0 && k.t > time);
    if (index < 0) index = spec.keys.length - 1;
    const a = spec.keys[Math.max(0, index - 1)], b = spec.keys[index];
    const fraction = Math.max(0, Math.min(1, (time - a.t) / Math.max(DT, b.t - a.t)));
    track.x[frame] = a.x + (b.x - a.x) * fraction;
    track.y[frame] = a.y + (b.y - a.y) * fraction;
    const tangent = Math.atan2(b.y - a.y, b.x - a.x);
    track.h[frame] = a.h !== undefined && b.h !== undefined ? a.h + angDiff(a.h, b.h) * fraction : a.h ?? tangent;
    const actual = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(DT, b.t - a.t);
    track.v[frame] = a.v !== undefined && b.v !== undefined ? a.v + (b.v - a.v) * fraction : a.v ?? actual;
    track.reversing![frame] = a.reverse || b.reverse ? 1 : 0;
  }
  return track;
}
function run(scene: Scene, specs: Observed[], contacts: { a: string; b: string; t: number }[] = []): Ctx {
  const n = Math.round(duration / DT) + 1;
  const tracks = new Map(specs.map(spec => [spec.actor.id, trackFor(spec, n)]));
  const collisions: Collision[] = contacts.map((contact, index) => {
    const frame = Math.round(contact.t / DT), a = tracks.get(contact.a)!, b = tracks.get(contact.b)!;
    const velocity = (track: Track) => ({ x: Math.cos(track.h[frame]) * track.v[frame] * (track.reversing?.[frame] ? -1 : 1),
      y: Math.sin(track.h[frame]) * track.v[frame] * (track.reversing?.[frame] ? -1 : 1) });
    const vA = velocity(a), vB = velocity(b);
    return { idx: index, frame, t: contact.t, a: contact.a, b: contact.b, kind: 'vv',
      point: { x: (a.x[frame] + b.x[frame]) / 2, y: (a.y[frame] + b.y[frame]) / 2 }, n: { x: 1, y: 0 },
      vA, vB, rel: Math.hypot(vA.x - vB.x, vA.y - vB.y), dvA: 0, dvB: 0 };
  });
  const timeline: Timeline = { dt: DT, n, duration, mu: 0.7, tracks, collisions };
  const ctx: Ctx = { ...prepare(scene, timeline), findings: [], priorityGraphs: [], events: [], onc: new Map(),
    lightViolations: new Map(), stopSkipped: new Map(), pedEntry: new Map() };
  collectGates(ctx);
  ctx.priorityGraphs = buildPriorityGraphs(ctx);
  for (const info of ctx.infos.values()) {
    const frames: number[] = [];
    for (let k = info.k0; k <= info.kEnd; k++) {
      const hit = roadsAt(ctx.geo, { x: info.tr.x[k], y: info.tr.y[k] })[0];
      if (!hit || hit.rg.road.oneWay) continue;
      const forward = dot(fromAngle(info.tr.h[k]), hit.near.tangent) >= 0;
      if ((forward ? hit.near.d : -hit.near.d) < -0.2) frames.push(k);
    }
    if (frames.length) ctx.onc.set(info.a.id, { frames, center: 'dashed', lanes: 1, tramTrack: false });
  }
  checkManeuvers(ctx, finding => ctx.findings.push({ causal: false, ...finding } as DraftFinding));
  return ctx;
}
const violates = (ctx: Ctx, ref: string, actor = 'a') => ctx.findings.some(f => f.actorId === actor && f.severity === 'violation' && f.refs.includes(ref));
const findings = (ctx: Ctx, ref: string, actor = 'a') => ctx.findings.filter(f => f.actorId === actor && f.refs.includes(ref));
function laneChange(signal: 'correct' | 'none' | 'late' | 'forgot' = 'correct'): Observed {
  const start = signal === 'late' ? 3.5 : 0;
  const indicator: TurnSignal = signal === 'none' ? 'none' : 'right';
  return observed('a', [
    { t: 0, x: -30, y: 1.75 },
    { t: 4, x: -20, y: 1.75, signal: indicator, signalAt: start },
    { t: 6, x: -15, y: 5.25, signal: indicator, signalAt: start },
    { t: 12, x: 0, y: 5.25, signal: signal === 'forgot' ? 'right' : 'none', signalAt: signal === 'forgot' ? start : 6.1 },
  ]);
}
function turn(right: boolean, lateral: number, correctExit = true, options: Partial<Actor> = {}): Observed {
  const exitX = right ? correctExit ? -1.75 : 1.75 : correctExit ? 1.75 : -1.75;
  const exitY = right ? 35 : -35;
  return observed('a', [{ t: 0, x: -30, y: lateral },
    { t: 4, x: -5, y: lateral, signal: right ? 'right' : 'left', signalAt: 0 },
    { t: 6, x: exitX, y: right ? 8 : -8, signal: right ? 'right' : 'left', signalAt: 0 },
    { t: 12, x: exitX, y: exitY, signal: 'none', signalAt: 6.1 }], options);
}
function crossroads(): Road[] {
  return [road('main', { lanes: 2 }), road('cross', { pts: [{ x: 0, y: -80 }, { x: 0, y: 80 }] })];
}
function uturn(): Observed {
  return observed('a', [{ t: 0, x: -25, y: 1.75, h: 0 },
    { t: 4, x: -2, y: 1.75, h: 0, signal: 'left', signalAt: 0 },
    { t: 4.5, x: 0, y: 1, h: -Math.PI / 3, signal: 'left', signalAt: 0 },
    { t: 5, x: 0, y: -1, h: -2 * Math.PI / 3, signal: 'left', signalAt: 0 },
    { t: 5.5, x: -2, y: -1.75, h: -Math.PI, signal: 'none', signalAt: 5.5 },
    { t: 12, x: -40, y: -1.75, h: -Math.PI, signal: 'none', signalAt: 5.5 }]);
}
function overtaking(options: Partial<Actor> = {}, passingOnly = false): Observed[] {
  const y = passingOnly ? 5.25 : -1.75;
  const a = observed('a', [{ t: 0, x: -30, y: 1.75 },
    { t: 2, x: -18, y, signal: passingOnly ? 'right' : 'left', signalAt: 0 },
    { t: 8, x: 18, y, signal: 'right', signalAt: 6 },
    { t: 10, x: 30, y: 1.75, signal: 'none', signalAt: 10 },
    { t: 12, x: 42, y: 1.75, signal: 'none', signalAt: 10 }],
  { maneuverContext: { oncomingClear: true, overtakeReturnClear: true }, ...options });
  const b = observed('b', [{ t: 0, x: -8, y: 1.75 }, { t: 12, x: 16, y: 1.75 }]);
  return [a, b];
}

describe('разделы 8 и 11 сверяются с локальным корпусом', () => {
  it.each(['8.1','8.2','8.3','8.4','8.5','8.6','8.7','8.8','8.9','8.10','8.11','8.12','11.1','11.2','11.3','11.4','11.5','11.6','11.7'])('источник содержит п. %s', id => {
    expect(pdd.sections.flatMap(s => s.points).find(point => point.id === id)?.text.length).toBeGreaterThan(30);
  });
});

describe('8.1–8.2: указатели и сигнал рукой', () => {
  it.each([true,false])('начало движения со стоянки: соответствующий сигнал установлен=%s', signalled => {
    const a = observed('a',[{t:0,x:-20,y:1.75,v:0},{t:3,x:-20,y:1.75,v:0,signal:signalled?'left':'none',signalAt:0},
      {t:8,x:0,y:1.75,v:4,signal:'none',signalAt:4},{t:12,x:16,y:1.75,v:4,signal:'none',signalAt:4}]);
    expect(violates(run(makeScene([a]),[a]),'pdd:8.1')).toBe(!signalled);
  });
  it('обычная остановка автомобиля без данных о стоп-сигналах не доказывает неподачу', () => {
    const a = observed('a',[{t:0,x:-20,y:1.75,v:4},{t:4,x:-12,y:1.75,v:0},{t:12,x:-12,y:1.75,v:0}]);
    const ctx = run(makeScene([a]),[a]);
    expect(violates(ctx,'pdd:8.1')).toBe(false);
    expect(findings(ctx,'pdd:8.1').some(f=>f.trace?.compliance==='не определить')).toBe(true);
  });
  it.each(['stop','none'] as const)('велосипедист подаёт перед остановкой сигнал рукой: %s', handSignal => {
    const a = observed('a',[{t:0,x:-20,y:1.75,v:4},{t:4,x:-12,y:1.75,v:0},{t:12,x:-12,y:1.75,v:0}],
      {type:'bicycle',maneuverContext:{indicatorsUnavailable:true,handSignal}});
    expect(violates(run(makeScene([a]),[a]),'pdd:8.1')).toBe(handSignal==='none');
  });
  it('отсутствие сигнала перед наблюдаемым перестроением нарушает 8.1', () => {
    const spec = laneChange('none');
    expect(violates(run(makeScene([spec], [road('main', { lanes: 2 })]), [spec]), 'pdd:8.1')).toBe(true);
  });
  it('заблаговременный сигнал и выключение после перестроения соблюдают 8.1–8.2', () => {
    const spec = laneChange();
    const ctx = run(makeScene([spec], [road('main', { lanes: 2 })]), [spec]);
    expect(violates(ctx, 'pdd:8.1')).toBe(false);
    expect(violates(ctx, 'pdd:8.2')).toBe(false);
  });
  it('короткое опережение сигнала отмечается как модельная неопределённость, без автоматического штрафного code', () => {
    const spec = laneChange('late');
    const ctx = run(makeScene([spec], [road('main', { lanes: 2 })]), [spec]);
    const late = findings(ctx, 'pdd:8.2').find(f => f.severity === 'contributing');
    expect(late).toBeDefined();
    expect(late!.refs).not.toContain('rule:indicator');
  });
  it('сигнал не прекращён после манёвра: 8.2 без автоматической квалификации неподачи', () => {
    const spec = laneChange('forgot');
    const ctx = run(makeScene([spec], [road('main', { lanes: 2 })]), [spec]);
    const forgotten = findings(ctx, 'pdd:8.2').find(f => f.severity === 'violation');
    expect(forgotten).toBeDefined();
    expect(forgotten!.refs).not.toContain('rule:indicator');
  });
  it('при неисправных указателях допустимый сигнал рукой не считается неподачей', () => {
    const spec = laneChange('none');
    spec.actor.maneuverContext = { indicatorsUnavailable: true, handSignal: 'right' };
    expect(violates(run(makeScene([spec], [road('main', { lanes: 2 })]), [spec]), 'pdd:8.1')).toBe(false);
  });
  it('если указатели отсутствуют, а данные о руке неизвестны, нарушение не выдумывается', () => {
    const spec = laneChange('none');
    spec.actor.maneuverContext = { indicatorsUnavailable: true };
    const ctx = run(makeScene([spec], [road('main', { lanes: 2 })]), [spec]);
    expect(violates(ctx, 'pdd:8.1')).toBe(false);
    expect(findings(ctx, 'pdd:8.1').some(f => f.severity === 'contributing')).toBe(true);
  });
});

describe('8.5–8.7: крайнее положение и сторона выезда', () => {
  it('левый поворот с правой полосы нарушает требование крайнего положения', () => {
    const a = turn(false, 5.25);
    expect(violates(run(makeScene([a], crossroads()), [a]), 'pdd:8.5')).toBe(true);
  });
  it('левый поворот из крайнего левого положения не нарушает 8.5', () => {
    const a = turn(false, 1.75);
    expect(violates(run(makeScene([a], crossroads()), [a]), 'pdd:8.5')).toBe(false);
  });
  it('длинномер с установленной невозможностью и без помех использует исключение 8.7', () => {
    const a = turn(false, 5.25, true, { type: 'bus', maneuverContext: { longVehicleException: true, cannotKeepExtreme: true } });
    const ctx = run(makeScene([a], crossroads()), [a]);
    expect(violates(ctx, 'pdd:8.5')).toBe(false);
    expect(violates(ctx, 'pdd:8.7')).toBe(false);
  });
  it('одного названия длинномерного ТС без факта невозможности недостаточно для исключения', () => {
    const a = turn(false, 5.25, true, { type: 'bus' });
    expect(violates(run(makeScene([a], crossroads()), [a]), 'pdd:8.5')).toBe(true);
  });
  it('исключение 8.7 не разрешает длинномерному создавать фактическую помеху', () => {
    const a = turn(false, 5.25, true, {type:'bus',maneuverContext:{longVehicleException:true,cannotKeepExtreme:true}});
    const b = observed('b',[{t:0,x:1.75,y:-8,h:-Math.PI/2,v:0},{t:12,x:1.75,y:-8,h:-Math.PI/2,v:0}]);
    expect(violates(run(makeScene([a,b],crossroads()),[a,b],[{a:'a',b:'b',t:6}]),'pdd:8.7')).toBe(true);
  });
  it('выезд с поворота на встречную половину нарушает 8.6', () => {
    const a = turn(true, 5.25, false);
    expect(violates(run(makeScene([a], crossroads()), [a]), 'pdd:8.6')).toBe(true);
  });
  it('выезд с поворота на свою половину соблюдает 8.6', () => {
    const a = turn(true, 5.25);
    expect(violates(run(makeScene([a], crossroads()), [a]), 'pdd:8.6')).toBe(false);
  });
});

function crossingPair(): Observed[] {
  return [observed('a', [{ t: 0, x: -20, y: 0 }, { t: 4, x: 0, y: 0 }, { t: 12, x: 40, y: 0 }]),
    observed('b', [{ t: 0, x: 0, y: 20 }, { t: 4, x: 0, y: 0 }, { t: 12, x: 0, y: -40 }])];
}
describe('8.3, 8.4, 8.8, 8.9: наблюдаемые обязанности уступить', () => {
  it('8.9 вне перекрёстка при неоговорённой очерёдности уступает имеющий помеху справа', () => {
    const specs = crossingPair();
    const ctx = run(makeScene(specs, []), specs, [{ a: 'a', b: 'b', t: 4 }]);
    expect(violates(ctx, 'pdd:8.9', 'a')).toBe(true);
    expect(violates(ctx, 'pdd:8.9', 'b')).toBe(false);
  });
  it('8.9 разнесённые во времени траектории сами не являются помехой', () => {
    const specs = crossingPair();
    const ctx = run(makeScene(specs, []), specs);
    expect(violates(ctx, 'pdd:8.9')).toBe(false);
  });
  it('8.3 выезжающий с прилегающей территории уступает движущемуся по дороге', () => {
    const a = observed('a', [{ t: 0, x: 0, y: 20 }, { t: 4, x: 0, y: 1.75 }, { t: 12, x: 30, y: 1.75 }]);
    const b = observed('b', [{ t: 0, x: -20, y: 1.75 }, { t: 4, x: 0, y: 1.75 }, { t: 12, x: 40, y: 1.75 }]);
    const specs = [a, b];
    expect(violates(run(makeScene(specs), specs, [{ a: 'a', b: 'b', t: 4 }]), 'pdd:8.3')).toBe(true);
    expect(violates(run(makeScene(specs), specs), 'pdd:8.3')).toBe(false);
  });
  it('8.4 перестраивающийся уступает попутному без изменения полосы, даже при включённом сигнале', () => {
    const a = laneChange();
    const b = observed('b', [{ t: 0, x: -30, y: 5.25 }, { t: 12, x: 0, y: 5.25 }]);
    const specs = [a, b];
    const ctx = run(makeScene(specs, [road('main', { lanes: 2 })]), specs, [{ a: 'a', b: 'b', t: 6 }]);
    expect(violates(ctx, 'pdd:8.4', 'a')).toBe(true);
    expect(violates(ctx, 'pdd:8.4', 'b')).toBe(false);
    expect(violates(run(makeScene(specs, [road('main', { lanes: 2 })]), specs), 'pdd:8.4')).toBe(false);
  });
  it('8.4 при одновременном перестроении уступает находящемуся слева от другого', () => {
    const a = observed('a',[{t:0,x:-40,y:1.75},{t:4,x:-20,y:1.75,signal:'right',signalAt:0},
      {t:6,x:-5,y:5.25,signal:'right',signalAt:0},{t:12,x:40,y:5.25,signal:'none',signalAt:6.1}]);
    const b = observed('b',[{t:0,x:-40,y:8.75},{t:4,x:-20,y:8.75,signal:'left',signalAt:0},
      {t:6,x:-5,y:5.25,signal:'left',signalAt:0},{t:12,x:40,y:5.25,signal:'none',signalAt:6.1}]);
    const ctx = run(makeScene([a,b],[road('main',{lanes:3})]),[a,b],[{a:'a',b:'b',t:6}]);
    expect(violates(ctx,'pdd:8.4','a')).toBe(true);
    expect(violates(ctx,'pdd:8.4','b')).toBe(false);
  });
  it('8.8 левый поворот вне перекрёстка уступает встречному потоку', () => {
    const a = observed('a', [{ t: 0, x: -20, y: 1.75 }, { t: 3, x: -5, y: 1.75 },
      { t: 4, x: 0, y: -1.75 }, { t: 12, x: 0, y: -40 }]);
    const b = observed('b', [{ t: 0, x: 20, y: -1.75 }, { t: 4, x: 0, y: -1.75 }, { t: 12, x: -40, y: -1.75 }]);
    const specs = [a, b];
    expect(violates(run(makeScene(specs), specs, [{ a: 'a', b: 'b', t: 4 }]), 'pdd:8.8')).toBe(true);
    expect(violates(run(makeScene(specs), specs), 'pdd:8.8')).toBe(false);
  });
});

function decelerationLane(brakeBefore: boolean): { scene: Scene; specs: Observed[] } {
  const a = observed('a', [{ t: 0, x: -40, y: 1.75, v: brakeBefore ? 8 : 4 },
    { t: 4, x: -10, y: 1.75, v: 4 }, { t: 6, x: -2, y: 5.25, v: 4 },
    { t: 7, x: 2, y: 5.25, v: 0 }, { t: 9, x: 2, y: 5.25, v: 0 }, { t: 12, x: 2, y: 20, v: 4 }]);
  const specs = [a];
  const scene = makeScene(specs, [road(), road('deceleration', { pts: [{x:-20,y:5.25},{x:30,y:5.25}], oneWay: true, laneRole: 'deceleration' })]);
  return { scene, specs };
}
describe('8.10: отдельная полоса торможения', () => {
  it('наблюдаемое снижение скорости до перестроения на полосу торможения нарушает 8.10', () => {
    const { scene, specs } = decelerationLane(true);
    expect(violates(run(scene, specs), 'pdd:8.10')).toBe(true);
  });
  it('снижение скорости только после занятия полосы торможения не нарушает 8.10', () => {
    const { scene, specs } = decelerationLane(false);
    expect(violates(run(scene, specs), 'pdd:8.10')).toBe(false);
  });
});

describe('8.10: полоса разгона и перестроение на главную полосу', () => {
  function merge() {
    const a = observed('a', [{t:0,x:-30,y:5.25}, {t:4,x:-10,y:5.25,signal:'left',signalAt:0},
      {t:6,x:0,y:1.75,signal:'left',signalAt:0}, {t:12,x:30,y:1.75,signal:'none',signalAt:6.1}]);
    const b = observed('b', [{t:0,x:-30,y:1.75}, {t:12,x:30,y:1.75}]);
    const specs = [a,b], scene = makeScene(specs, [road(), road('acceleration', {
      pts:[{x:-80,y:5.25},{x:30,y:5.25}],oneWay:true,laneRole:'acceleration' })]);
    return {scene,specs};
  }
  it('съезжающий с полосы разгона уступает движущемуся по соседней полосе', () => {
    const {scene,specs} = merge(), ctx = run(scene,specs,[{a:'a',b:'b',t:6}]);
    expect(violates(ctx,'pdd:8.10','a')).toBe(true);
    expect(violates(ctx,'pdd:8.10','b')).toBe(false);
  });
  it('сигнал и геометрия примыкания без фактической помехи не доказывают нарушение', () => {
    const {scene,specs} = merge();
    expect(violates(run(scene,specs),'pdd:8.10')).toBe(false);
  });
});

describe('8.11: запрет разворота по установленному месту', () => {
  it.each(['bridge', 'tunnel', 'railway-crossing', 'stop-area'] as const)('%s: разворот запрещён', feature => {
    const a = uturn();
    expect(violates(run(makeScene([a], [road('main', { features: [feature] })]), [a]), 'pdd:8.11')).toBe(true);
  });
  it('обычный участок с достаточной видимостью не запрещает разворот сам по себе', () => {
    const a = uturn();
    expect(violates(run(makeScene([a], [road('main', { visibility: 150 })]), [a]), 'pdd:8.11')).toBe(false);
  });
  it('видимость менее 100 м запрещает разворот; неизвестная видимость не равна недостаточной', () => {
    const a = uturn();
    expect(violates(run(makeScene([a], [road('main', { visibility: 80 })]), [a]), 'pdd:8.11')).toBe(true);
    expect(violates(run(makeScene([a]), [a]), 'pdd:8.11')).toBe(false);
  });
  it('разворот на пешеходном переходе запрещён', () => {
    const a = uturn(), scene = makeScene([a]);
    scene.crosswalks = [{ id: 'crosswalk', x: 0, y: 0, angle: Math.PI / 2, length: 8, width: 5 }];
    expect(violates(run(scene, [a]), 'pdd:8.11')).toBe(true);
  });
});

describe('8.12: задний ход', () => {
  const reverse = () => observed('a', [{ t: 0, x: 20, y: 1.75, h: 0, v: 3, reverse: true }, { t: 12, x: -16, y: 1.75, h: 0, v: 3, reverse: true }]);
  it('безопасный задний ход на обычном участке не запрещён', () => {
    const a = reverse();
    expect(violates(run(makeScene([a]), [a]), 'pdd:8.12')).toBe(false);
  });
  it.each(['bridge', 'tunnel', 'railway-crossing', 'stop-area'] as const)('%s: задний ход запрещён', feature => {
    const a = reverse();
    expect(violates(run(makeScene([a], [road('main', { features: [feature] })]), [a]), 'pdd:8.12')).toBe(true);
  });
  it('задний ход на перекрёстке запрещён', () => {
    const a = reverse();
    expect(violates(run(makeScene([a], crossroads()), [a]), 'pdd:8.12')).toBe(true);
  });
  it('столкновение с участником позади показывает небезопасность заднего хода', () => {
    const a = reverse();
    const b = observed('b', [{ t: 0, x: 5, y: 1.75, v: 0 }, { t: 12, x: 5, y: 1.75, v: 0 }]);
    expect(violates(run(makeScene([a,b]), [a,b], [{ a: 'a', b: 'b', t: 5 }]), 'pdd:8.12')).toBe(true);
  });
  it('на автомагистрали применяется специальный состав, без общего forbidden-maneuver', () => {
    const a = reverse();
    const ctx = run(makeScene([a], [road('main', { features: ['motorway'] })]), [a]);
    const violation = ctx.findings.find(f => f.actorId === 'a' && f.severity === 'violation' && f.refs.includes('rule:motorway-maneuver'));
    expect(violation).toBeDefined();
    expect(violation!.refs).not.toContain('rule:forbidden-maneuver');
  });
});

describe('11.1–11.4: именно обгон с выездом на встречную и возвратом', () => {
  it('известный свободный встречный путь и возврат без помех допускают обгон', () => {
    const specs = overtaking();
    const ctx = run(makeScene(specs), specs);
    expect(violates(ctx, 'pdd:11.1')).toBe(false);
    expect(violates(ctx, 'pdd:11.2')).toBe(false);
  });
  it('подтверждённая занятость встречного пути запрещает начало обгона', () => {
    const specs = overtaking({ maneuverContext: { oncomingClear: false, overtakeReturnClear: true } });
    expect(violates(run(makeScene(specs), specs), 'pdd:11.1')).toBe(true);
  });
  it('неизвестная достаточность встречного пути не подменяется ложным фактом', () => {
    const specs = overtaking({ maneuverContext: {} });
    expect(violates(run(makeScene(specs), specs), 'pdd:11.1')).toBe(false);
  });
  it('11.2: сигнал левого поворота впереди запрещает обгон', () => {
    const specs = overtaking();
    specs[1].actor.path[0].signal = 'left';
    specs[1].actor.path[0].signalAt = 0;
    expect(violates(run(makeScene(specs), specs), 'pdd:11.2')).toBe(true);
  });
  it('11.2: невозможность безопасно вернуться запрещает обгон', () => {
    const specs = overtaking({ maneuverContext: { oncomingClear: true, overtakeReturnClear: false } });
    expect(violates(run(makeScene(specs), specs), 'pdd:11.2')).toBe(true);
  });
  it('11.2: впереди идущее ТС уже производит обгон другого участника', () => {
    const a = observed('a',[{t:0,x:-30,y:1.75},{t:2,x:-14,y:-1.75},{t:8,x:34,y:-1.75},
      {t:10,x:50,y:1.75},{t:12,x:66,y:1.75}],{maneuverContext:{oncomingClear:true,overtakeReturnClear:true}});
    const b = observed('b',[{t:0,x:-8,y:-5.25},{t:8,x:24,y:-5.25},{t:10,x:32,y:1.75},{t:12,x:40,y:1.75}]);
    const c = observed('c',[{t:0,x:2,y:1.75},{t:12,x:14,y:1.75}]);
    const ctx = run(makeScene([a,b,c],[road('main',{lanes:2})]),[a,b,c]);
    expect(findings(ctx,'pdd:11.2').some(f=>f.severity==='violation'&&JSON.stringify(f.trace).includes('leader-overtaking'))).toBe(true);
  });
  it('11.2: следующее за участником ТС уже начало обгон', () => {
    const specs = overtaking();
    const c = observed('c',[{t:0,x:-45,y:-5.25},{t:7,x:25,y:-5.25},{t:9,x:45,y:1.75},{t:12,x:75,y:1.75}]);
    specs.push(c);
    const ctx = run(makeScene(specs,[road('main',{lanes:2})]),specs);
    expect(findings(ctx,'pdd:11.2').some(f=>f.severity==='violation'&&JSON.stringify(f.trace).includes('following-overtaker'))).toBe(true);
  });
  it('11.3: повышение скорости обгоняемым фиксируется без ошибочного состава объезда препятствия', () => {
    const specs = overtaking();
    specs[1] = observed('b', [{ t: 0, x: -8, y: 1.75, v: 2 }, { t: 4, x: 0, y: 1.75, v: 2 }, { t: 12, x: 32, y: 1.75, v: 4 }],
      { maneuverContext: { overtakenAccelerates: true } });
    const ctx = run(makeScene(specs), specs);
    const obstruction = findings(ctx, 'pdd:11.3', 'b').find(f => f.severity === 'violation');
    expect(obstruction).toBeDefined();
    expect(obstruction!.refs.some(ref => ref === 'koap:12.15.3' || ref === 'koap:12.15#3' || ref === 'rule:obstacle-bypass')).toBe(false);
    expect(`${obstruction!.detail} ${JSON.stringify(obstruction!.trace)}`).toContain('TODO(legal-check)');
  });
  it('11.3: сохраняющий скорость обгоняемый не препятствует одним фактом присутствия', () => {
    const specs = overtaking();
    expect(violates(run(makeScene(specs), specs), 'pdd:11.3', 'b')).toBe(false);
  });
  it.each(['bridge', 'tunnel', 'limited-visibility'] as const)('11.4: %s запрещает обгон', feature => {
    const specs = overtaking();
    expect(violates(run(makeScene(specs, [road('main', { features: [feature] })]), specs), 'pdd:11.4')).toBe(true);
  });
  it('11.4: обгон запрещён на переходе', () => {
    const specs = overtaking(), scene = makeScene(specs);
    scene.crosswalks = [{ id: 'zebra', x: 0, y: 0, angle: Math.PI / 2, length: 8, width: 4 }];
    expect(violates(run(scene, specs), 'pdd:11.4')).toBe(true);
  });
  it('11.4: ближе 100 метров перед установленной зоной переезда обгон запрещён', () => {
    const specs = overtaking();
    const scene = makeScene(specs,[road(),road('railway',{pts:[{x:45,y:0},{x:47,y:0}],features:['railway-crossing']})]);
    expect(violates(run(scene,specs),'pdd:11.4')).toBe(true);
  });
  it('11.4: удалённый переезд за пределом 100 метров не запрещает этот обгон сам по себе', () => {
    const specs = overtaking();
    const scene = makeScene(specs,[road(),road('railway',{pts:[{x:200,y:0},{x:202,y:0}],features:['railway-crossing']})]);
    expect(violates(run(scene,specs),'pdd:11.4')).toBe(false);
  });
  it('11.4: по неглавной дороге нерегулируемого перекрёстка обгон запрещён', () => {
    const specs = overtaking(), scene = makeScene(specs,crossroads());
    expect(violates(run(scene,specs),'pdd:11.4')).toBe(true);
  });
  it('11.4: на регулируемом перекрёстке обгон запрещён', () => {
    const specs = overtaking(), scene = makeScene(specs, crossroads());
    scene.lights = [{ id: 'light', x: -10, y: 4, angle: 0, green: 20, yellow: 3, red: 20, offset: 0, lineLength: 3.5 }];
    expect(violates(run(scene, specs), 'pdd:11.4')).toBe(true);
  });
  it('11.4: на нерегулируемом перекрёстке по главной нет этого специального запрета', () => {
    const specs = overtaking(), scene = makeScene(specs, crossroads());
    scene.signs = [{ id: 'main-sign', kind: '2.1', x: -25, y: 5, angle: 0 }];
    expect(violates(run(scene, specs), 'pdd:11.4')).toBe(false);
  });
  it('11.4: обычное опережение по своей стороне не становится обгоном из-за перехода', () => {
    const specs = overtaking({}, true), scene = makeScene(specs, [road('main', { lanes: 2 })]);
    scene.crosswalks = [{ id: 'zebra', x: 0, y: 0, angle: Math.PI / 2, length: 16, width: 4 }];
    expect(violates(run(scene, specs), 'pdd:11.4')).toBe(false);
  });
});

describe('11.5: опережение на переходе с учётом 14.2', () => {
  function crossingPass(slow: boolean) {
    const a = slow ? observed('a', [{t:0,x:-30,y:1.75,v:6},{t:4,x:-6,y:1.75,v:0},
      {t:6,x:-6,y:1.75,v:0},{t:12,x:30,y:1.75,v:6}])
      : observed('a', [{t:0,x:-30,y:1.75,v:6},{t:12,x:42,y:1.75,v:6}]);
    const b = observed('b', [{t:0,x:-6,y:5.25,v:0},{t:12,x:-6,y:5.25,v:0}]);
    const specs = [a,b], scene = makeScene(specs, [road('main', { lanes: 2 })]);
    scene.crosswalks = [{ id: 'zebra', x: 0, y: 0, angle: Math.PI/2, length: 16, width: 4 }];
    return { specs, scene };
  }
  it('проезд без снижения скорости мимо остановившегося перед зеброй требует 11.5/14.2', () => {
    const { scene, specs } = crossingPass(false), ctx = run(scene, specs);
    expect(violates(ctx, 'pdd:11.5')).toBe(true);
    expect(findings(ctx, 'pdd:11.5')[0].refs).toContain('pdd:14.2');
    expect(violates(ctx, 'pdd:11.4')).toBe(false);
  });
  it('остановка рядом перед переходом выполняет наблюдаемое требование 14.2', () => {
    const { scene, specs } = crossingPass(true);
    expect(violates(run(scene, specs), 'pdd:11.5')).toBe(false);
  });
});

describe('11.6: пропустить следующие ТС при подтверждённом затруднении', () => {
  it('вне города тихоходный обязан принять вправо или остановиться', () => {
    const specs = overtaking();
    specs[1].actor.maneuverContext = { overtakingDifficult: true, keptRight: false, yieldedByStop: false };
    expect(violates(run(makeScene(specs, [road('main', { zone: 'outside' })]), specs), 'pdd:11.6', 'b')).toBe(true);
  });
  it('подтверждённое принятие вправо исполняет 11.6', () => {
    const specs = overtaking();
    specs[1].actor.maneuverContext = { overtakingDifficult: true, keptRight: true };
    expect(violates(run(makeScene(specs, [road('main', { zone: 'outside' })]), specs), 'pdd:11.6', 'b')).toBe(false);
  });
  it('неизвестное затруднение и городской участок не создают этот состав', () => {
    const specs = overtaking();
    expect(violates(run(makeScene(specs, [road('main', { zone: 'outside' })]), specs), 'pdd:11.6', 'b')).toBe(false);
    specs[1].actor.maneuverContext = { overtakingDifficult: true, keptRight: false, yieldedByStop: false };
    expect(violates(run(makeScene(specs), specs), 'pdd:11.6', 'b')).toBe(false);
  });
});

describe('11.7: встречный разъезд и уклон', () => {
  function meeting(): Observed[] {
    return [observed('a', [{t:0,x:-20,y:1.75,h:0},{t:4,x:0,y:0,h:0},{t:12,x:40,y:1.75,h:0}], { maneuverContext: { opposingObstacle: true } }),
      observed('b', [{t:0,x:20,y:-1.75,h:Math.PI},{t:4,x:0,y:0,h:Math.PI},{t:12,x:-40,y:-1.75,h:Math.PI}])];
  }
  it('при помехе уступает тот, на чьей стороне препятствие', () => {
    const specs = meeting(), ctx = run(makeScene(specs), specs, [{a:'a',b:'b',t:4}]);
    expect(violates(ctx, 'pdd:11.7', 'a')).toBe(true);
    expect(violates(ctx, 'pdd:11.7', 'b')).toBe(false);
  });
  it('наличие препятствия без фактической помехи ещё не нарушение', () => {
    const specs = meeting();
    expect(violates(run(makeScene(specs), specs), 'pdd:11.7')).toBe(false);
  });
  it('на обозначенном уклоне уступает движущийся на спуск, даже при препятствии у другого', () => {
    const specs = meeting();
    specs[0].actor.maneuverContext = { steepSlope: true, slopeDownhill: true };
    specs[1].actor.maneuverContext = { opposingObstacle: true };
    const scene = makeScene(specs);
    scene.signs = [{id:'descent',kind:'1.13',x:-15,y:5,angle:0}];
    const ctx = run(scene, specs, [{a:'a',b:'b',t:4}]);
    expect(violates(ctx, 'pdd:11.7', 'a')).toBe(true);
    expect(violates(ctx, 'pdd:11.7', 'b')).toBe(false);
  });
  it('одно поле уклона без знаков 1.13/1.14 не отменяет правило стороны препятствия', () => {
    const specs = meeting();
    specs[0].actor.maneuverContext = { steepSlope: true, slopeDownhill: true };
    specs[1].actor.maneuverContext = { opposingObstacle: true };
    const ctx = run(makeScene(specs), specs, [{a:'a',b:'b',t:4}]);
    expect(violates(ctx, 'pdd:11.7', 'a')).toBe(false);
    expect(violates(ctx, 'pdd:11.7', 'b')).toBe(true);
  });
});


describe('11.2: начатый манёвр без завершённого опережения', () => {
  it('прерванная без удара попытка обгона не отменяет запрета при левом сигнале лидера', () => {
    const a = observed('a', [{t:0,x:-30,y:1.75},{t:2,x:-18,y:-1.75},
      {t:4,x:-15,y:-1.75},{t:6,x:-15,y:1.75},{t:12,x:0,y:1.75}],
      {maneuverContext:{oncomingClear:true,overtakeReturnClear:true}});
    const b = observed('b', [{t:0,x:-8,y:1.75},{t:12,x:16,y:1.75,signal:'left',signalAt:0.3}]);
    const specs=[a,b], ctx=run(makeScene(specs),specs);
    const finding=findings(ctx,'pdd:11.2').find(f=>f.severity==='violation');
    expect(finding).toBeDefined();
    expect(finding!.trace?.completedPass).toBe(false);
    expect(ctx.tl.collisions).toHaveLength(0);
  });
  it('объезжающий препятствие лидер учитывается отдельно от обгона другого ТС', () => {
    const a=overtaking()[0];
    const b=observed('b',[{t:0,x:-8,y:1.75},{t:1,x:-6,y:-1.75},{t:8,x:8,y:-1.75},
      {t:10,x:12,y:1.75},{t:12,x:16,y:1.75}],{maneuverContext:{opposingObstacle:true}});
    const specs=[a,b], ctx=run(makeScene(specs),specs);
    expect(findings(ctx,'pdd:11.2').some(f=>f.severity==='violation'
      && (f.trace?.reasons as string[] | undefined)?.includes('leader-bypassing-obstacle'))).toBe(true);
  });
});
