import { describe, expect, it } from 'vitest';
import { checkRailway, railwayFrontDistance, railwayPriority } from '../src/analysis/railway';
import { analyzeTechnical, prepare } from '../src/analysis/technical';
import { analyzeRules } from '../src/analysis/traffic-rules';
import { analyze } from '../src/analysis';
import { PRESETS, RAILWAY_PRESETS } from '../src/presets';
import { angDiff } from '../src/geom';
import { actorSpec, emptyScene, normalizeScene, type Actor, type RailwayContext, type RailwayCrossing, type Road, type Scene } from '../src/scene';
import { DT, simulate, type Collision, type Timeline, type Track } from '../src/sim';
import type { Ctx } from '../src/analysis/context';

/** Measured positions are independent of the runtime path follower. Train values
 * below are explicit synthetic test inputs, never a reference train catalogue. */
type Key = { t: number; x: number; y: number; h?: number; v?: number };
type Observed = { actor: Actor; keys: Key[] };
const duration = 8;
const road = (id = 'road', options: Partial<Road> = {}): Road => ({ id,
  pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 1, center: 'dashed', oneWay: false,
  zone: 'city', smooth: false, ...options });
function observed(id: string, keys: Key[], options: Partial<Actor> = {}): Observed {
  const first = keys[0], next = keys[1] ?? first;
  const heading = first.h ?? Math.atan2(next.y - first.y, next.x - first.x);
  const speed = first.v ?? Math.hypot(next.x - first.x, next.y - first.y) / Math.max(DT, next.t - first.t);
  return { keys, actor: { id, kind: 'vehicle', type: 'car', x: first.x, y: first.y,
    heading, speed: speed * 3.6, delay: 0, color: '#2288dd',
    path: keys.slice(1).map(k => ({ x: k.x, y: k.y, v: (k.v ?? speed) * 3.6 })),
    flags: { drunk: false, noLicense: false, flees: false }, ...options } };
}
const driving = (context?: RailwayContext) => observed('car', [
  { t: 0, x: -30, y: 1.75 }, { t: duration, x: 30, y: 1.75 },
], { railwayContext: context });
const halted = (context?: RailwayContext) => observed('car', [
  { t: 0, x: 0, y: 1.75, v: 0 }, { t: duration, x: 0, y: 1.75, v: 0 },
], { railwayContext: context });
const train = (keys: Key[] = [{ t: 0, x: 0, y: -20, h: Math.PI / 2 }, { t: duration, x: 0, y: 20, h: Math.PI / 2 }]) =>
  observed('train', keys, { type: 'tram', railwayTrain: { mass: 10000, length: 12, width: 2,
    brakeDecel: 0.8, source: 'Условные параметры теста; TODO(source-check)', trackId: 'rail' } });
