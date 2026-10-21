import { type Geo, type RoadHit, buildGeo, roadsAt } from '../geo';
import { type OBB, type Vec, angDiff, angleOf, rightOf, sub, add, mul, fromAngle, dot, segIntersect, toLocal, kmh, obbCorners, pointInObb, distToSegment } from '../geom';
import { type Timeline, DT } from '../sim';
import { type Scene, type VehicleType, VEHICLES, actorLabels, actorTitle, actorSpec, dimsOf, lightPhase, SURFACES, LANE_WIDTH } from '../scene';
import type { Info, GateEvent } from './context';
import type { TechAssessment, HarmLevel, TechnicalSection, TechnicalCollision, Trace } from './types';

export interface TechnicalContext {
  scene: Scene;
  tl: Timeline;
  geo: Geo;
  infos: Map<string, Info>;
  gates: GateEvent[];
  technical: TechnicalSection;
}
export const REACT = 1.0;
export const BRAKE_LAG = 0.2;
export const SERVICE_DECEL_Y = 3.0;

export const tOf = (k: number): number => k * DT;

export function boxAt(i: Info, k: number): OBB {
  const h = i.tr.h[k];
  return { cx: i.tr.x[k] + Math.cos(h) * i.shift, cy: i.tr.y[k] + Math.sin(h) * i.shift, hl: i.hl, hw: i.hw, a: h };
}
export const posAt = (i: Info, k: number): Vec => ({ x: i.tr.x[k], y: i.tr.y[k] });
export const frontAt = (i: Info, k: number): Vec => add(posAt(i, k), mul(fromAngle(i.tr.h[k]), i.hl + i.shift));

export function prepare(scene: Scene, tl: Timeline): TechnicalContext {
  const geo = buildGeo(scene);
  const labels = actorLabels(scene);
  const infos = new Map<string, Info>();
  const mu = tl.mu;
  for (const a of scene.actors) {
    const tr = tl.tracks.get(a.id)!;
    const sp = dimsOf(a);
    const base = actorSpec(a);
    let k0 = 0;
    while (k0 < tl.n && !tr.present[k0]) k0++;
    let kEnd = tl.n - 1;
    for (const c of tl.collisions) if ((c.a === a.id || c.b === a.id) && c.frame < kEnd) kEnd = c.frame;
    const trav = new Float32Array(tl.n);
    for (let k = Math.max(1, k0 + 1); k < tl.n; k++) {
      trav[k] = trav[k - 1] + Math.hypot(tr.x[k] - tr.x[k - 1], tr.y[k] - tr.y[k - 1]);
    }
    const isVeh = a.kind === 'vehicle';
    const vs = isVeh ? VEHICLES[a.type as VehicleType] : null;
    infos.set(a.id, {
      a,
      title: actorTitle(a, labels),
      label: labels.get(a.id) ?? a.id,
      tr,
      isVeh,
      hl: sp.length / 2,
      hw: sp.width / 2,
      shift: sp.shift,
      hlBase: base.length / 2,
      hwBase: base.width / 2,
      mass: sp.mass,
      k0,
      kEnd,
      trav,
      brake: a.railwayTrain?.brakeDecel ?? (vs ? Math.min(vs.brakeCap ?? Infinity, mu * 9.81 * vs.brakeFactor) : 3),
      rail: !!vs?.rail,
    });
  }
  return {
    scene,
    tl,
    geo,
    infos,
    gates: [],
    technical: { nearMisses: [], overtakes: [], points: [], events: [], collisions: [], assumptions: [] },
  };
}

