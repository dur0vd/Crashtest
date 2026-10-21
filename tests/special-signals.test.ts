import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import type { Ctx } from '../src/analysis/context';
import { applySpecialDeparture, checkSpecialSignals, specialPriority } from '../src/analysis/special-signals';
import { analyzeRules } from '../src/analysis/traffic-rules';
import { analyzeTechnical, prepare } from '../src/analysis/technical';
import type { FindingInput } from '../src/analysis/types';
import { angDiff } from '../src/geom';
import { emptyScene, type Actor, type Road, type Scene, type SpecialSignals } from '../src/scene';
import { DT, type Collision, type Timeline, type Track } from '../src/sim';

// Independent observations: neither positions nor speeds are produced by the
// simulator under test. Data after a declared contact are outside the analysis.
type Key = { t: number; x: number; y: number; h?: number; v?: number };
type Observed = { actor: Actor; keys: Key[] };
type Contact = { a: string; b: string; t: number; kind?: Collision['kind'] };
const duration = 8;
const road = (options: Partial<Road> = {}): Road => ({ id: 'road', pts: [{ x: -200, y: 0 }, { x: 200, y: 0 }],
  lanes: 1, center: 'dashed', oneWay: false, smooth: false, zone: 'city', ...options });

function observed(id: string, keys: Key[], options: Partial<Actor> = {}): Observed {
  const first = keys[0], next = keys[1] ?? first;
  const speed = first.v ?? Math.hypot(next.x - first.x, next.y - first.y) / Math.max(DT, next.t - first.t);
  return { keys, actor: { id, kind: 'vehicle', type: 'car', x: first.x, y: first.y,
    heading: first.h ?? Math.atan2(next.y - first.y, next.x - first.x), speed: speed * 3.6,
    delay: 0, color: '#28b', flags: { drunk: false, noLicense: false, flees: false },
    path: keys.slice(1).map(key => ({ x: key.x, y: key.y, v: (key.v ?? speed) * 3.6 })), ...options } };
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
    return { idx, frame, t: contact.t, a: contact.a, b: contact.b, kind: contact.kind ?? 'vv',
      point: { x: (a.x[frame] + b.x[frame]) / 2, y: (a.y[frame] + b.y[frame]) / 2 }, n: { x: 1, y: 0 },
      vA, vB, rel: Math.hypot(vA.x - vB.x, vA.y - vB.y), dvA: 0, dvB: 0 };
  });
  return { dt: DT, n, duration, mu: 0.7, tracks, collisions };
}
function sceneFor(specs: Observed[], roads: Road[] = [road()]): Scene {
  const scene = emptyScene();
  scene.env.accidentDate = '2026-10-20T12:00';
  scene.env.duration = duration;
  scene.actors = specs.map(spec => spec.actor);
  scene.roads = roads;
  return scene;
}
function context(specs: Observed[], contacts: Contact[] = [], roads: Road[] = [road()]): Ctx {
  return { ...prepare(sceneFor(specs, roads), timeline(specs, contacts)), findings: [], priorityGraphs: [], events: [],
    onc: new Map(), lightViolations: new Map(), stopSkipped: new Map(), pedEntry: new Map() };
}
function run(specs: Observed[], contacts: Contact[] = [], opposingId?: string, roads?: Road[]): Ctx {
  const ctx = context(specs, contacts, roads);
  if (opposingId) ctx.onc.set(opposingId, { frames: Array.from({ length: ctx.tl.n }, (_, frame) => frame), center: 'dashed', lanes: 1, tramTrack: false });
  checkSpecialSignals(ctx, finding => ctx.findings.push({ causal: false, ...finding }));
  return ctx;
}
const withRef = (ctx: Ctx, id: string, ref: string) => ctx.findings.filter(finding => finding.actorId === id && finding.refs.includes(ref));
const violated = (ctx: Ctx, id: string, ref: string) => withRef(ctx, id, ref).filter(finding => finding.severity === 'violation');
function crossing(signals: Partial<SpecialSignals> = {}) {
  const special = observed('special', [{ t: 0, x: 0, y: -40, h: Math.PI / 2, v: 10 }, { t: duration, x: 0, y: 40, h: Math.PI / 2, v: 10 }],
    { specialSignals: { beacon: 'blue', siren: true, urgentDuty: true, safetyEnsured: false, colorScheme: true, ...signals },
      specialInteractions: [{ otherId: 'ordinary', yieldingVerified: false }] });
  const ordinary = observed('ordinary', [{ t: 0, x: -40, y: 1.75, h: 0, v: 10 }, { t: duration, x: 40, y: 1.75, h: 0, v: 10 }],
    { specialInteractions: [{ otherId: 'special', yielded: false, beaconVisible: true }] });
  const contact = { a: 'ordinary', b: 'special', t: 4 };
  return { special, ordinary, contact, specs: [ordinary, special] };
}