function crossing(options: Partial<RailwayCrossing> = {}): RailwayCrossing {
  return { id: 'crossing', x: 0, y: 0, angle: 0, length: 4, width: 8,
    barrier: 'open', signal: 'white', attendantStop: false, exitBlocked: false,
    visibleTrainApproaching: false, ...options };
}
function makeScene(specs: Observed[], c: RailwayCrossing | null = crossing()): Scene {
  const scene = emptyScene();
  scene.env.duration = duration;
  scene.env.accidentDate = '2026-10-20T12:00';
  scene.roads = [road()];
  scene.actors = specs.map(s => s.actor);
  scene.railwayCrossings = c ? [c] : [];
  return scene;
}
function trackFor(spec: Observed, n: number): Track {
  const track: Track = { id: spec.actor.id, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n),
    v: new Float32Array(n), present: new Uint8Array(n).fill(1), free: new Uint8Array(n), waypointTimes: spec.keys.slice(1).map(k => k.t) };
  for (let frame = 0; frame < n; frame++) {
    const time = frame * DT;
    let index = spec.keys.findIndex((k, i) => i > 0 && k.t > time);
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
type Contact = { a: string; b: string; t: number };
function timeline(specs: Observed[], contacts: Contact[] = []): Timeline {
  const n = Math.round(duration / DT) + 1, tracks = new Map(specs.map(s => [s.actor.id, trackFor(s, n)]));
  const collisions: Collision[] = contacts.map((contact, idx) => {
    const frame = Math.round(contact.t / DT), a = tracks.get(contact.a)!, b = tracks.get(contact.b)!;
    const velocity = (t: Track) => ({ x: Math.cos(t.h[frame]) * t.v[frame], y: Math.sin(t.h[frame]) * t.v[frame] });
    const vA = velocity(a), vB = velocity(b);
    return { idx, frame, t: contact.t, a: contact.a, b: contact.b, kind: 'vv',
      point: { x: (a.x[frame] + b.x[frame]) / 2, y: (a.y[frame] + b.y[frame]) / 2 }, n: { x: 1, y: 0 },
      vA, vB, rel: Math.hypot(vA.x - vB.x, vA.y - vB.y), dvA: 0, dvB: 0 };
  });
  return { dt: DT, n, duration, mu: 0.7, tracks, collisions };
}
function run(scene: Scene, specs: Observed[], contacts: Contact[] = []): Ctx {
  const ctx: Ctx = { ...prepare(scene, timeline(specs, contacts)), findings: [], priorityGraphs: [], events: [],
    onc: new Map(), lightViolations: new Map(), stopSkipped: new Map(), pedEntry: new Map() };
  checkRailway(ctx, finding => ctx.findings.push({ causal: false, ...finding }));
  return ctx;
}
const matching = (ctx: Ctx, ref: string) => ctx.findings.filter(f => f.actorId === 'car' && f.refs.includes(ref));
const violations = (ctx: Ctx, ref: string) => matching(ctx, ref).filter(f => f.severity === 'violation');
function passage(c: Partial<RailwayCrossing>, context?: RailwayContext): Ctx {
  const a = driving(context);
  return run(makeScene([a], crossing(c)), [a]);
}

describe('15.3 and 6.9: established railway entry conditions', () => {
  it.each([
    ['closed barrier', { barrier: 'closed' }, 'rule:railway-prohibited-entry'],
    ['closing barrier', { barrier: 'closing' }, 'rule:railway-prohibited-entry'],
    ['red signal with open barrier', { signal: 'red' }, 'rule:railway-prohibited-entry'],
    ['attendant stop', { attendantStop: true }, 'rule:railway-prohibited-entry'],
    ['queue blocking exit', { exitBlocked: true }, 'rule:railway-other'],
    ['visible train at unregulated crossing', { visibleTrainApproaching: true, regulated: false }, 'rule:railway-prohibited-entry'],
  ] as [string, Partial<RailwayCrossing>, string][])('%s forbids observed entry', (_name, state, code) => {
    const findings = violations(passage(state), 'pdd:15.3');
    expect(findings).toHaveLength(1);
    expect(findings[0].refs).toContain(code);
    expect(findings[0].trace?.frontDistance).toBeLessThan(0);
  });
  it('white never overrides a closing barrier', () => {
    expect(violations(passage({ signal: 'white', barrier: 'closing' }), 'rule:railway-prohibited-entry')).toHaveLength(1);
  });
  it('red remains prohibitory when no barrier exists', () => {
    expect(violations(passage({ signal: 'red', barrier: 'none' }), 'rule:railway-prohibited-entry')).toHaveLength(1);
  });
  it.each(['white', 'off'] as const)('%s with all prohibitory facts known absent is compliant', signal => {
    const ctx = passage({ signal });
    expect(violations(ctx, 'pdd:15.3')).toHaveLength(0);
    expect(matching(ctx, 'pdd:6.9').some(f => f.trace?.compliance === 'выполнено')).toBe(true);
  });
  it.each(['barrier', 'signal', 'attendantStop', 'exitBlocked', 'visibleTrainApproaching'] as const)(
    'unknown %s cannot be treated as permission', field => {
      const ctx = passage({ [field]: undefined });
      expect(violations(ctx, 'pdd:15.3')).toHaveLength(0);
      expect(matching(ctx, 'pdd:15.2').some(f => f.trace?.compliance === 'не определить')).toBe(true);
      expect(matching(ctx, 'pdd:15.2').some(f => f.trace?.compliance === 'выполнено')).toBe(false);
    });
  it('visible train with unknown regulation establishes PDD prohibition without selecting a part', () => {
    const finding = violations(passage({ visibleTrainApproaching: true, regulated: undefined }), 'pdd:15.3')[0];
    expect(finding).toBeDefined();
    expect(finding.refs.some(r => r.startsWith('rule:railway-'))).toBe(false);
    expect(finding.trace?.visibleTrainQualificationUnknown).toBe(true);
  });
  it('visible train at a known regulated crossing does not receive the unregulated special code', () => {
    const finding = violations(passage({ visibleTrainApproaching: true, regulated: true }), 'pdd:15.3')[0];
    expect(finding.refs).toContain('rule:railway-other');
    expect(finding.refs).not.toContain('rule:railway-prohibited-entry');
  });
  it('starting inside or passing alongside the crossing does not fabricate entry', () => {
    const inside = observed('car', [{ t: 0, x: 0, y: 1.75 }, { t: duration, x: 30, y: 1.75 }]);
    const beside = observed('car', [{ t: 0, x: -30, y: 20 }, { t: duration, x: 30, y: 20 }]);
    for (const a of [inside, beside]) expect(violations(run(makeScene([a], crossing({ signal: 'red' })), [a]), 'pdd:15.3')).toHaveLength(0);
  });
});

describe('15.4: measured stopping boundaries use the front of the body', () => {
  function approach(distance: number, state: Partial<RailwayCrossing>, reverseSide = false): Ctx {
    const side = reverseSide ? 1 : -1, half = actorSpec(driving().actor).length / 2;
    const a = observed('car', [{ t: 0, x: side * 35, y: 1.75, h: reverseSide ? Math.PI : 0 },
      { t: duration, x: side * (2 + half + distance), y: 1.75, h: reverseSide ? Math.PI : 0 }]);
    return run(makeScene([a], crossing({ signal: 'red', ...state })), [a]);
  }
  it.each([false, true])('stop-line distance is measured to the front on either approach (%s)', reverseSide => {
    expect(violations(approach(7, { stopLineDistance: 8 }, reverseSide), 'pdd:15.4')).toHaveLength(1);
    expect(violations(approach(8, { stopLineDistance: 8 }, reverseSide), 'pdd:15.4')).toHaveLength(0);
  });
  it('known absent stop-line uses five metres before the measured control', () => {
    const state = { stopLinePresent: false, controlDistance: 3 };
    const finding = violations(approach(7, state), 'pdd:15.4')[0];
    expect(finding.trace?.boundary).toMatchObject({ distance: 8 });
    expect(violations(approach(8, state), 'pdd:15.4')).toHaveLength(0);
  });
  it('known absent line, light and barrier use ten metres before the nearest rail', () => {
    const state: Partial<RailwayCrossing> = { stopLinePresent: false, lightPresent: false, barrier: 'none', signal: 'off', visibleTrainApproaching: true };
    expect(violations(approach(9, state), 'pdd:15.4')[0].trace?.boundary).toMatchObject({ distance: 10 });
    expect(violations(approach(10, state), 'pdd:15.4')).toHaveLength(0);
  });
  it('unknown line presence prevents silently falling back to a measured control', () => {
    expect(violations(approach(4, { controlDistance: 3 }), 'pdd:15.4')).toHaveLength(0);
  });
  it('unknown control position and unknown light presence never become zero or absent', () => {
    expect(violations(approach(4, { stopLinePresent: false }), 'pdd:15.4')).toHaveLength(0);
    expect(violations(approach(4, { stopLinePresent: false, barrier: 'none' }), 'pdd:15.4')).toHaveLength(0);
  });
  it('an oblique body uses its extreme corner rather than centre or nominal half length', () => {
    const a = observed('car', [{ t: 0, x: -12, y: 0, h: Math.PI / 4, v: 0 }, { t: duration, x: -12, y: 0, h: Math.PI / 4, v: 0 }]);
    const c = crossing(), ctx = run(makeScene([a], c), [a]), info = ctx.infos.get('car')!;
    expect(railwayFrontDistance(c, info, 0, -1)).toBeCloseTo(12 - 2 - (2.25 + 0.9) / Math.sqrt(2));
  });
});

describe('15.3: rare acts require explicit context facts', () => {
  it.each([
    ['queue bypass onto oncoming lane', { bypassingWaitingQueue: true }],
    ['opening the barrier without authority', { openedBarrier: true }],
    ['machinery outside transport position', { machineryTransportPosition: false }],
    ['slow machinery without permission', { slowMachinery: true, trackAuthorityPermission: false }],
    ['tractor sledge without permission', { tractorSledge: true, trackAuthorityPermission: false }],
  ] as [string, RailwayContext][])('%s is an additional prohibition', (_name, context) => {
    const finding = violations(passage({}, context), 'pdd:15.3')[0];
    expect(finding.refs).toContain('rule:railway-other');
    expect(finding.refs).not.toContain('rule:railway-prohibited-entry');
  });
  it('permission is three-state, and known permission permits the slow-machinery passage', () => {
    const unknown = passage({}, { slowMachinery: true });
    expect(violations(unknown, 'pdd:15.3')).toHaveLength(0);
    expect(matching(unknown, 'pdd:15.3').some(f => f.trace?.compliance === 'не определить')).toBe(true);
    expect(violations(passage({}, { slowMachinery: true, trackAuthorityPermission: true }), 'pdd:15.3')).toHaveLength(0);
  });
  it('a car currently travelling at seven km/h is not automatically a slow machine', () => {
    const a = observed('car', [{ t: 0, x: -10, y: 1.75, v: 7 / 3.6 }, { t: duration, x: 5.5556, y: 1.75, v: 7 / 3.6 }]);
    expect(violations(run(makeScene([a]), [a]), 'pdd:15.3')).toHaveLength(0);
  });
  it('context referring to another crossing does not establish an act at this one', () => {
    expect(violations(passage({}, { crossingId: 'elsewhere', openedBarrier: true, machineryTransportPosition: false }), 'pdd:15.3')).toHaveLength(0);
  });
});

describe('15.5: distinguish forced stops from unexplained immobility', () => {
  function stop(context?: RailwayContext, state: Partial<RailwayCrossing> = {}): Ctx {
    const a = halted(context);
    if (context?.forcedStop === false) a.actor.stopContext = { reason: 'other-voluntary', intentional: true, durationBeforeStart: 0 };
    return run(makeScene([a], crossing(state)), [a]);
  }
  it('unknown stop reason does not establish an administrative stop offence', () => {
    const ctx = stop();
    expect(violations(ctx, 'rule:railway-stop')).toHaveLength(0);
    expect(matching(ctx, 'pdd:15.5').some(f => f.trace?.compliance === 'не определить')).toBe(true);
  });
  it('explicitly intentional voluntary stop receives the stop code without invented repeat offence', () => {
    const finding = violations(stop({ forcedStop: false }), 'rule:railway-stop')[0];
    expect(finding).toBeDefined();
    expect(finding.refs).not.toContain('koap:12.10#3');
  });
  it('forced stop gives the full corpus algorithm and does not presume neglected actions', () => {
    const ctx = stop({ forcedStop: true }), guidance = matching(ctx, 'pdd:15.5').find(f => f.severity === 'info');
    expect(guidance).toBeDefined();
    for (const text of ['высадить', 'освобождению', '1000 м', 'худшей видимости', 'один длинный и три коротких', 'круговое движение']) expect(guidance!.detail).toContain(text);
    expect(violations(ctx, 'pdd:15.5')).toHaveLength(0);
    expect(violations(ctx, 'rule:railway-stop')).toHaveLength(0);
  });
  it('explicitly neglected evacuation, clearing and alarm establish only their known duties', () => {
    const finding = violations(stop({ forcedStop: true, passengersDisembarked: false, clearingCrossing: false, generalAlarm: false }), 'pdd:15.5')[0];
    expect(finding.detail).toContain('люди не высажены');
    expect(finding.detail).toContain('меры к освобождению переезда не приняты');
    expect(finding.detail).toContain('сигнал общей тревоги не подавался');
  });
  it('sending messengers is required only when the possibility is established', () => {
    expect(violations(stop({ forcedStop: true, stopMessengers: 'none' }), 'pdd:15.5')).toHaveLength(0);
    expect(violations(stop({ forcedStop: true, stopMessengers: 'none', messengersPossible: true }), 'pdd:15.5')).toHaveLength(1);
  });
  it('the visible approaching train activates an explicitly neglected stop signal', () => {
    expect(violations(stop({ forcedStop: true, trainStopSignal: false }), 'pdd:15.5')).toHaveLength(0);
    expect(violations(stop({ forcedStop: true, trainStopSignal: false }, { visibleTrainApproaching: true }), 'pdd:15.5')).toHaveLength(1);
  });
});

describe('15.1: railway geometry and priority are separate from tram rules', () => {
  function railScene(kind: 'railway' | 'tram', geometry: 'empty' | 'crossing' | 'unknown' = 'empty') {
    const a = driving(), scene = makeScene([a], geometry === 'crossing' ? crossing() : null);
    scene.tracks = [{ id: 'rail', kind, pts: [{ x: 0, y: -30 }, { x: 0, y: 30 }], separated: true, smooth: false }];
    if (geometry === 'unknown') delete scene.railwayCrossings;
    return run(scene, [a]);
  }
  it('explicit railway and explicitly empty crossing geometry establish an outside crossing', () => {
    expect(violations(railScene('railway'), 'rule:railway-outside')).toHaveLength(1);
  });
  it('a railway crossed inside a defined crossing does not establish an outside crossing', () => {
    expect(violations(railScene('railway', 'crossing'), 'rule:railway-outside')).toHaveLength(0);
  });
  it('tram track and missing crossing collection cannot establish the railway outside offence', () => {
    expect(violations(railScene('tram'), 'rule:railway-outside')).toHaveLength(0);
    expect(violations(railScene('railway', 'unknown'), 'rule:railway-outside')).toHaveLength(0);
  });
  function priority(car: Observed, locomotive = train()) {
    const specs = [car, locomotive], scene = makeScene(specs), contact = { a: 'car', b: 'train', t: 4 };
    const ctx = run(scene, specs, [contact]);
    return railwayPriority(ctx, 'car', 'train', ctx.tl.collisions[0]);
  }
  it('a moving car crossing ahead of a moving train owes it priority under 15.1', () => {
    const decision = priority(driving());
    expect(decision).toMatchObject({ from: 'car', to: 'train', failureEstablished: true });
    expect(decision!.refs).toContain('pdd:15.1');
    expect(decision!.refs.some(ref => ref.startsWith('pdd:13.'))).toBe(false);
  });
  it('a forced stop or unexplained static car does not prove priority failure by contact alone', () => {
    expect(priority(halted())!.failureEstablished).toBe(false);
    expect(priority(driving({ forcedStop: true }))!.failureEstablished).toBe(false);
  });
  it('a static train or parallel motion does not establish failure to yield while crossing', () => {
    expect(priority(driving(), train([{ t: 0, x: 0, y: 0, h: Math.PI / 2, v: 0 }, { t: duration, x: 0, y: 0, h: Math.PI / 2, v: 0 }]))!.failureEstablished).toBe(false);
    expect(priority(driving(), train([{ t: 0, x: -20, y: 0, h: 0 }, { t: duration, x: 20, y: 0, h: 0 }]))!.failureEstablished).toBe(false);
  });
});

describe('railway rule pipeline integration', () => {
  it('actual crossing geometry prohibits reversing without a road feature flag', () => {
    const a = observed('car', [{ t: 0, x: 0, y: 1.75, h: 0 }, { t: duration, x: -15, y: 1.75, h: 0 }]);
    const scene = makeScene([a]), tl = timeline([a]);
    tl.tracks.get('car')!.reversing = new Uint8Array(tl.n).fill(1);
    const result = analyzeRules(analyzeTechnical(scene, tl));
    expect(scene.roads[0].features).toBeUndefined();
    expect(result.section.findings.some(f => f.actorId === 'car' && f.severity === 'violation'
      && f.refs.includes('pdd:8.12') && f.refs.includes('pdd:8.11'))).toBe(true);
  });
  it('a railway beside the left turning lane does not become a tram starting position under 8.5', () => {
    const a = observed('car', [{ t: 0, x: -30, y: 1.75, h: 0 }, { t: 3, x: -5, y: 1.75, h: 0 },
      { t: 5, x: 1.75, y: -10, h: -Math.PI / 2 }, { t: duration, x: 1.75, y: -30, h: -Math.PI / 2 }]);
    const scene = makeScene([a]);
    scene.roads.push(road('cross-road', { pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }));
    scene.tracks = [{ id: 'rail', kind: 'railway', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], separated: false, smooth: false }];
    const result = analyzeRules(analyzeTechnical(scene, timeline([a])));
    const position = result.section.findings.filter(f => f.actorId === 'car' && f.refs.includes('pdd:8.5'));
    expect(position.length).toBeGreaterThan(0);
    expect(position.some(f => f.severity === 'violation')).toBe(false);
    expect(position.every(f => f.trace.tramTrackId === undefined)).toBe(true);
  });
  it('train is excluded from ordinary junction, signal, sign and manoeuvre findings', () => {
    const locomotive = train([{ t: 0, x: -30, y: 1.75, h: 0 }, { t: 3, x: -5, y: 1.75, h: 0 },
      { t: 5, x: 1.75, y: 10, h: Math.PI / 2 }, { t: duration, x: 1.75, y: 30, h: Math.PI / 2 }]);
    const scene = makeScene([locomotive]);
    scene.roads.push(road('cross-road', { pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }));
    scene.signs = [{ id: 'stop', kind: '2.5', x: -15, y: 4, angle: 0 }];
    scene.lights = [{ id: 'red', x: -10, y: 4, angle: 0, green: 1, yellow: 1, red: 100, offset: 5, lineLength: 3.5 }];
    const result = analyzeRules(analyzeTechnical(scene, timeline([locomotive])));
    expect(result.section.priorityGraphs.every(g => g.participants.every(p => p.actorId !== 'train'))).toBe(true);
    expect(result.section.findings.filter(f => f.actorId === 'train' && f.severity === 'violation')).toHaveLength(0);
  });
  it('train/car collision uses railway priority before ordinary junction attribution', () => {
    const a = driving(), locomotive = train(), specs = [a, locomotive], scene = makeScene(specs);
    scene.roads.push(road('cross-road', { pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }));
    const result = analyzeRules(analyzeTechnical(scene, timeline(specs, [{ a: 'car', b: 'train', t: 4 }])));
    expect(result.section.collisions[0].title.toLowerCase()).toContain('поезд');
    expect(result.section.findings.some(f => f.actorId === 'car' && f.causal && f.refs.includes('pdd:15.1'))).toBe(true);
    expect(result.section.findings.some(f => f.actorId === 'train' && f.severity === 'violation' && f.refs.some(ref => ref.startsWith('pdd:13.')))).toBe(false);
  });
  it('parked train is not treated as a road vehicle stopping or failing ordinary manoeuvre duties', () => {
    const locomotive = train([{ t: 0, x: 0, y: 0, h: Math.PI / 2, v: 0 }, { t: duration, x: 0, y: 0, h: Math.PI / 2, v: 0 }]);
    const scene = makeScene([locomotive]);
    scene.roads[0].features = ['railway-crossing'];
    const result = analyzeRules(analyzeTechnical(scene, timeline([locomotive])));
    expect(result.section.findings.filter(f => f.actorId === 'train' && f.severity === 'violation')).toHaveLength(0);
  });
});