export function collectGates(ctx: TechnicalContext): void {
  for (const i of ctx.infos.values()) {
    if (!i.isVeh) continue;
    for (let k = Math.max(1, i.k0 + 1); k <= i.kEnd; k++) {
      if (!i.tr.present[k - 1]) continue;
      const p0 = frontAt(i, k - 1);
      const p1 = frontAt(i, k);
      const dir = fromAngle(i.tr.h[k]);
      for (const sg of ctx.geo.signs) {
        if (dot(dir, fromAngle(sg.sign.angle)) < 0.5) continue;
        if (segIntersect(p0, p1, sg.gate.a, sg.gate.b)) {
          ctx.gates.push({ actorId: i.a.id, frame: k, dist: i.trav[k], sign: sg.sign });
        }
      }
      for (const lg of ctx.geo.lights) {
        if (dot(dir, fromAngle(lg.light.angle)) < 0.3) continue;
        if (segIntersect(p0, p1, lg.line.a, lg.line.b)) {
          ctx.gates.push({ actorId: i.a.id, frame: k, dist: i.trav[k], light: lg.light });
        }
      }
    }
  }
}

interface OtherRef {
  id: string;
  pos: (k: number) => Vec;
  speed: (k: number) => number;
  present: (k: number) => boolean;
  ped: boolean;
}

export function otherOf(ctx: TechnicalContext, id: string): OtherRef | null {
  const o = ctx.infos.get(id);
  if (o) {
    return {
      id,
      pos: (k) => posAt(o, k),
      speed: (k) => o.tr.v[k],
      present: (k) => !!o.tr.present[k],
      ped: !o.isVeh,
    };
  }
  const ob = ctx.geo.obstacles.find((x) => x.item.id === id);
  if (ob) {
    const p = { x: ob.box.cx, y: ob.box.cy };
    return { id, pos: () => p, speed: () => 0, present: () => true, ped: false };
  }
  return null;
}

export function techFor(ctx: TechnicalContext, v: Info, other: OtherRef, imp: number): TechAssessment | null {
  if (!v.isVeh || imp < 2) return null;
  const kLast = imp - 1;
  const inCorridor = (k: number): boolean => {
    if (!other.present(k)) return false;
    const l = toLocal(other.pos(k), { cx: v.tr.x[k], cy: v.tr.y[k], a: v.tr.h[k] });
    return l.x > 0 && l.x < 150 && Math.abs(l.y) < v.hw + 1.0;
  };
  if (!inCorridor(kLast)) return null;
  let kd = kLast;
  while (kd - 1 >= v.k0 && inCorridor(kd - 1)) kd--;
  // пешеход, вышедший на проезжую часть, считается опасностью с момента выхода
  if (other.ped) {
    let kr = kLast;
    while (kr - 1 >= v.k0 && other.present(kr - 1) && roadsAt(ctx.geo, other.pos(kr - 1)).length > 0) kr--;
    if (roadsAt(ctx.geo, other.pos(kLast)).length > 0 && kr < kd) kd = kr;
  }
  // дальность видимости 100 м
  const longitudinal = (k: number): number => toLocal(other.pos(k), { cx: v.tr.x[k], cy: v.tr.y[k], a: v.tr.h[k] }).x;
  while (kd < kLast && longitudinal(kd) > 100) kd++;
  // другой участник резко изменил скорость — опасность возникла в этот момент
  const acc = (k: number): number => (other.speed(k) - other.speed(Math.max(0, k - 5))) / (5 * DT);
  let kb = kLast;
  while (kb > kd && Math.abs(acc(kb)) <= 1.5) kb--;
  if (kb > kd) {
    let kr = kb;
    while (kr > kd && Math.abs(acc(kr - 1)) > 1.5) kr--;
    kd = Math.max(kd, kr);
  }
  const v0 = v.tr.v[kd];
  const available = Math.max(0, v.trav[kLast] - v.trav[kd]);
  const T = REACT + BRAKE_LAG;
  const a = v.brake;
  const stopDist = v0 * T + (v0 * v0) / (2 * a);
  const safe = a * (-T + Math.sqrt(T * T + (2 * available) / a));
  const res: TechAssessment = {
    trace: { actorId: v.a.id, otherId: other.id, frame: kd, impactFrame: imp, v0, t1: REACT, t2: BRAKE_LAG, j: a, S: stopDist, available, mu: ctx.tl.mu, visibility: 100, corridorHalfWidth: v.hw + 1.0 },
    ranges: { reaction: [0.8, 1.2], stopDist: [v0 * (0.8 + BRAKE_LAG) + v0 * v0 / (2 * a), v0 * (1.2 + BRAKE_LAG) + v0 * v0 / (2 * a)] },
    actorId: v.a.id,
    otherId: other.id,
    tHazard: tOf(kd),
    speedKmh: kmh(v0),
    available,
    stopDist,
    avoidable: stopDist <= available + 1e-6,
    safeKmh: kmh(Math.max(0, safe)),
  };
  return res;
}