describe('3.1 и 3.2: отступление и обязанность уступить имеют разные условия', () => {
  it('синий маячок без звука не создаёт специального преимущества', () => {
    const data = crossing({ siren: false }), ctx = run(data.specs, [data.contact]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(specialPriority(ctx, 'ordinary', 'special', 4 / DT)).toBeNull();
  });
  it.each(['blue', 'blue-red'] as const)('%s со звуком сохраняет отдельные нарушения обоих водителей', beacon => {
    const data = crossing({ beacon }), ctx = run(data.specs, [data.contact]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.causal)).toBe(true);
    expect(violated(ctx, 'special', 'pdd:3.1').some(finding => finding.causal)).toBe(true);
  });
  it('неизвестный звук не превращается ни во включённый, ни в выключенный', () => {
    const data = crossing({ siren: undefined }), ctx = run(data.specs, [data.contact]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it.each(['yellow', 'orange', 'white', 'none', 'unknown'] as const)('%s не даёт преимущества даже со звуком', beacon => {
    const data = crossing({ beacon }), ctx = run(data.specs, [data.contact]);
    expect(specialPriority(ctx, 'ordinary', 'special', 4 / DT)).toBeNull();
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
  });
  it('обязанность остальных по 3.2 не исчезает от отсутствия неотложного задания у спецТС', () => {
    const data = crossing({ urgentDuty: false }), ctx = run(data.specs, [data.contact]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(1);
  });
  it('два ТС со спецсигналами сами по себе не устанавливают очередность', () => {
    const data = crossing();
    data.ordinary.actor.specialSignals = { beacon: 'blue', siren: true };
    const ctx = run(data.specs, [data.contact]);
    expect(specialPriority(ctx, 'ordinary', 'special', 4 / DT)).toBeNull();
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('заданный факт уступания, противоречащий поперечному контакту, не даёт категоричный вывод', () => {
    const data = crossing();
    data.ordinary.actor.specialInteractions![0].yielded = true;
    const ctx = run(data.specs, [data.contact]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.trace?.contradictedYield === true)).toBe(true);
  });
  it('отсутствие видимости не подменяется выводом о восприятии сирены', () => {
    const data = crossing();
    data.ordinary.actor.specialInteractions![0].beaconVisible = false;
    const ctx = run(data.specs, [data.contact]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('задний контакт не доказывает возможность освободить полосу ведущим автомобилем', () => {
    const ordinary = observed('ordinary', [{ t: 0, x: -20, y: 1.75, h: 0, v: 5 }, { t: duration, x: 20, y: 1.75, h: 0, v: 5 }]);
    const special = observed('special', [{ t: 0, x: -40, y: 1.75, h: 0, v: 10 }, { t: duration, x: 40, y: 1.75, h: 0, v: 10 }],
      { specialSignals: { beacon: 'blue', siren: true } });
    const ctx = run([ordinary, special], [{ a: 'special', b: 'ordinary', t: 4 }]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('спецТС, наехавшее сзади на стоящий автомобиль, сохраняет собственную причинную оценку безопасности', () => {
    const ordinary = observed('ordinary', [{ t: 0, x: 0, y: 1.75, h: 0, v: 0 }, { t: duration, x: 0, y: 1.75, h: 0, v: 0 }]);
    const special = observed('special', [{ t: 0, x: -40, y: 1.75, h: 0, v: 10 }, { t: duration, x: 40, y: 1.75, h: 0, v: 10 }],
      { specialSignals: { beacon: 'blue', siren: true, urgentDuty: false, safetyEnsured: false } });
    const specs = [ordinary, special];
    const report = analyze(sceneFor(specs), timeline(specs, [{ a: 'special', b: 'ordinary', t: 3.55 }]));
    expect(report.rules.findings.some(finding => finding.actorId === 'special' && finding.severity === 'violation'
      && finding.causal && (finding.refs.includes('pdd:9.10') || finding.refs.includes('pdd:10.1')))).toBe(true);
    expect(report.rules.findings.some(finding => finding.actorId === 'ordinary' && finding.severity === 'violation'
      && finding.refs.includes('pdd:3.2'))).toBe(false);
  });
  it('удалённое движение по независимой траектории не создаёт обязанности уступить этой паре', () => {
    const ordinary = observed('ordinary', [{ t: 0, x: -40, y: 100, v: 10 }, { t: duration, x: 40, y: 100, v: 10 }],
      { specialInteractions: [{ otherId: 'special', yielded: false }] });
    const special = crossing().special;
    const ctx = run([ordinary, special]);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
  });
});

describe('область допускаемых отступлений по 3.1', () => {
  const formal = (refs: string[], trace: FindingInput['trace'] = {}): FindingInput => ({ actorId: 'special',
    severity: 'violation', title: 'Наблюдаемое требование', detail: 'Установлен формальный факт.', t: 1, refs, trace });
  function evaluated(signals: Partial<SpecialSignals>, finding: FindingInput) {
    const special = crossing({ safetyEnsured: true, siren: false, ...signals }).special;
    return applySpecialDeparture(context([special]), finding);
  }
  it.each([
    ['сигнал', ['pdd:6.2', 'pdd:6.13', 'rule:signal']],
    ['скорость', ['pdd:10.2', 'rule:speed']],
    ['остановка перед 2.5', ['sign:2.5', 'rule:sign-requirement']],
    ['разметка', ['marking:1.1', 'rule:opposing-lane']],
    ['манёвр', ['pdd:8.5', 'rule:extreme-position']],
  ])('%s: синий + задание + безопасность допускают отступление без сирены', (_name, refs) => {
    const result = evaluated({}, formal(refs as string[]));
    expect(result.severity).toBe('info');
    expect(result.refs).toContain('pdd:3.1');
    expect(result.refs.some(ref => ref.startsWith('rule:') || ref.startsWith('koap:'))).toBe(false);
    expect(result.trace?.compliance).toBe('выполнено');
  });
  it.each(['urgentDuty', 'safetyEnsured'] as const)('явно отсутствующее условие %s сохраняет исходное требование', fact => {
    expect(evaluated({ [fact]: false }, formal(['pdd:6.2', 'rule:signal'])).severity).toBe('violation');
  });
  it.each(['urgentDuty', 'safetyEnsured'] as const)('неизвестное условие %s сохраняет неопределённость без состава', fact => {
    const result = evaluated({ [fact]: undefined }, formal(['pdd:6.2', 'rule:signal']));
    expect(result.severity).toBe('contributing');
    expect(result.refs).not.toContain('rule:signal');
    expect(result.trace?.compliance).toBe('не определить');
  });
  it.each([
    ['pdd:7.2'], ['pdd:19.2'], ['pdd:22.9'], ['pdd:23.2'], ['pdd:24.8'],
  ])('%s не входит в разрешённые разделы', ref => {
    expect(evaluated({}, formal([ref])).severity).toBe('violation');
  });
  it('запрещающий регулировщик сохраняет силу', () => {
    const result = evaluated({}, formal(['pdd:6.10', 'pdd:6.13', 'rule:signal'], { light: { kind: 'controller' } }));
    expect(result.severity).toBe('violation');
    expect(result.refs).toContain('rule:signal');
  });
  it('утверждение о безопасности не стирает отдельное установленное причинное опасное действие', () => {
    const finding = { ...formal(['pdd:10.1']), causal: true };
    expect(evaluated({}, finding).severity).toBe('violation');
  });
  function controlledJourney(controller = false) {
    const special = observed('special', [{ t: 0, x: -40, y: 1.75, h: 0, v: 10 }, { t: duration, x: 40, y: 1.75, h: 0, v: 10 }],
      { specialSignals: { beacon: 'blue', siren: false, urgentDuty: true, safetyEnsured: true } });
    const scene = sceneFor([special]);
    scene.lights = [{ id: 'control', x: -10, y: 1.75, angle: 0, lineLength: 3.5, green: 0, yellow: 0, red: 60, offset: 0,
      ...(controller ? { kind: 'controller' as const, controllerGesture: 'stop' as const, controllerTargetHeading: 0 } : {}) }];
    return { special, scene };
  }
  it('реальный проход красной стоп-линии без сирены сохраняет разрешённое отступление без скрытого флага нарушения', () => {
    const { special, scene } = controlledJourney();
    const { ctx, section } = analyzeRules(analyzeTechnical(scene, timeline([special])));
    expect(ctx.gates.some(gate => gate.light?.id === 'control')).toBe(true);
    expect(section.findings.some(finding => finding.actorId === 'special' && finding.refs.includes('pdd:3.1')
      && finding.refs.includes('pdd:6.13') && finding.severity === 'info')).toBe(true);
    expect(ctx.lightViolations.has('special')).toBe(false);
    expect(section.findings.some(finding => finding.severity === 'violation' && finding.refs.includes('pdd:6.13'))).toBe(false);
  });
  it('реальный проход линии регулировщика остаётся нарушением при тех же специальных условиях', () => {
    const { special, scene } = controlledJourney(true);
    const { ctx, section } = analyzeRules(analyzeTechnical(scene, timeline([special])));
    expect(ctx.gates.some(gate => gate.light?.id === 'control')).toBe(true);
    expect(section.findings.some(finding => finding.actorId === 'special' && finding.severity === 'violation'
      && (finding.refs.includes('pdd:6.10') || finding.refs.includes('pdd:6.11')))).toBe(true);
    expect(ctx.lightViolations.has('special')).toBe(true);
  });
  it('проезд 2.5 при разрешённом отступлении не сохраняет скрытый флаг пропущенной остановки', () => {
    const { special, scene } = controlledJourney();
    scene.lights = [];
    scene.signs = [{ id: 'stop', x: -10, y: 1.75, angle: 0, kind: '2.5' }];
    const { ctx, section } = analyzeRules(analyzeTechnical(scene, timeline([special])));
    expect(ctx.gates.some(gate => gate.sign?.kind === '2.5')).toBe(true);
    expect(ctx.stopSkipped.has('special')).toBe(false);
    expect(section.findings.some(finding => finding.actorId === 'special' && finding.refs.includes('sign:2.5')
      && finding.refs.includes('pdd:3.1') && finding.severity === 'info')).toBe(true);
  });
});

describe('3.3: приближение к стоящему спецТС', () => {
  function approach(facts?: NonNullable<Actor['specialInteractions']>[number]) {
    const special = observed('special', [{ t: 0, x: 0, y: 6, v: 0 }, { t: duration, x: 0, y: 6, v: 0 }],
      { specialSignals: { beacon: 'blue', siren: false } });
    const ordinary = observed('ordinary', [{ t: 0, x: -40, y: 1.75, v: 10 }, { t: duration, x: 40, y: 1.75, v: 10 }],
      { specialInteractions: facts ? [facts] : undefined });
    return run([ordinary, special]);
  }
  it('явно установленная невозможность немедленной остановки нарушает 3.3 без выдуманного предела скорости', () => {
    const ctx = approach({ otherId: 'special', beaconVisible: true, immediateStopPossible: false });
    expect(violated(ctx, 'ordinary', 'pdd:3.3')).toHaveLength(1);
    expect(violated(ctx, 'ordinary', 'pdd:3.3')[0].refs.some(ref => ref.startsWith('rule:'))).toBe(false);
    expect(violated(ctx, 'ordinary', 'pdd:3.3')[0].trace).not.toHaveProperty('safeKmh');
  });
  it('при неизвестной возможности остановиться вывод остаётся неопределённым', () => {
    const ctx = approach({ otherId: 'special', beaconVisible: true });
    expect(violated(ctx, 'ordinary', 'pdd:3.3')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.3').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('отсутствие всего парного объекта не скрывает неизвестность условий 3.3', () => {
    const ctx = approach();
    expect(violated(ctx, 'ordinary', 'pdd:3.3')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.3').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('неизвестная видимость не равна установленной видимости', () => {
    const ctx = approach({ otherId: 'special', immediateStopPossible: false });
    expect(violated(ctx, 'ordinary', 'pdd:3.3')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.3').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('известное отсутствие видимости не создаёт категоричное нарушение', () => {
    expect(violated(approach({ otherId: 'special', beaconVisible: false, immediateStopPossible: false }), 'ordinary', 'pdd:3.3')).toHaveLength(0);
  });
  it('установленная готовность остановиться даёт положительный вывод', () => {
    const ctx = approach({ otherId: 'special', beaconVisible: true, immediateStopPossible: true });
    expect(withRef(ctx, 'ordinary', 'pdd:3.3').some(finding => finding.severity === 'info' && finding.trace?.compliance === 'выполнено')).toBe(true);
  });
});

describe('самостоятельные запреты обгона и опережения по 3.2', () => {
  function passing(beacon: 'blue' | 'blue-red', colorScheme: boolean | undefined, opposing: boolean,
    extra: { otherSignals?: SpecialSignals; beaconVisible?: boolean; laneSeparation?: number } = {}) {
    const special = observed('special', [{ t: 0, x: 0, y: 1.75, h: 0, v: 5 }, { t: duration, x: 40, y: 1.75, h: 0, v: 5 }],
      { specialSignals: { beacon, siren: true, colorScheme } });
    const otherY = opposing ? -1.75 : 1.75 + (extra.laneSeparation ?? 3.5);
    const ordinary = observed('ordinary', [{ t: 0, x: -20, y: otherY, h: 0, v: 12.5 },
      { t: duration, x: 80, y: otherY, h: 0, v: 12.5 }],
      { specialSignals: extra.otherSignals, specialInteractions: [{ otherId: 'special', beaconVisible: extra.beaconVisible }] });
    return run([ordinary, special], [], opposing ? 'ordinary' : undefined,
      opposing ? [road()] : [road({ lanes: extra.laneSeparation && extra.laneSeparation > 4 ? 3 : 2 })]);
  }
  it('синий с цветосхемами запрещает обгон с выездом на встречную', () => {
    expect(violated(passing('blue', true, true), 'ordinary', 'pdd:3.2')).toHaveLength(1);
  });
  it('тот же синий не создаёт отдельного запрета попутного опережения', () => {
    expect(violated(passing('blue', true, false), 'ordinary', 'pdd:3.2')).toHaveLength(0);
  });
  it('сине-красный запрещает и попутное опережение независимо от цветосхем', () => {
    const finding = violated(passing('blue-red', false, false), 'ordinary', 'pdd:3.2');
    expect(finding).toHaveLength(1);
    expect(finding[0].refs.some(ref => ref.startsWith('rule:special-priority'))).toBe(false);
  });
  it('на широкой дороге запрет опережения не исчезает через одну попутную полосу', () => {
    expect(violated(passing('blue-red', false, false, { laneSeparation: 7 }), 'ordinary', 'pdd:3.2')).toHaveLength(1);
  });
  it('продольное прохождение на отдельной параллельной дороге не является опережением спецТС на этой дороге', () => {
    const special = observed('special', [{ t: 0, x: 0, y: 1.75, h: 0, v: 5 }, { t: duration, x: 40, y: 1.75, h: 0, v: 5 }],
      { specialSignals: { beacon: 'blue-red', siren: true } });
    const ordinary = observed('ordinary', [{ t: 0, x: -20, y: 8.75, h: 0, v: 12.5 }, { t: duration, x: 80, y: 8.75, h: 0, v: 12.5 }]);
    const parallel = road({ id: 'parallel', pts: [{ x: -200, y: 7 }, { x: 200, y: 7 }] });
    const ctx = run([ordinary, special], [], undefined, [road(), parallel]);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
  });
  it('синий без специальных цветосхем не подпадает под отдельный запрет обгона', () => {
    expect(violated(passing('blue', false, true), 'ordinary', 'pdd:3.2')).toHaveLength(0);
  });
  it('неизвестные цветосхемы не подтверждают этот самостоятельный запрет', () => {
    const ctx = passing('blue', undefined, true);
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('собственные спецсигналы обгоняющего не отменяют запрет раздела 3', () => {
    const ctx = passing('blue', true, true, { otherSignals: { beacon: 'blue', siren: true, urgentDuty: true, safetyEnsured: true } });
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(1);
  });
  it('известное отсутствие видимости не подменяется категоричным выводом о восприятии при обгоне', () => {
    const ctx = passing('blue', true, true, { beaconVisible: false });
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(0);
    expect(withRef(ctx, 'ordinary', 'pdd:3.2').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('фактическая попытка обгона не становится разрешённой от прекращения до полного опережения', () => {
    const special = observed('special', [{ t: 0, x: 0, y: 1.75, h: 0, v: 5 }, { t: duration, x: 40, y: 1.75, h: 0, v: 5 }],
      { specialSignals: { beacon: 'blue', siren: true, colorScheme: true } });
    const ordinary = observed('ordinary', [{ t: 0, x: -20, y: 1.75, h: 0, v: 10 }, { t: 2, x: -4, y: -1.75, h: 0, v: 8 },
      { t: 3, x: 4, y: -1.75, h: 0, v: 0 }, { t: duration, x: 4, y: -1.75, h: 0, v: 0 }]);
    // The intended return is an authored plan, not a fabricated measured pass.
    ordinary.actor.path = [{ x: -4, y: -1.75, v: 36 }, { x: 80, y: -1.75, v: 36 }, { x: 100, y: 1.75, v: 36 }];
    const ctx = context([ordinary, special]);
    ctx.onc.set('ordinary', { frames: Array.from({ length: ctx.tl.n - Math.round(1.5 / DT) }, (_, frame) => frame + Math.round(1.5 / DT)),
      center: 'dashed', lanes: 1, tramTrack: false });
    checkSpecialSignals(ctx, finding => ctx.findings.push({ causal: false, ...finding }));
    expect(violated(ctx, 'ordinary', 'pdd:3.2')).toHaveLength(1);
  });
});

describe('соседний ряд и установленная помеха организованному движению', () => {
  function alongside(beacon: 'blue' | 'blue-red', blocked?: boolean) {
    const special = observed('special', [{ t: 0, x: 0, y: 1.75, h: 0, v: 10 }, { t: duration, x: 80, y: 1.75, h: 0, v: 10 }],
      { specialSignals: { beacon, siren: true } });
    const ordinary = observed('ordinary', [{ t: 0, x: 0, y: 5.25, h: 0, v: 10 }, { t: duration, x: 80, y: 5.25, h: 0, v: 10 }],
      { specialInteractions: [{ otherId: 'special', organizedMovementObstructed: blocked }] });
    return run([ordinary, special], [], undefined, [road({ lanes: 2 })]);
  }
  it('сине-красный: равная скорость и явно установленная помеха нарушают самостоятельный запрет', () => {
    const findings = violated(alongside('blue-red', true), 'ordinary', 'pdd:3.2');
    expect(findings).toHaveLength(1);
    expect(findings[0].refs.some(ref => ref.startsWith('rule:special-priority'))).toBe(false);
  });
  it.each([undefined, false])('не устанавливает помеху из одной равной скорости (%s)', blocked => {
    expect(violated(alongside('blue-red', blocked), 'ordinary', 'pdd:3.2')).toHaveLength(0);
  });
  it('параллельный синий без красного не создаёт именно этот отдельный запрет', () => {
    expect(violated(alongside('blue', true), 'ordinary', 'pdd:3.2')).toHaveLength(0);
  });
});

describe('3.4: основания обязательного предупреждающего маячка', () => {
  const reasons: NonNullable<SpecialSignals['warningReason']>[] = ['road-work', 'recovery', 'oversized', 'high-danger-cargo',
    'heavy-sign-exemption', 'oversize-escort', 'dangerous-escort', 'cycling-training-escort', 'children-group'];
  function warning(beacon: SpecialSignals['beacon'], warningReason?: SpecialSignals['warningReason']) {
    const special = observed('special', [{ t: 0, x: -20, y: 1.75, v: 5 }, { t: duration, x: 20, y: 1.75, v: 5 }],
      { specialSignals: { beacon, warningReason } });
    return run([special]);
  }
  it.each(reasons)('%s требует включённого жёлтого/оранжевого, без выдуманной статьи за неуступание', reason => {
    const findings = violated(warning('none', reason), 'special', 'pdd:3.4');
    expect(findings).toHaveLength(1);
    expect(findings[0].refs.some(ref => ref.startsWith('rule:special-priority'))).toBe(false);
  });
  it.each(['yellow', 'orange'] as const)('%s выполняет явно установленную обязанность', beacon => {
    expect(violated(warning(beacon, 'road-work'), 'special', 'pdd:3.4')).toHaveLength(0);
  });
  it('неизвестное включение маячка даёт неопределённость', () => {
    const ctx = warning('unknown', 'children-group');
    expect(violated(ctx, 'special', 'pdd:3.4')).toHaveLength(0);
    expect(withRef(ctx, 'special', 'pdd:3.4').some(finding => finding.severity === 'contributing')).toBe(true);
  });
  it('не предполагает обязанность 3.4 только из отсутствующего маячка без установленного основания', () => {
    expect(violated(warning('none'), 'special', 'pdd:3.4')).toHaveLength(0);
  });
});

describe('часть 12.17 выбирается только для установленного неуступания', () => {
  it.each([
    ['blue', false, 'koap:12.17#1'], ['blue', true, 'koap:12.17#2'],
    ['blue-red', true, 'koap:12.17#2'], ['blue-red', false, 'koap:12.17#3'],
  ] as const)('%s / цветосхемы %s → %s', (beacon, colorScheme, expected) => {
    const data = crossing({ beacon, colorScheme });
    const report = analyze(sceneFor(data.specs), timeline(data.specs, [data.contact]));
    const findings = report.findings.filter(finding => finding.actorId === 'ordinary' && finding.refs.includes('pdd:3.2'));
    expect(findings.some(finding => finding.refs.includes(expected))).toBe(true);
    const otherParts = ['koap:12.17#1', 'koap:12.17#2', 'koap:12.17#3'].filter(ref => ref !== expected);
    expect(findings.some(finding => otherParts.some(ref => finding.refs.includes(ref)))).toBe(false);
    expect(report.findings.some(finding => finding.actorId === 'special' && finding.refs.some(ref => ref.startsWith('koap:12.17')))).toBe(false);
  });
  it('при неизвестной цветосхеме сохраняет требование ПДД без назначения части', () => {
    const data = crossing({ colorScheme: undefined });
    const report = analyze(sceneFor(data.specs), timeline(data.specs, [data.contact]));
    const findings = report.findings.filter(finding => finding.actorId === 'ordinary' && finding.refs.includes('pdd:3.2'));
    expect(findings.some(finding => finding.severity === 'violation')).toBe(true);
    expect(findings.some(finding => finding.refs.some(ref => ref.startsWith('koap:12.17')))).toBe(false);
  });
});

it('количественное сравнение с обычным пределом не объявляет разрешённое отступление причинным превышением при наезде на пешехода', () => {
  const special = observed('special', [{ t: 0, x: -100, y: 1.75, h: 0, v: 25 }, { t: duration, x: 100, y: 1.75, h: 0, v: 25 }],
    { specialSignals: { beacon: 'blue', siren: false, urgentDuty: true, safetyEnsured: true } });
  // At t=2 the pedestrian enters the 7 m carriageway; at t=4 the paths meet.
  // Synthetic measured speed, not a reference walking-speed catalogue value.
  const pedestrian = observed('pedestrian', [{ t: 0, x: 0, y: -8.75, h: Math.PI / 2, v: 2.625 },
    { t: duration, x: 0, y: 12.25, h: Math.PI / 2, v: 2.625 }], { kind: 'pedestrian', type: 'adult' });
  const specs = [special, pedestrian];
  const report = analyze(sceneFor(specs), timeline(specs, [{ a: 'special', b: 'pedestrian', t: 4, kind: 'vp' }]));
  const collision = report.rules.collisions[0];
  const assessment = collision.tech.find(item => item.actorId === 'special');
  expect(assessment?.avoidable).toBe(false);
  expect(assessment?.avoidableAtLimit).toBe(true);
  expect(report.rules.findings.some(finding => finding.actorId === 'special' && finding.severity === 'violation'
    && (finding.trace.ruleCodes as string[] | undefined)?.includes('rule:speed'))).toBe(false);
  expect(collision.notes.some(note => /превышение скорости.*причинной/i.test(note))).toBe(false);
});