describe('railway preset simulation and legal integration', () => {
  const sceneOf = (id: string) => normalizeScene(JSON.parse(JSON.stringify(PRESETS.find(p => p.id === id)!.build())));
  it('red-entry preset produces a train collision and the established special crossing offence', () => {
    const scene = sceneOf('railway-red-entry'), tl = simulate(scene), report = analyze(scene, tl);
    expect(RAILWAY_PRESETS.every(p => PRESETS.includes(p))).toBe(true);
    expect(tl.collisions.some(c => c.kind === 'vv')).toBe(true);
    expect(report.rules.findings.some(f => f.actorId === scene.actors[0].id && f.severity === 'violation'
      && (f.trace.ruleCodes as string[] | undefined)?.includes('rule:railway-prohibited-entry'))).toBe(true);
    expect(report.findings.some(f => f.actorId === scene.actors[0].id && f.refs.includes('koap:12.10#1'))).toBe(true);
    expect(report.findings.some(f => f.actorId === scene.actors[0].id && f.refs.includes('pdd:15.4') && f.refs.includes('koap:12.10#2'))).toBe(false);
    expect(report.findings.some(f => f.refs.includes('koap:12.10#3'))).toBe(false);
  });
  it('compliant preset actually stops before the measured boundary while the train passes', () => {
    const scene = sceneOf('railway-stop-before-barrier'), tl = simulate(scene), report = analyze(scene, tl);
    expect(tl.collisions).toHaveLength(0);
    const car = tl.tracks.get(scene.actors[0].id)!, locomotive = tl.tracks.get(scene.actors[1].id)!;
    expect([...car.v].filter(v => v === 0).length * tl.dt).toBeGreaterThanOrEqual(3);
    const boundaryX = -scene.railwayCrossings![0].length / 2 - scene.railwayCrossings![0].stopLineDistance!;
    expect(Math.max(...car.x) + actorSpec(scene.actors[0]).length / 2).toBeLessThanOrEqual(boundaryX + 0.05);
    expect(locomotive.y[locomotive.y.length - 1]).toBeGreaterThan(0);
    expect(report.rules.findings.some(f => f.actorId === scene.actors[0].id && f.severity === 'violation'
      && (f.refs.includes('pdd:15.3') || f.refs.includes('pdd:15.4')))).toBe(false);
  });
  it('jam entry followed by an explicitly non-forced stop selects the special part once', () => {
    const a = observed('car', [{ t: 0, x: -30, y: 1.75, v: 8 }, { t: 3, x: -6, y: 1.75, v: 8 },
      { t: 4, x: 0, y: 1.75, v: 0 }, { t: duration, x: 0, y: 1.75, v: 0 }], { railwayContext: { forcedStop: false }, stopContext: { reason: 'other-voluntary', intentional: true } });
    const scene = makeScene([a], crossing({ exitBlocked: true })), report = analyze(scene, timeline([a]));
    expect(report.rules.findings.some(f => f.actorId === 'car' && f.severity === 'violation' && f.refs.includes('pdd:15.3'))).toBe(true);
    expect(report.findings.some(f => f.actorId === 'car' && f.refs.includes('koap:12.10#1'))).toBe(true);
    expect(report.findings.some(f => f.actorId === 'car' && f.refs.includes('koap:12.10#2'))).toBe(false);
  });
  it('known exit jam without an established stop stays within the general crossing part', () => {
    const a = driving(), scene = makeScene([a], crossing({ exitBlocked: true })), report = analyze(scene, timeline([a]));
    expect(report.findings.some(f => f.actorId === 'car' && f.refs.includes('koap:12.10#2'))).toBe(true);
    expect(report.findings.some(f => f.actorId === 'car' && f.refs.includes('koap:12.10#1'))).toBe(false);
  });
});