type Region = 'front' | 'rear' | 'left' | 'right';

export function regionOf(i: Info, k: number, pt: Vec): Region {
  const b = boxAt(i, k);
  const l = toLocal(pt, { cx: b.cx, cy: b.cy, a: b.a });
  const nx = l.x / i.hl;
  const ny = l.y / i.hw;
  if (Math.abs(nx) >= Math.abs(ny)) return nx > 0 ? 'front' : 'rear';
  return ny > 0 ? 'right' : 'left';
}

function harmFor(i: Info, dvMs: number, relMs: number): HarmLevel {
  const exposed = !i.isVeh || VEHICLES[i.a.type as VehicleType].exposed;
  const v = kmh(exposed ? relMs : dvMs);
  const th = exposed ? [8, 20, 35, 50] : [10, 25, 40, 55];
  if (v >= th[3]) return 'fatal';
  if (v >= th[2]) return 'severe';
  if (v >= th[1]) return 'medium';
  if (v >= th[0]) return 'light';
  return 'none';
}

/** Просвет между двумя прямоугольниками (0 при перекрытии). */
export function gap(A: OBB, B: OBB): number {
  const ca = obbCorners(A);
  const cb = obbCorners(B);
  if (ca.some((c) => pointInObb(c, B)) || cb.some((c) => pointInObb(c, A))) return 0;
  let best = Infinity;
  const edges = (c: Vec[]): [Vec, Vec][] => [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]]];
  for (const p of ca) for (const [e0, e1] of edges(cb)) best = Math.min(best, distToSegment(p, e0, e1));
  for (const p of cb) for (const [e0, e1] of edges(ca)) best = Math.min(best, distToSegment(p, e0, e1));
  return best;
}

interface Overtake {
  overtaker: string;
  overtaken: string;
  frame: number;
  trace: Trace;
}

export function findOvertakes(ctx: TechnicalContext): Overtake[] {
  const out: Overtake[] = [];
  const list = [...ctx.infos.values()].filter((x) => x.isVeh && !x.rail);
  for (const A of list) {
    for (const B of list) {
      if (A === B) continue;
      const kMax = Math.min(A.kEnd, B.kEnd);
      let prev: number | null = null;
      for (let k = Math.max(A.k0, B.k0); k <= kMax; k += 4) {
        if (Math.abs(angDiff(A.tr.h[k], B.tr.h[k])) > 0.5) {
          prev = null;
          continue;
        }
        const l = toLocal(posAt(A, k), { cx: B.tr.x[k], cy: B.tr.y[k], a: B.tr.h[k] });
        if (Math.abs(l.y) > 4) {
          prev = null;
          continue;
        }
        if (prev !== null && prev < -(A.hl + B.hl) && l.x > A.hl + B.hl && A.tr.v[k] > B.tr.v[k]) {
          out.push({ overtaker: A.a.id, overtaken: B.a.id, frame: k, trace: { frame: k, previousLongitudinal: prev, longitudinal: l.x, lateral: l.y, combinedHalfLength: A.hl + B.hl, a: sampleTrace(ctx, A, k), b: sampleTrace(ctx, B, k) } });
          break;
        }
        prev = l.x;
      }
    }
  }
  return out;
}


/** Immutable evidence produced before any assessment of requirements. */
export function analyzeTechnical(scene: Scene, tl: Timeline): TechnicalContext {
  const ctx = prepare(scene, tl);
  collectGates(ctx);
  for (const i of ctx.infos.values()) {
    for (let k = i.k0; k <= i.kEnd; k++) {
      if (!i.tr.present[k]) continue;
      const p = posAt(i, k);
      const roads = roadsAt(ctx.geo, p).map(h => ({ roadId: h.rg.road.id, lateral: h.near.d,
        laneFromAxis: Math.floor(Math.abs(h.near.d) / LANE_WIDTH) + 1,
        forward: dot(fromAngle(i.tr.h[k]), h.near.tangent) >= 0 }));
      ctx.technical.points.push({ actorId: i.a.id, frame: k, t: tOf(k), ...p, speedKmh: kmh(i.tr.v[k]), roads,
        trace: { actorId: i.a.id, frame: k, v0: i.tr.v[k], heading: i.tr.h[k], laneWidth: LANE_WIDTH, roads } });
    }
  }
  for (const g of ctx.gates) {
    const i = ctx.infos.get(g.actorId)!;
    // Record the observed control state rather than the unused ordinary cycle
    // for a flashing, switched-off or specialised signal. No priority judgment.
    const light = g.light;
    const phase = !light ? null : light.mode === 'off' ? 'off'
      : light.kind === 'controller' ? `controller:${light.controllerGesture ?? 'unknown'}`
      : light.mode === 'flashing-yellow' ? 'flashing-yellow'
      : light.kind === 'reversible' ? `reversible:${light.reversibleState ?? 'unknown'}`
      : light.kind === 'tram' ? `tram:${(light.tramDirections ?? []).join(',') || 'closed'}`
      : lightPhase(light, tOf(g.frame));
    let yellow: Trace | null = null;
    if (g.light && phase === 'yellow') {
      let ky = g.frame;
      while (ky > i.k0 && lightPhase(g.light, tOf(ky - 1)) === 'yellow') ky--;
      const v0 = i.tr.v[ky];
      yellow = { frame: ky, v0, available: g.dist - i.trav[ky], j: SERVICE_DECEL_Y, S: v0 * v0 / (2 * SERVICE_DECEL_Y) };
    }
    ctx.technical.events.push({ actorId: g.actorId, t: tOf(g.frame), kind: g.light ? 'stop-line' : 'sign',
      text: g.light ? `${i.label}: пересечение стоп-линии, сигнал ${phase}` : `${i.label}: пересечение линии знака ${g.sign!.kind}`,
      trace: { ...sampleTrace(ctx, i, g.frame), distance: g.dist, light: g.light, sign: g.sign, phase, yellow } });
  }
  for (const col of tl.collisions) {
    const harm: TechnicalCollision['harm'] = [];
    const tech: TechAssessment[] = [];
    for (const [id, otherId, dv] of [[col.a, col.b, col.dvA], [col.b, col.a, col.dvB]] as const) {
      const i = ctx.infos.get(id);
      if (!i) continue;
      const exposed = !i.isVeh || VEHICLES[i.a.type as VehicleType].exposed;
      harm.push({ actorId: id, level: harmFor(i, dv, col.rel), trace: { actorId: id, dvMs: dv, relMs: col.rel, exposed, speedKmh: kmh(exposed ? col.rel : dv), thresholdsKmh: exposed ? [8, 20, 35, 50] : [10, 25, 40, 55] } });
      const other = otherOf(ctx, otherId);
      const assessment = other ? techFor(ctx, i, other, col.frame) : null;
      if (assessment) tech.push(assessment);
    }
    const trace = { frame: col.frame, point: col.point, rel: col.rel, dvA: col.dvA, dvB: col.dvB,
      participants: [col.a, col.b].flatMap(id => { const i = ctx.infos.get(id); return i ? [sampleTrace(ctx, i, col.frame)] : []; }) };
    ctx.technical.collisions.push({ collision: { ...col }, harm, tech, trace });
    ctx.technical.events.push({ actorId: col.a, t: col.t, kind: 'collision', text: `Контакт ${col.a} и ${col.b}, скорость сближения ${kmh(col.rel).toFixed(1)} км/ч`, trace });
  }
  ctx.technical.nearMisses = collectNearMisses(ctx);
  ctx.technical.overtakes = findOvertakes(ctx);
  ctx.technical.events.sort((a, b) => a.t - b.t);
  ctx.technical.assumptions = [
    `Покрытие: ${SURFACES[scene.env.surface].name.toLowerCase()} (коэффициент сцепления ${tl.mu}).`,
    `Время реакции водителя ${REACT.toFixed(1)} с, запаздывание тормозов ${BRAKE_LAG.toFixed(1)} с.`,
    'Диапазон остановочного пути рассчитан для времени реакции 0,8–1,2 с при прочих неизменных параметрах; это анализ чувствительности, а не доверительный интервал.',
    'Тяжесть вреда здоровью оценена по скорости столкновения ориентировочно; её устанавливает судебно-медицинская экспертиза.',
  ];
  return ctx;
}

export function sampleTrace(ctx: TechnicalContext, i: Info, frame: number): Trace {
  const k = Math.max(0, Math.min(ctx.tl.n - 1, frame));
  const point = posAt(i, k);
  return { actorId: i.a.id, actor: structuredClone(i.a), frame: k, t: tOf(k), present: !!i.tr.present[k],
    x: point.x, y: point.y, heading: i.tr.h[k], v0: i.tr.v[k], speedKmh: kmh(i.tr.v[k]), distance: i.trav[k],
    j: i.brake, mu: ctx.tl.mu,
    roads: roadsAt(ctx.geo, point).map(h => ({ road: structuredClone(h.rg.road), near: h.near })),
  };
}
export function leftmostLat(i: Info, k: number, near: RoadHit['near']): number {
  const r = rightOf(angleOf(near.tangent));
  const forward = dot(fromAngle(i.tr.h[k]), near.tangent) >= 0;
  let min = Infinity;
  for (const c of obbCorners(boxAt(i, k))) {
    const d = dot(sub(c, near.point), r);
    const lat = forward ? d : -d;
    if (lat < min) min = lat;
  }
  return min;
}


/** Pure braking calculation, also usable for any counterfactual input speed. */
export function stoppingCalculation(v0: number, j: number, available: number, t1 = REACT, t2 = BRAKE_LAG) {
  const S = v0 * (t1 + t2) + v0 * v0 / (2 * j);
  return { v0, t1, t2, j, S, available, avoidable: S <= available };
}

function collectNearMisses(ctx: TechnicalContext): TechnicalSection['nearMisses'] {
  const events: TechnicalSection['nearMisses'] = [];
  const list = [...ctx.infos.values()].filter(i => i.isVeh);
  for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const A = list[a];
    const B = list[b];
    if (ctx.tl.collisions.some(c => c.a === A.a.id && c.b === B.a.id || c.a === B.a.id && c.b === A.a.id)) continue;
    let best = Infinity;
    let frame = 0;
    for (let k = Math.max(A.k0, B.k0); k <= Math.min(A.kEnd, B.kEnd); k += 2) {
      const distance = gap(boxAt(A, k), boxAt(B, k));
      if (distance < best) { best = distance; frame = k; }
    }
    if (best < 1 && Number.isFinite(best)) events.push({ a: A.a.id, b: B.a.id, frame, t: tOf(frame), gap: best,
      trace: { frame, gap: best, sampleStep: 2, a: sampleTrace(ctx, A, frame), b: sampleTrace(ctx, B, frame) } });
  }
  return events;
}
