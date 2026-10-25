import { roundaboutPriority } from './roundabout';
import { checkTurnSignals } from './indicators';
import { checkRailwayRules } from './railway';
import {
  type Geo,
  type RoadHit,
  buildGeo,
  roadsAt,
  sidewalkAt,
  trackAt,
} from './geo';
import {
  type OBB,
  type Vec,
  add,
  angDiff,
  dist,
  dot,
  fromAngle,
  kmh,
  mul,
  obbCorners,
  pointInObb,
  rightOf,
  segIntersect,
  sub,
  toLocal,
  distToSegment,
  angleOf,
} from './geom';
import { type Collision, type Timeline, type Track, DT } from './sim';
import { type Kit, checkCargoRules, checkMarkingRules, checkSignRules, cargoInvolved, classOf, computeGateEnds, signApplies } from './restrictions';
import {
  type Actor,
  type CenterMarking,
  type Scene,
  type Sign,
  type TrafficLight,
  type VehicleType,
  VEHICLES,
  actorLabels,
  actorSpec,
  actorTitle,
  dimsOf,
  lightPhase,
  pedestrianGreen,
  hasEmergencySignals,
  SURFACES,
} from './scene';

// ---------------------------------------------------------------------------
// Типы отчёта

export type Severity = 'violation' | 'contributing' | 'info';

export interface Finding {
  actorId: string;
  severity: Severity;
  title: string;
  detail: string;
  refs: string[];
  t?: number;
  /** нарушение находится в причинной связи со столкновением */
  causal: boolean;
}

export type HarmLevel = 'none' | 'light' | 'medium' | 'severe' | 'fatal';

export const HARM_LABEL: Record<HarmLevel, string> = {
  none: 'вред здоровью маловероятен',
  light: 'возможен лёгкий вред здоровью',
  medium: 'возможен вред здоровью средней тяжести',
  severe: 'возможен тяжкий вред здоровью',
  fatal: 'высокий риск гибели',
};

const HARM_ORDER: HarmLevel[] = ['none', 'light', 'medium', 'severe', 'fatal'];
const harmRank = (h: HarmLevel): number => HARM_ORDER.indexOf(h);

export interface TechAssessment {
  actorId: string;
  otherId: string;
  /** момент возникновения опасности, с */
  tHazard: number;
  speedKmh: number;
  /** расстояние до места столкновения в момент опасности, м */
  available: number;
  /** остановочный путь, м */
  stopDist: number;
  avoidable: boolean;
  /** наибольшая скорость, при которой столкновение удавалось предотвратить, км/ч */
  safeKmh: number;
  limitKmh?: number;
  avoidableAtLimit?: boolean;
}

export interface CollisionReport {
  collision: Collision;
  title: string;
  description: string;
  harm: { actorId: string; level: HarmLevel }[];
  tech: TechAssessment[];
  notes: string[];
}

export interface LegalItem {
  refs: string[];
  text: string;
}

export interface ActorVerdict {
  actorId: string;
  status: 'guilty' | 'clean' | 'minor';
  text: string;
  legal: LegalItem[];
}

export interface Report {
  hasCollision: boolean;
  summary: string[];
  events: { t: number; text: string }[];
  findings: Finding[];
  collisions: CollisionReport[];
  verdicts: ActorVerdict[];
  duties: LegalItem[];
  assumptions: string[];
}

// ---------------------------------------------------------------------------
// Контекст

export interface Info {
  a: Actor;
  title: string;
  label: string;
  tr: Track;
  isVeh: boolean;
  hl: number;
  hw: number;
  /** смещение центра кузова с грузом вдоль курса */
  shift: number;
  /** полудлина и полуширина самого ТС без груза */
  hlBase: number;
  hwBase: number;
  mass: number;
  k0: number;
  kEnd: number;
  trav: Float32Array;
  brake: number;
  rail: boolean;
}

export interface GateEvent {
  actorId: string;
  frame: number;
  dist: number;
  sign?: Sign;
  light?: TrafficLight;
  /** кадр, с которого знак перестаёт действовать (заполняется computeGateEnds) */
  until?: number;
}

export interface Ctx {
  scene: Scene;
  tl: Timeline;
  geo: Geo;
  infos: Map<string, Info>;
  findings: Finding[];
  events: { t: number; text: string }[];
  gates: GateEvent[];
  /** кадры, на которых участник частично находился на встречной стороне */
  onc: Map<string, { frames: number[]; center: CenterMarking; lanes: number; tramTrack: boolean }>;
  lightViolations: Map<string, { light: TrafficLight; frame: number }[]>;
  stopSkipped: Map<string, number[]>;
  pedEntry: Map<string, { frame: number; onCrosswalk: boolean; pedGreen: boolean | null; crosswalkId?: string }>;
}

const REACT = 1.0;
const BRAKE_LAG = 0.2;
const SERVICE_DECEL_Y = 3.0;

const tOf = (k: number): number => k * DT;

function boxAt(i: Info, k: number): OBB {
  const h = i.tr.h[k];
  return { cx: i.tr.x[k] + Math.cos(h) * i.shift, cy: i.tr.y[k] + Math.sin(h) * i.shift, hl: i.hl, hw: i.hw, a: h };
}
const posAt = (i: Info, k: number): Vec => ({ x: i.tr.x[k], y: i.tr.y[k] });
const frontAt = (i: Info, k: number): Vec => add(posAt(i, k), mul(fromAngle(i.tr.h[k]), i.hl + i.shift));

function addFinding(ctx: Ctx, f: Omit<Finding, 'causal'> & { causal?: boolean }): Finding {
  const full: Finding = { causal: false, ...f };
  ctx.findings.push(full);
  if (full.t !== undefined && full.severity !== 'info') {
    ctx.events.push({ t: full.t, text: `${ctx.infos.get(full.actorId)!.label}: ${full.title}` });
  }
  return full;
}

function prepare(scene: Scene, tl: Timeline): Ctx {
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
      brake: vs ? Math.min(vs.brakeCap ?? Infinity, mu * 9.81 * vs.brakeFactor) : 3,
      rail: !!vs?.rail,
    });
  }
  return {
    scene,
    tl,
    geo,
    infos,
    findings: [],
    events: [],
    gates: [],
    onc: new Map(),
    lightViolations: new Map(),
    stopSkipped: new Map(),
    pedEntry: new Map(),
  };
}

// ---------------------------------------------------------------------------
// События пересечения знаков и стоп-линий

function collectGates(ctx: Ctx): void {
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || i.a.type === 'train') continue;
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

/** Знаки, действующие для участника в кадре (с учётом пройденного после знака пути). */
function activeSigns(ctx: Ctx, actorId: string, frame: number, maxDist: number): Sign[] {
  const i = ctx.infos.get(actorId)!;
  return ctx.gates
    .filter((g) => g.actorId === actorId && g.sign && g.frame <= frame && (g.until === undefined || frame < g.until) && i.trav[frame] - g.dist <= maxDist)
    .map((g) => g.sign!);
}

// ---------------------------------------------------------------------------
// Проверки движения отдельных участников

function bandRef(excess: number): string | null {
  if (excess > 80) return 'koap:12.9.5';
  if (excess > 60) return 'koap:12.9.4';
  if (excess > 40) return 'koap:12.9.3';
  if (excess > 20) return 'koap:12.9.2';
  return null;
}

function zoneLimit(type: VehicleType, zone: 'city' | 'outside' | 'residential'): { limit: number; ref: string } | null {
  if (zone === 'residential') return { limit: 20, ref: 'pdd:10.2' };
  if (zone === 'city') return { limit: 60, ref: 'pdd:10.2' };
  const vs = VEHICLES[type];
  if (vs.rail) return null;
  if (type === 'bicycle' || type === 'cart') return null;
  if (type === 'truck' || type === 'trolleybus') return { limit: 70, ref: 'pdd:10.3' };
  return { limit: 90, ref: 'pdd:10.3' };
}

export function speedLimitAt(ctx: Ctx, i: Info, k: number): { limit: number; refs: string[] } | null {
  const hits = roadsAt(ctx.geo, posAt(i, k), 1);
  if (!hits.length) return null;
  const active = activeSigns(ctx, i.a.id, k, 100000);
  const sign = active.filter((s) => s.kind === '3.24').pop();
  if (sign?.value && signApplies(sign, classOf(i))) return { limit: sign.value, refs: ['sign:3.24'] };
  // знаки зон: 5.21 (жилая зона), 5.23.1/5.24.1 (начало населённого пункта / выезд), 5.31 (зона с ограничением скорости)
  const zoneSign = active.filter((s) => ['5.21', '5.23.1', '5.24.1', '5.31'].includes(s.kind)).pop();
  if (zoneSign) {
    const type = i.a.type as VehicleType;
    if (zoneSign.kind === '5.31' && zoneSign.value) return { limit: zoneSign.value, refs: ['sign:5.31'] };
    if (zoneSign.kind === '5.21') return { limit: 20, refs: ['sign:5.21', 'pdd:17.1'] };
    const z = zoneLimit(type, zoneSign.kind === '5.23.1' ? 'city' : 'outside');
    if (z) return { limit: z.limit, refs: [`sign:${zoneSign.kind}`, z.ref] };
  }
  const z = zoneLimit(i.a.type as VehicleType, hits[0].rg.road.zone);
  return z ? { limit: z.limit, refs: [z.ref] } : null;
}

function checkSpeed(ctx: Ctx, i: Info): void {
  let run = 0;
  interface SpeedHit {
    excess: number;
    k: number;
    limit: number;
    refs: string[];
  }
  let best: SpeedHit | null = null as SpeedHit | null;
  let runBest: SpeedHit | null = null as SpeedHit | null;
  for (let k = Math.max(i.k0, 0); k <= i.kEnd; k++) {
    const lim = speedLimitAt(ctx, i, k);
    const v = kmh(i.tr.v[k]);
    if (lim && v > lim.limit + 0.5) {
      run++;
      const ex = v - lim.limit;
      if (!runBest || ex > runBest.excess) runBest = { excess: ex, k, limit: lim.limit, refs: lim.refs };
      if (run >= 12 && runBest && (!best || runBest.excess > best.excess)) best = runBest;
    } else {
      run = 0;
      runBest = null;
    }
  }
  if (!best) return;
  const band = bandRef(best.excess);
  const refs = [...best.refs];
  if (band) refs.push(band);
  const over = Math.round(best.excess);
  addFinding(ctx, {
    actorId: i.a.id,
    severity: 'violation',
    t: tOf(best.k),
    title: `превышение скорости на ${over} км/ч`,
    detail:
      `Скорость ${Math.round(kmh(i.tr.v[best.k]))} км/ч при допустимых ${best.limit} км/ч.` +
      (band ? '' : ' Превышение до 20 км/ч включительно штрафом по ст. 12.9 КоАП не наказывается, но требование ПДД нарушено.'),
    refs,
  });
}

function leftmostLat(i: Info, k: number, near: RoadHit['near']): number {
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

function checkPosition(ctx: Ctx, i: Info): void {
  if (!i.isVeh || i.rail) return;
  let sidewalk = 0;
  let sidewalkK = -1;
  let wrongWay = 0;
  let wrongWayK = -1;
  let tramOnc = 0;
  let tramOncK = -1;
  const oncFrames: number[] = [];
  let center: CenterMarking = 'none';
  let lanes = 1;
  for (let k = i.k0; k <= i.kEnd; k++) {
    const p = posAt(i, k);
    const hits = roadsAt(ctx.geo, p);
    if (hits.length === 0) {
      if (sidewalkAt(ctx.geo, p)) {
        sidewalk++;
        if (sidewalkK < 0) sidewalkK = k;
      }
    } else if (hits.length === 1) {
      const h = hits[0];
      const fwd = dot(fromAngle(i.tr.h[k]), h.near.tangent) >= 0;
      if (h.rg.road.oneWay) {
        if (!fwd && i.tr.v[k] > 0.5) {
          wrongWay++;
          if (wrongWayK < 0) wrongWayK = k;
        }
      } else if (leftmostLat(i, k, h.near) < -0.15) {
        oncFrames.push(k);
        center = h.rg.road.center;
        lanes = h.rg.road.lanes;
      }
    }
    const tk = trackAt(ctx.geo, p, 1.1);
    if (tk && dot(fromAngle(i.tr.h[k]), tk.near.tangent) < -0.3 && i.tr.v[k] > 0.5) {
      tramOnc++;
      if (tramOncK < 0) tramOncK = k;
    }
  }
  if (sidewalk >= 20) {
    addFinding(ctx, {
      actorId: i.a.id,
      severity: 'violation',
      t: tOf(sidewalkK),
      title: 'движение по тротуару',
      detail: 'Транспортное средство выехало на тротуар.',
      refs: ['pdd:9.9', 'koap:12.15.2'],
    });
  }
  if (wrongWay >= 12) {
    addFinding(ctx, {
      actorId: i.a.id,
      severity: 'violation',
      t: tOf(wrongWayK),
      title: 'движение во встречном направлении по дороге с односторонним движением',
      detail: 'Направление движения противоположно разрешённому на односторонней дороге.',
      refs: ['sign:5.5', 'koap:12.16.3'],
    });
  }
  if (tramOnc >= 12) {
    addFinding(ctx, {
      actorId: i.a.id,
      severity: 'violation',
      t: tOf(tramOncK),
      title: 'выезд на трамвайные пути встречного направления',
      detail: 'ТС движется по трамвайным путям против их направления.',
      refs: ['pdd:9.6', 'koap:12.15.4'],
    });
  }
  if (oncFrames.length >= 4) ctx.onc.set(i.a.id, { frames: oncFrames, center, lanes, tramTrack: tramOnc > 0 });
}

function checkLights(ctx: Ctx, i: Info): void {
  for (const g of ctx.gates.filter((x) => x.actorId === i.a.id && x.light)) {
    const light = g.light!;
    const t = tOf(g.frame);
    const phase = lightPhase(light, t);
    if (phase === 'green') continue;
    if (hasEmergencySignals(i.a)) {
      addFinding(ctx, { actorId: i.a.id, severity: 'info', t,
        title: 'спецтранспорт пересёк запрещающий сигнал',
        detail: 'При срочном задании с синим маячком и сиреной допускается отступить от сигнала только при обеспечении безопасности. Преимущество можно использовать, убедившись, что дорогу уступают.',
        refs: ['pdd:3.1', 'pdd:3.2'] });
      continue;
    }
    let bad = phase === 'red';
    let note = '';
    if (phase === 'yellow') {
      // момент включения жёлтого
      let ky = g.frame;
      while (ky > i.k0 && lightPhase(light, tOf(ky - 1)) === 'yellow') ky--;
      const v = i.tr.v[ky];
      const d = g.dist - i.trav[ky];
      const stopDist = (v * v) / (2 * SERVICE_DECEL_Y);
      if (stopDist <= d) {
        bad = true;
        note = ` При включении жёлтого скорость ${Math.round(kmh(v))} км/ч, до стоп-линии ${d.toFixed(0)} м — остановиться без экстренного торможения было возможно.`;
      } else {
        addFinding(ctx, {
          actorId: i.a.id,
          severity: 'info',
          t,
          title: 'проезд на жёлтый сигнал',
          detail: 'Остановиться без экстренного торможения уже было нельзя, поэтому дальнейшее движение допустимо (п. 6.14).',
          refs: ['pdd:6.14'],
        });
      }
    }
    if (bad) {
      addFinding(ctx, {
        actorId: i.a.id,
        severity: 'violation',
        t,
        title: phase === 'red' ? 'проезд на красный сигнал светофора' : 'проезд на жёлтый сигнал светофора',
        detail: `Стоп-линия пересечена на ${phase === 'red' ? 'красный' : 'жёлтый'} сигнал, скорость ${Math.round(kmh(i.tr.v[g.frame]))} км/ч.${note}`,
        refs: ['pdd:6.2', 'pdd:6.13', 'koap:12.12.1'],
      });
      const list = ctx.lightViolations.get(i.a.id) ?? [];
      list.push({ light, frame: g.frame });
      ctx.lightViolations.set(i.a.id, list);
    }
  }
}

function checkSigns(ctx: Ctx, i: Info): void {
  for (const g of ctx.gates.filter((x) => x.actorId === i.a.id && x.sign)) {
    const s = g.sign!;
    const t = tOf(g.frame);
    if (s.kind === '2.5' || s.kind === '3.17.3') {
      let stopped = false;
      for (let k = g.frame; k >= i.k0 && i.trav[g.frame] - i.trav[k] <= 30; k--) {
        if (i.tr.v[k] < 0.5) {
          stopped = true;
          break;
        }
      }
      if (!stopped) {
        addFinding(ctx, {
          actorId: i.a.id,
          severity: 'violation',
          t,
          title: 'проезд знака «Движение без остановки запрещено» без остановки',
          detail: `Скорость при пересечении линии — ${Math.round(kmh(i.tr.v[g.frame]))} км/ч, полной остановки не было.`,
          refs: ['sign:2.5', 'koap:12.16.1'],
        });
        const list = ctx.stopSkipped.get(i.a.id) ?? [];
        list.push(g.frame);
        ctx.stopSkipped.set(i.a.id, list);
      }
    } else if (s.kind === '3.1') {
      const onOneWay = roadsAt(ctx.geo, posAt(i, g.frame), 2).some((h) => h.rg.road.oneWay);
      addFinding(ctx, {
        actorId: i.a.id,
        severity: 'violation',
        t,
        title: 'въезд под знак «Въезд запрещён»',
        detail: 'Участок пройден в запрещённом направлении.',
        refs: onOneWay ? ['sign:3.1', 'koap:12.16.3'] : ['sign:3.1', 'koap:12.16.1'],
      });
    }
  }
}

interface Overtake {
  overtaker: string;
  overtaken: string;
  frame: number;
}

function findOvertakes(ctx: Ctx): Overtake[] {
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
          out.push({ overtaker: A.a.id, overtaken: B.a.id, frame: k });
          break;
        }
        prev = l.x;
      }
    }
  }
  return out;
}

function checkOvertakes(ctx: Ctx): void {
  for (const o of findOvertakes(ctx)) {
    const A = ctx.infos.get(o.overtaker)!;
    const B = ctx.infos.get(o.overtaken)!;
    ctx.events.push({ t: tOf(o.frame), text: `${A.label} обгоняет ${B.label}` });
    const signs = activeSigns(ctx, A.a.id, o.frame, 500).filter((s) => s.kind === '3.20');
    if (signs.length) {
      addFinding(ctx, {
        actorId: A.a.id,
        severity: 'violation',
        t: tOf(o.frame),
        title: 'обгон в зоне действия знака «Обгон запрещён»',
        detail: `${A.label} обогнал ${B.label} после знака 3.20.`,
        refs: ['sign:3.20', 'koap:12.16.1'],
      });
    }
    for (const cw of ctx.geo.crosswalks) {
      let near = false;
      for (let k = Math.max(A.k0, o.frame - 60); k <= Math.min(A.kEnd, o.frame + 60); k += 2) {
        const bx = boxAt(A, k);
        if (obbCorners(bx).some((c) => pointInObb(c, cw.box, 0.5))) {
          near = true;
          break;
        }
      }
      if (near) {
        const wrong = ctx.onc.get(A.a.id);
        addFinding(ctx, {
          actorId: A.a.id,
          severity: 'violation',
          t: tOf(o.frame),
          title: 'обгон на пешеходном переходе',
          detail: `${A.label} обгоняет ${B.label} в зоне пешеходного перехода.`,
          refs: wrong ? ['pdd:11.4', 'koap:12.15.4'] : ['pdd:11.4'],
        });
        break;
      }
    }
  }
}

/** Пешеход находится в зоне действия знака 5.21 «Жилая зона» (до ближайшего 5.22 в радиусе 150 м). */
function inLivingZone(ctx: Ctx, p: Vec): boolean {
  const near = (kind: string): number =>
    ctx.scene.signs.filter((s) => s.kind === kind).reduce((m, s) => Math.min(m, dist(p, { x: s.x, y: s.y })), Infinity);
  const a = near('5.21');
  return a <= 150 && a < near('5.22');
}

/** Учебный предел восприятия одновременно включённых спецсигналов — 150 м. */
function emergencyApproaches(vehicle: Info, pedestrian: Info, k: number): boolean {
  if (!hasEmergencySignals(vehicle.a) || !vehicle.tr.present[k] || vehicle.tr.v[k] < 0.5) return false;
  const local = toLocal(posAt(pedestrian, k), { cx: vehicle.tr.x[k], cy: vehicle.tr.y[k], a: vehicle.tr.h[k] });
  return local.x > 0 && dist(posAt(vehicle, k), posAt(pedestrian, k)) <= 150;
}

function checkPedestrian(ctx: Ctx, i: Info): void {
  const geo = ctx.geo;
  let wasOn = false;
  for (let k = i.k0; k <= i.kEnd; k++) {
    const p = posAt(i, k);
    const onRoad = roadsAt(geo, p).length > 0;
    if (onRoad && !wasOn && !ctx.pedEntry.has(i.a.id)) {
      const cw = geo.crosswalks.find((c) => pointInObb(p, c.box, 0.6));
      const green = cw ? pedestrianGreen(ctx.scene, cw.item, tOf(k)) : null;
      ctx.pedEntry.set(i.a.id, { frame: k, onCrosswalk: !!cw, pedGreen: green, crosswalkId: cw?.item.id });
      const emergency = [...ctx.infos.values()].find((v) => emergencyApproaches(v, i, k));
      if (emergency && k > i.k0) addFinding(ctx, {
        actorId: i.a.id, severity: 'violation', t: tOf(k),
        title: 'начал переход при приближении спецтранспорта',
        detail: `${emergency.label} приближался с синим маячком и сиреной. По п. 4.7 следовало воздержаться от перехода, даже на переходе и разрешающий сигнал. В модели спецсигналы считаются воспринимаемыми в пределах 150 м; фактическую заметность оценивают отдельно.`,
        refs: ['pdd:4.7', 'koap:12.29.1'],
      });
      const res = roadsAt(geo, p)[0].rg.road.zone === 'residential' || inLivingZone(ctx, p);
      if (!cw && !res) {
        const nearest = geo.crosswalks.reduce((m, c) => Math.min(m, dist(p, { x: c.item.x, y: c.item.y })), Infinity);
        if (nearest <= 100) {
          addFinding(ctx, {
            actorId: i.a.id,
            severity: 'violation',
            t: tOf(k),
            title: 'переход проезжей части вне пешеходного перехода',
            detail: `Ближайший пешеходный переход находится в ${Math.round(nearest)} м — в зоне видимости.`,
            refs: ['pdd:4.3', 'koap:12.29.1'],
          });
        } else {
          addFinding(ctx, {
            actorId: i.a.id,
            severity: 'info',
            t: tOf(k),
            title: 'переход вне пешеходного перехода',
            detail: 'Перехода поблизости нет; дорогу нужно пересекать под прямым углом там, где она хорошо просматривается (п. 4.3).',
            refs: ['pdd:4.3'],
          });
        }
      }
      if (cw && green === false) {
        addFinding(ctx, {
          actorId: i.a.id,
          severity: 'violation',
          t: tOf(k),
          title: 'выход на проезжую часть на запрещающий сигнал пешеходного светофора',
          detail: 'Пешеход вступил на переход, когда для него горел красный сигнал.',
          refs: ['pdd:4.4', 'koap:12.29.1'],
        });
      }
    }
    wasOn = onRoad;
  }
}

// ---------------------------------------------------------------------------
// Техническая возможность предотвратить столкновение

interface OtherRef {
  id: string;
  pos: (k: number) => Vec;
  speed: (k: number) => number;
  present: (k: number) => boolean;
  ped: boolean;
}

function otherOf(ctx: Ctx, id: string): OtherRef | null {
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

function techFor(ctx: Ctx, v: Info, other: OtherRef, imp: number): TechAssessment | null {
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
    actorId: v.a.id,
    otherId: other.id,
    tHazard: tOf(kd),
    speedKmh: kmh(v0),
    available,
    stopDist,
    avoidable: stopDist <= available + 1e-6,
    safeKmh: kmh(Math.max(0, safe)),
  };
  const lim = speedLimitAt(ctx, v, kd);
  if (lim && kmh(v0) > lim.limit) {
    const vl = lim.limit / 3.6;
    res.limitKmh = lim.limit;
    res.avoidableAtLimit = vl * T + (vl * vl) / (2 * a) <= available;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Классификация столкновений

type Region = 'front' | 'rear' | 'left' | 'right';

function regionOf(i: Info, k: number, pt: Vec): Region {
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

type Reason = 'roundabout' | 'emergency' | 'light' | 'sign-giveway' | 'sign-stop' | 'sign-main' | 'tram' | 'left' | 'right';

interface Priority {
  yielder: Info | null;
  other: Info | null;
  reason: Reason | null;
  explain: string;
}

function signScore(ctx: Ctx, i: Info, frame: number): { score: number; kinds: string[] } {
  const signs = activeSigns(ctx, i.a.id, frame, 120);
  let score = 0;
  const kinds: string[] = [];
  for (const s of signs) {
    if (s.kind === '2.1') {
      score = Math.max(score, 1);
      kinds.push('main');
    } else if (s.kind === '2.4' || s.kind === '2.5') {
      score = Math.min(score, -1);
      kinds.push(s.kind === '2.4' ? 'giveway' : 'stop');
    }
  }
  return { score, kinds };
}

function resolvePriority(ctx: Ctx, A: Info, B: Info, col: Collision): Priority {
  const frame = col.frame;
  // Спецсигналы требуют уступить и при разрешающем сигнале у другого ТС.
  const ea = hasEmergencySignals(A.a);
  const eb = hasEmergencySignals(B.a);
  if (ea !== eb) {
    const P = ea ? A : B;
    const Y = ea ? B : A;
    return { yielder: Y, other: P, reason: 'emergency',
      explain: `${Y.label} должен уступить спецтранспорту ${P.label} с одновременно включёнными синим маячком и сиреной. ${P.label} вправе использовать преимущество, лишь убедившись, что ему уступают, и обеспечив безопасность (п. 3.1–3.2).` };
  }
  // 1. светофор
  const recent = (id: string) => (ctx.lightViolations.get(id) ?? []).filter((x) => x.frame <= frame && frame - x.frame < 40 * 15);
  const la = recent(A.a.id);
  const lb = recent(B.a.id);
  if (la.length && !lb.length) return { yielder: A, other: B, reason: 'light', explain: `${A.label} въехал на перекрёсток на запрещающий сигнал светофора.` };
  if (lb.length && !la.length) return { yielder: B, other: A, reason: 'light', explain: `${B.label} въехал на перекрёсток на запрещающий сигнал светофора.` };
  if (la.length && lb.length) return { yielder: null, other: null, reason: null, explain: 'Оба участника проехали перекрёсток на запрещающий сигнал.' };

  // 2. знаки приоритета
  const sa = signScore(ctx, A, frame);
  const sb = signScore(ctx, B, frame);
  if (sa.score !== sb.score) {
    const Y = sa.score < sb.score ? A : B;
    const P = Y === A ? B : A;
    const ys = Y === A ? sa : sb;
    const stop = ys.kinds.includes('stop');
    return {
      yielder: Y,
      other: P,
      reason: stop ? 'sign-stop' : ys.kinds.includes('giveway') ? 'sign-giveway' : 'sign-main',
      explain: `${Y.label} подъезжал по второстепенной дороге${stop ? ' (знак «Движение без остановки запрещено»)' : ys.kinds.includes('giveway') ? ' (знак «Уступите дорогу»)' : ''}, ${P.label} — по главной.`,
    };
  }

  // После знаков приоритета: въезд по неглавной дороге уступает движущимся по кольцу.
  const ring = roundaboutPriority(ctx, A, B, frame);
  if (ring) return { yielder: ring.entering, other: ring.circulating, reason: 'roundabout',
    explain: `${ring.entering.label} въезжал по дороге, не являющейся главной, на круговое движение со знаком 4.3 и обязан был уступить ${ring.circulating.label}, уже двигавшемуся по кольцу (п. 13.11(1)).` };

  // 3. трамвай на равнозначном перекрёстке
  if (A.rail !== B.rail) {
    const P = A.rail ? A : B;
    const Y = A.rail ? B : A;
    return { yielder: Y, other: P, reason: 'tram', explain: `На равнозначном перекрёстке трамвай имеет преимущество перед безрельсовым ТС.` };
  }

  // 4. поворот налево
  const early = (i: Info) => Math.max(i.k0, frame - 160);
  const turn = (i: Info) => angDiff(i.tr.h[early(i)], i.tr.h[Math.max(i.k0, frame - 1)]);
  const ta = turn(A);
  const tb = turn(B);
  const leftA = ta < -0.6;
  const leftB = tb < -0.6;
  const opposite = Math.abs(angDiff(A.tr.h[early(A)], B.tr.h[early(B)])) > 2.1;
  if (leftA !== leftB && opposite) {
    const Y = leftA ? A : B;
    const P = leftA ? B : A;
    return { yielder: Y, other: P, reason: 'left', explain: `${Y.label} поворачивал налево и должен был уступить встречному ${P.label}, ехавшему прямо или направо.` };
  }

  // 5. помеха справа
  const kPre = Math.max(Math.max(A.k0, B.k0), frame - 80);
  const rel = (X: Info, Y: Info): number => toLocal(posAt(Y, kPre), { cx: X.tr.x[kPre], cy: X.tr.y[kPre], a: X.tr.h[kPre] }).y;
  const bOnRightOfA = rel(A, B) > 0.5;
  const aOnRightOfB = rel(B, A) > 0.5;
  if (bOnRightOfA && !aOnRightOfB) return { yielder: A, other: B, reason: 'right', explain: `${B.label} приближался справа от ${A.label} на равнозначном перекрёстке.` };
  if (aOnRightOfB && !bOnRightOfA) return { yielder: B, other: A, reason: 'right', explain: `${A.label} приближался справа от ${B.label} на равнозначном перекрёстке.` };
  return { yielder: null, other: null, reason: null, explain: 'Очерёдность проезда по заданным данным определить однозначно не удаётся.' };
}

const REASON_REFS: Record<Reason, string[]> = {
  roundabout: ['sign:4.3', 'pdd:13.11(1)', 'koap:12.13.2'],
  emergency: ['pdd:3.1', 'pdd:3.2', 'koap:12.17.2'],
  light: ['pdd:6.2', 'pdd:6.13', 'koap:12.12.1'],
  'sign-giveway': ['sign:2.4', 'pdd:13.9', 'koap:12.13.2'],
  'sign-stop': ['sign:2.5', 'pdd:13.9', 'koap:12.13.2'],
  'sign-main': ['pdd:13.9', 'koap:12.13.2'],
  tram: ['pdd:13.11', 'koap:12.13.2'],
  left: ['pdd:13.4', 'pdd:13.12', 'koap:12.13.2'],
  right: ['pdd:13.11', 'koap:12.13.2'],
};

function techText(t: TechAssessment, self: string, otherName: string): string {
  if (t.available < 2) {
    return `${self}: опасность (${otherName}) возникла, когда до места столкновения оставалось менее 2 м, — остановиться было невозможно.`;
  }
  const base =
    `${self}: опасность — с t = ${t.tHazard.toFixed(1)} с (${otherName}), скорость ${Math.round(t.speedKmh)} км/ч, до места удара ${t.available.toFixed(0)} м, ` +
    `остановочный путь ${t.stopDist.toFixed(0)} м. `;
  return (
    base +
    (t.avoidable
      ? 'Остановиться до места столкновения было возможно.'
      : `Остановиться до места столкновения не удавалось (безопасная скорость в этой ситуации — не более ${Math.floor(t.safeKmh)} км/ч).`)
  );
}

function analyzeCollisions(ctx: Ctx): CollisionReport[] {
  const reports: CollisionReport[] = [];
  const geo = ctx.geo;

  for (const col of ctx.tl.collisions) {
    const A = ctx.infos.get(col.a)!;
    const Bi = ctx.infos.get(col.b) ?? null;
    const notes: string[] = [];
    const tech: TechAssessment[] = [];
    const frame = col.frame;
    const kp = Math.max(0, frame - 1);
    const t = col.t;
    const impactKmh = Math.round(kmh(col.rel));
    let title = '';
    let description = '';

    const addTech = (v: Info, otherId: string) => {
      const o = otherOf(ctx, otherId);
      if (!o) return null;
      const r = techFor(ctx, v, o, frame);
      if (r) tech.push(r);
      return r;
    };

    // ---- наезд на препятствие
    if (col.kind === 'vo') {
      const ob = geo.obstacles.find((x) => x.item.id === col.b)!;
      title = 'Наезд на препятствие';
      description = `${A.label} столкнулся с препятствием (${obstacleName(ob.item.kind)}) на скорости около ${impactKmh} км/ч.`;
      const onRoad = roadsAt(geo, posAt(A, kp), 1).length > 0;
      const tr = addTech(A, col.b);
      if (!onRoad) {
        if (!ctx.findings.some((f) => f.actorId === A.a.id && f.refs.includes('pdd:9.9'))) {
          addFinding(ctx, {
            actorId: A.a.id,
            severity: 'violation',
            t,
            causal: true,
            title: 'выезд за пределы проезжей части',
            detail: 'Транспортное средство покинуло проезжую часть и столкнулось с препятствием.',
            refs: ['pdd:9.9', 'pdd:10.1'],
          });
        } else markCausal(ctx, A.a.id);
      } else {
        addFinding(ctx, {
          actorId: A.a.id,
          severity: 'violation',
          t,
          causal: true,
          title: 'наезд на препятствие',
          detail: `Водитель не выбрал скорость, позволяющую контролировать движение${tr ? (tr.avoidable ? ' и имел возможность остановиться' : '') : ''}.`,
          refs: ['pdd:10.1'],
        });
      }
      reports.push(finishCollision(ctx, col, title, description, tech, notes));
      ctx.events.push({ t, text: `${A.label} — наезд на препятствие, ~${impactKmh} км/ч` });
      continue;
    }

    const B = Bi!;

    if (A.a.type === 'train' || B.a.type === 'train') {
      const train = A.a.type === 'train' ? A : B;
      const roadUser = train === A ? B : A;
      title = 'Столкновение с поездом на переезде';
      description = `${roadUser.label} столкнулся с поездом. Скорость сближения около ${impactKmh} км/ч.`;
      addTech(roadUser, train.a.id);
      if (ctx.findings.some((f) => f.actorId === roadUser.a.id && f.refs.includes('pdd:15.3'))) markCausal(ctx, roadUser.a.id);
      else notes.push('Запрет въезда при приближении поезда не установлен по заданным сигналам и траекториям; одной коллизии недостаточно для вывода о нарушении.');
      notes.push('У поезда большой тормозной путь. Модель представляет локомотив одним жёстким телом; железнодорожная экспертиза не выполняется.');
      reports.push(finishCollision(ctx, col, title, description, tech, notes));
      ctx.events.push({ t, text: title });
      continue;
    }

    // ---- наезд на пешехода
    if (col.kind === 'vp') {
      const veh = A.isVeh ? A : B;
      const ped = A.isVeh ? B : A;
      title = 'Наезд на пешехода';
      description = `${veh.label} сбил(а) ${ped.label.toLowerCase()} на скорости около ${Math.round(kmh(len2(col.vA, col.vB)))} км/ч.`;
      const pPos = posAt(ped, kp);
      const cw = geo.crosswalks.find((c) => pointInObb(pPos, c.box, 0.6));
      const entry = ctx.pedEntry.get(ped.a.id);
      const road = roadsAt(geo, pPos, 1)[0];
      const resZone = road?.rg.road.zone === 'residential';
      const tr = addTech(veh, ped.a.id);
      const onSidewalk = !road && !!sidewalkAt(geo, pPos);
      let driverBlamed = false;

      if (onSidewalk) {
        if (!ctx.findings.some((f) => f.actorId === veh.a.id && f.refs.includes('pdd:9.9'))) {
          addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'наезд на пешехода на тротуаре', detail: 'ТС выехало на тротуар.', refs: ['pdd:9.9', 'koap:12.15.2'] });
        } else markCausal(ctx, veh.a.id);
        driverBlamed = true;
      } else if (hasEmergencySignals(veh.a)) {
        const violation = ctx.findings.find((f) => f.actorId === ped.a.id && f.refs.includes('pdd:4.7') && f.severity === 'violation');
        if (violation) {
          violation.causal = true;
          notes.push('Пешеход начал переход при приближении спецтранспорта с синим маячком и сиреной — следовало воздержаться от перехода по п. 4.7.');
        } else {
          addFinding(ctx, { actorId: ped.a.id, severity: 'info', t, title: 'обязанность освободить дорогу спецтранспорту',
            detail: 'Пешеход, уже находившийся на проезжей части при приближении спецтранспорта, должен незамедлительно её освободить. Начало перехода до появления спецтранспорта само по себе не подтверждает нарушение; модель не устанавливает, мог ли пешеход освободить дорогу быстрее.', refs: ['pdd:4.7'] });
        }
        notes.push('Маячок и сирена не снимают с водителя обязанности обеспечить безопасность по п. 3.1. Обычное преимущество пешехода по п. 14.1 здесь не применяется автоматически.');
        if (tr?.avoidable) {
          addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true,
            title: 'не обеспечил безопасность проезда спецтранспорта',
            detail: 'Пешеход находился на конфликтующей траектории. По расчёту остановиться было возможно, но водитель спецтранспорта продолжил движение; п. 3.1 требует обеспечить безопасность даже при включённых маячке и сирене.',
            refs: ['pdd:3.1', 'pdd:10.1'] });
        } else {
          addFinding(ctx, { actorId: veh.a.id, severity: 'info', t,
            title: 'безопасность движения спецтранспорта требует отдельной оценки',
            detail: tr ? 'После обнаружения опасности остановиться до наезда технически не удавалось. Это не отменяет обязанность обеспечить безопасность по п. 3.1; по одной траектории нельзя автоматически установить её нарушение.' : 'Недостаточно данных для расчёта технической возможности остановиться. Применение преимущества требует обеспечения безопасности по п. 3.1.',
            refs: ['pdd:3.1'] });
        }
      } else if (cw || resZone) {
        const pedRed = entry?.pedGreen === false;
        if (cw?.item.lightId && pedRed) {
          description += ' Пешеход вступил на переход на запрещающий для него сигнал.';
          markCausal(ctx, ped.a.id);
          notes.push('Пешеход начал переход на красный сигнал (п. 4.4). Водитель при этом остаётся обязанным принять меры к остановке, если опасность можно было обнаружить (п. 10.1).');
          if (tr?.avoidable) {
            addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'не принял мер к остановке перед пешеходом', detail: 'Опасность была заметна заранее, остановиться было возможно.', refs: ['pdd:10.1'] });
            driverBlamed = true;
          } else {
            notes.push('Технической возможности остановиться у водителя не было — причиной ДТП стало нарушение пешехода.');
          }
        } else if (cw?.item.lightId) {
          // зелёный для пешехода — водитель поехал на красный или не уступил завершающим переход
          if (!ctx.findings.some((f) => f.actorId === veh.a.id && f.causal && f.refs.includes('koap:12.12.1'))) {
            addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'не уступил пешеходу на регулируемом переходе', detail: 'Пешеход шёл на разрешающий сигнал или заканчивал переход.', refs: ['pdd:14.3', 'pdd:13.8', 'koap:12.18'] });
          } else markCausal(ctx, veh.a.id);
          driverBlamed = true;
        } else if (!tr || tr.avoidable) {
          addFinding(ctx, {
            actorId: veh.a.id,
            severity: 'violation',
            t,
            causal: true,
            title: resZone && !cw ? 'не уступил пешеходу в жилой зоне' : 'не уступил пешеходу на нерегулируемом переходе',
            detail: 'Пешеход находился на проезжей части в зоне, где имеет преимущество; водитель успевал остановиться.',
            refs: resZone && !cw ? ['pdd:17.1', 'pdd:10.1'] : ['pdd:14.1', 'pdd:10.1', 'koap:12.18'],
          });
          driverBlamed = true;
        } else if (!cw) {
          notes.push('В жилой зоне пешеходы имеют преимущество на всей проезжей части (п. 17.1), поэтому вины пешехода здесь нет. Остановиться при такой скорости водитель не успевал; при допустимых 20 км/ч наезда, как правило, удаётся избежать.');
        } else {
          notes.push('Пешеход находился на переходе, но вышел на проезжую часть слишком близко к ТС: остановиться до места наезда водитель технически не мог. Пешеход нарушил п. 4.5 (не оценил расстояние и скорость).');
          addFinding(ctx, { actorId: ped.a.id, severity: 'violation', t, causal: true, title: 'выход на проезжую часть перед близко идущим ТС', detail: 'Пешеход не оценил расстояние до приближающегося автомобиля и его скорость.', refs: ['pdd:4.5', 'koap:12.29.1'] });
        }
        // остановившееся рядом ТС (п. 14.2)
        if (cw && driverBlamed) {
          const halted = [...ctx.infos.values()].find(
            (o) =>
              o.isVeh &&
              o !== veh &&
              o.tr.v[kp] < 1 &&
              Math.abs(angDiff(o.tr.h[kp], veh.tr.h[kp])) < 0.5 &&
              dist(posAt(o, kp), { x: cw.item.x, y: cw.item.y }) < 25,
          );
          if (halted) {
            addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: `продолжил движение, хотя ${halted.label} остановилось перед переходом`, detail: 'Остановившееся рядом ТС закрывало обзор — следовало остановиться и убедиться в отсутствии пешеходов.', refs: ['pdd:14.2'] });
          }
        }
      } else {
        // вне перехода
        if (entry && !entry.onCrosswalk) markCausal(ctx, ped.a.id);
        if (tr?.avoidable) {
          addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'не принял мер к остановке при обнаружении пешехода', detail: 'Пешеход был виден заранее, остановиться до места наезда успевали.', refs: ['pdd:10.1'] });
          driverBlamed = true;
          notes.push('Пешеход нарушил правила перехода, но и водитель мог предотвратить наезд — возможна обоюдная ответственность.');
        } else {
          notes.push('Пешеход вышел на проезжую часть вне перехода; у водителя не было технической возможности остановиться. Причинная связь с действиями водителя не установлена.');
          if (tr?.avoidableAtLimit) notes.push('При скорости в пределах допустимой наезда удалось бы избежать — превышение скорости находится в причинной связи.');
        }
      }
      if (tr) notes.unshift(techText(tr, veh.label, ped.label));
      reports.push(finishCollision(ctx, col, title, description, tech, notes));
      ctx.events.push({ t, text: `${veh.label} сбил(а) ${ped.label.toLowerCase()}, ~${Math.round(kmh(len2(col.vA, col.vB)))} км/ч` });
      continue;
    }

    // ---- столкновение двух ТС
    const dh = Math.abs(angDiff(A.tr.h[kp], B.tr.h[kp]));
    const rA = regionOf(A, frame, col.point);
    const rB = regionOf(B, frame, col.point);
    const atInter = roadsAt(geo, col.point, 1).length >= 2;
    const trA = addTech(A, B.a.id);
    const trB = addTech(B, A.a.id);

    if (dh < 0.7 && ((rA === 'front' && rB === 'rear') || (rB === 'front' && rA === 'rear'))) {
      // ---- попутное, наезд сзади
      const R = rA === 'front' ? A : B;
      const L = R === A ? B : A;
      const trR = R === A ? trA : trB;
      title = 'Попутное столкновение (наезд сзади)';
      description = `${R.label} въехал в заднюю часть ${L.label}. Скорость сближения около ${impactKmh} км/ч.`;
      addFinding(ctx, {
        actorId: R.a.id,
        severity: 'violation',
        t,
        causal: true,
        title: 'не соблюдал дистанцию до впереди идущего ТС',
        detail: `Дистанция не позволила избежать столкновения${trR ? (trR.avoidable ? '; остановиться перед ТС впереди было возможно' : '') : ''}.`,
        refs: ['pdd:9.10', 'pdd:10.1', 'koap:12.15.1'],
      });
      if (trR && !trR.avoidable && ctx.tl.mu < 0.5) {
        notes.push(`Скорость не соответствовала дорожным условиям (${SURFACES[ctx.scene.env.surface].name.toLowerCase()}): остановочный путь больше расстояния до препятствия (п. 10.1).`);
      }
      // необоснованное торможение лидера
      const decel = (L.tr.v[Math.max(L.k0, kp - 80)] - L.tr.v[kp]) / (80 * DT);
      if (decel > 4 && !reasonToBrake(ctx, L, kp)) {
        addFinding(ctx, {
          actorId: L.a.id,
          severity: 'contributing',
          t,
          causal: true,
          title: 'резкое торможение без видимой причины',
          detail: 'Впереди идущее ТС затормозило с замедлением более 4 м/с², хотя причин для экстренной остановки по обстановке нет.',
          refs: ['pdd:10.5'],
        });
        notes.push('Водитель впереди идущего ТС мог нарушить п. 10.5, но водитель сзади всё равно обязан выдерживать безопасную дистанцию.');
      }
    } else if (dh > 2.4) {
      // ---- встречное
      title = 'Встречное столкновение';
      description = `Лобовое/встречное столкновение ${A.label} и ${B.label}, скорость сближения около ${impactKmh} км/ч.`;
      const wrong = (i: Info) => {
        const w = ctx.onc.get(i.a.id);
        return w && w.frames.some((f) => f >= frame - 80 && f <= frame) ? w : null;
      };
      const wa = wrong(A);
      const wb = wrong(B);
      const blame = (i: Info, w: NonNullable<ReturnType<typeof wrong>>) => {
        const solid = w.center === 'solid' || w.center === 'double';
        const refs = solid ? ['pdd:9.1(1)'] : ['pdd:9.1', 'pdd:9.4', 'pdd:11.1'];
        if (w.lanes >= 2) refs.push('pdd:9.2');
        if (w.tramTrack) refs.push('pdd:9.6');
        refs.push('koap:12.15.4');
        addFinding(ctx, {
          actorId: i.a.id,
          severity: 'violation',
          t,
          causal: true,
          title: 'выезд на полосу встречного движения',
          detail: solid ? 'Пересечена сплошная линия разметки, разделяющая потоки противоположных направлений.' : 'Выезд на встречную сторону проезжей части создал помеху встречному ТС.',
          refs,
        });
      };
      if (wa) blame(A, wa);
      if (wb) blame(B, wb);
      if (!wa && !wb) {
        notes.push('По заданной геометрии ни один из участников не пересекал ось дороги: определить, кто выехал на встречную сторону, нельзя (проверьте положение ТС и разметку).');
        for (const i of [A, B]) {
          addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, title: 'не обеспечил безопасный боковой интервал', detail: 'Столкновение на встречных курсах без явного выезда одного из участников.', refs: ['pdd:9.10', 'pdd:1.5'] });
        }
      }
      for (const [i, r] of [[A, trA], [B, trB]] as const) {
        const w = i === A ? wa : wb;
        if (r && !w) {
          notes.push(techText(r, i.label, (i === A ? B : A).label));
          if (r.avoidable) {
            addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, causal: false, title: 'имел возможность избежать столкновения торможением', detail: 'Опасность была заметна заранее (п. 10.1, ч. 2).', refs: ['pdd:10.1'] });
          }
        }
      }
    } else if (atInter || hasEmergencySignals(A.a) !== hasEmergencySignals(B.a)) {
      // ---- пересечение на перекрёстке
      title = atInter ? 'Столкновение на перекрёстке' : 'Столкновение со спецтранспортом';
      description = `${A.label} и ${B.label} столкнулись ${atInter ? 'на пересечении дорог' : 'при пересечении траекторий'}, скорость сближения около ${impactKmh} км/ч.`;
      const pr = resolvePriority(ctx, A, B, col);
      notes.push(pr.explain);
      if (pr.yielder && pr.reason) {
        const Y = pr.yielder;
        const P = pr.other!;
        const refs = REASON_REFS[pr.reason];
        if (pr.reason === 'emergency') {
          const departed = ctx.gates.some((g) => g.actorId === P.a.id && g.light && g.frame <= frame && frame - g.frame < 600 && lightPhase(g.light, tOf(g.frame)) !== 'green');
          addFinding(ctx, { actorId: P.a.id, severity: departed ? 'violation' : 'info', t, causal: departed,
            title: departed ? 'не обеспечил безопасность отступления от сигнала' : 'преимущество спецтранспорта требует обеспечения безопасности',
            detail: departed ? 'Спецтранспорт продолжил движение на запрещающий сигнал, хотя конфликтующая траектория другого ТС не освободилась. По п. 3.1 отступление допустимо только при обеспечении безопасности; включённые сигналы сами по себе не освобождают от этой обязанности.' : 'По модели подтверждена обязанность другого ТС уступить. Возможность использовать преимущество возникает только после того, как водитель убедился в уступке; выполнение этой обязанности требует отдельной оценки.',
            refs: ['pdd:3.1'] });
        }
        if (pr.reason === 'light') {
          for (const f of ctx.findings) if (f.actorId === Y.a.id && f.refs.includes('koap:12.12.1')) f.causal = true;
        } else if (pr.reason === 'sign-stop' && ctx.stopSkipped.has(Y.a.id)) {
          for (const f of ctx.findings) if (f.actorId === Y.a.id && f.refs.includes('sign:2.5')) f.causal = true;
          addFinding(ctx, { actorId: Y.a.id, severity: 'violation', t, causal: true, title: 'не уступил дорогу на перекрёстке', detail: pr.explain, refs: ['pdd:13.9', 'koap:12.13.2'] });
        } else {
          addFinding(ctx, { actorId: Y.a.id, severity: 'violation', t, causal: true, title: 'не уступил дорогу ТС, имеющему преимущество', detail: pr.explain, refs });
        }
        const trP = P === A ? trA : trB;
        if (trP) {
          notes.push(techText(trP, P.label, Y.label));
          if (trP.avoidable) {
            addFinding(ctx, { actorId: P.a.id, severity: 'contributing', t, title: 'имел возможность избежать столкновения', detail: 'Хотя водитель имел преимущество, при возникновении опасности он обязан снижать скорость вплоть до остановки (п. 10.1, ч. 2).', refs: ['pdd:10.1'] });
          } else {
            notes.push(`${P.label} не располагал технической возможностью предотвратить столкновение.`);
          }
        }
      } else {
        for (const i of [A, B]) {
          addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, title: 'не убедился в безопасности проезда перекрёстка', detail: pr.explain, refs: ['pdd:1.5', 'pdd:10.1'] });
        }
      }
    } else {
      // ---- вне перекрёстка: перестроение, выезд с территории, поворот
      title = dh < 0.7 ? 'Попутное боковое столкновение' : 'Столкновение при манёвре';
      description = `${A.label} и ${B.label} столкнулись вне перекрёстка, скорость сближения около ${impactKmh} км/ч.`;
      const startOff = (i: Info) => roadsAt(geo, posAt(i, i.k0), 0.5).length === 0;
      const onNow = (i: Info) => roadsAt(geo, posAt(i, kp), 1).length > 0;
      let Y: Info | null = null;
      let reasonRefs: string[] = [];
      let why = '';
      if (startOff(A) !== startOff(B) && onNow(A) && onNow(B)) {
        Y = startOff(A) ? A : B;
        reasonRefs = ['pdd:8.3', 'koap:12.14.3'];
        why = `${Y.label} выезжал с прилегающей территории и обязан был уступить дорогу.`;
      } else {
        // манёвр: на сколько курс ушёл от оси дороги по сравнению с началом последних 2 с (кривизна дороги не в счёт)
        const devOver = (i: Info): number | null => {
          const k0 = Math.max(i.k0, kp - 80);
          const signed = (k: number): number | null => {
            const hits = roadsAt(geo, posAt(i, k), 1);
            return hits.length ? angDiff(angleOf(hits[0].near.tangent), i.tr.h[k]) : null;
          };
          const base = signed(k0);
          if (base === null) return null;
          let m = 0;
          for (let k = k0; k <= kp; k += 5) {
            const d = signed(k);
            if (d !== null) m = Math.max(m, Math.abs(angDiff(base, d)));
          }
          return m;
        };
        const dA = devOver(A);
        const dB = devOver(B);
        const a2 = dA ?? 0;
        const b2 = dB ?? 0;
        if (Math.max(a2, b2) > 0.12 && Math.abs(a2 - b2) > 0.08) {
          Y = a2 > b2 ? A : B;
          if (dh < 0.7) {
            reasonRefs = ['pdd:8.4', 'pdd:8.1', 'koap:12.14.3'];
            why = `${Y.label} менял полосу/смещался в сторону и должен был уступить попутному ТС.`;
          } else {
            reasonRefs = ['pdd:8.8', 'pdd:8.1', 'koap:12.14.3'];
            why = `${Y.label} выполнял поворот или разворот вне перекрёстка и должен был уступить дорогу.`;
          }
        }
      }
      if (Y) {
        notes.push(why);
        addFinding(ctx, { actorId: Y.a.id, severity: 'violation', t, causal: true, title: 'манёвр, создавший помеху другому ТС', detail: why, refs: reasonRefs });
        const P = Y === A ? B : A;
        const trP = P === A ? trA : trB;
        if (trP) notes.push(techText(trP, P.label, Y.label));
      } else {
        notes.push('Кто именно совершал манёвр, по траекториям определить не удаётся: оба водителя обязаны были выдерживать боковой интервал.');
        for (const i of [A, B]) {
          addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, title: 'не выдержал боковой интервал', detail: 'Безопасный боковой интервал не был соблюдён.', refs: ['pdd:9.10', 'pdd:1.5'] });
        }
      }
    }

    // нарушения, допущенные раньше (разметка, знак) и приведшие к ДТП
    for (const i of [A, B]) {
      for (const f of ctx.findings) {
        if (f.actorId === i.a.id && f.severity === 'violation' && !f.causal && f.t !== undefined && f.t <= t && t - f.t < 6 && f.refs.some((r) => ['koap:12.12.1', 'koap:12.15.4', 'koap:12.16.3', 'koap:12.16.1', 'koap:12.16.2', 'koap:12.15.2', 'koap:12.29.2'].includes(r))) {
          f.causal = true;
        }
      }
    }
    // груз, выступающий за габариты ТС, участвовал в контакте
    for (const i of [A, Bi]) {
      if (!i || !i.a.cargo || !cargoInvolved(i, boxAt, kp, col.point)) continue;
      notes.push(`${i.label}: удар пришёлся на груз, выступающий за габариты ТС (п. 23.1–23.4 ПДД).`);
      for (const f of ctx.findings) {
        if (f.actorId === i.a.id && f.severity === 'violation' && !f.causal && f.refs.some((r) => r.startsWith('pdd:23.'))) f.causal = true;
      }
    }
    reports.push(finishCollision(ctx, col, title, description, tech, notes));
    ctx.events.push({ t, text: `Столкновение ${A.label} и ${B.label}, скорость сближения ~${impactKmh} км/ч` });
  }
  return reports;
}

function len2(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function obstacleName(k: string): string {
  return { building: 'здание', fence: 'ограждение', tree: 'дерево', barrier: 'барьер' }[k] ?? 'препятствие';
}

function markCausal(ctx: Ctx, actorId: string): void {
  for (const f of ctx.findings) if (f.actorId === actorId && f.severity === 'violation') f.causal = true;
}

function reasonToBrake(ctx: Ctx, i: Info, k: number): boolean {
  const f = fromAngle(i.tr.h[k]);
  const p = posAt(i, k);
  const ahead = (q: Vec, maxDist: number, lat = i.hw + 1.2): boolean => {
    const l = toLocal(q, { cx: p.x, cy: p.y, a: i.tr.h[k] });
    return l.x > 0 && l.x < maxDist && Math.abs(l.y) < lat;
  };
  for (const lg of ctx.geo.lights) {
    const mid = { x: (lg.line.a.x + lg.line.b.x) / 2, y: (lg.line.a.y + lg.line.b.y) / 2 };
    if (dot(f, fromAngle(lg.light.angle)) > 0.5 && ahead(mid, 45, 8) && lightPhase(lg.light, tOf(k)) !== 'green') return true;
  }
  for (const o of ctx.infos.values()) {
    if (o === i || !o.tr.present[k]) continue;
    if (ahead(posAt(o, k), o.isVeh ? 30 : 35)) return true;
  }
  for (const ob of ctx.geo.obstacles) if (ahead({ x: ob.box.cx, y: ob.box.cy }, 30)) return true;
  for (const sg of ctx.geo.signs) {
    if ((sg.sign.kind === '2.5' || sg.sign.kind === '3.17.3') && dot(f, fromAngle(sg.sign.angle)) > 0.5 && ahead(sg.gate.b, 30, 10)) return true;
  }
  return false;
}

function finishCollision(ctx: Ctx, col: Collision, title: string, description: string, tech: TechAssessment[], notes: string[]): CollisionReport {
  const harm: { actorId: string; level: HarmLevel }[] = [];
  const A = ctx.infos.get(col.a)!;
  harm.push({ actorId: A.a.id, level: harmFor(A, col.dvA, col.rel) });
  const B = ctx.infos.get(col.b);
  if (B) harm.push({ actorId: B.a.id, level: harmFor(B, col.dvB, col.rel) });
  return { collision: col, title, description, harm, tech, notes };
}

// ---------------------------------------------------------------------------
// Околосвязанные проверки

function nearMisses(ctx: Ctx): void {
  const list = [...ctx.infos.values()].filter((x) => x.isVeh);
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const A = list[a];
      const B = list[b];
      if (ctx.tl.collisions.some((c) => (c.a === A.a.id && c.b === B.a.id) || (c.a === B.a.id && c.b === A.a.id))) continue;
      let best = Infinity;
      let bk = 0;
      for (let k = Math.max(A.k0, B.k0); k <= Math.min(A.kEnd, B.kEnd); k += 2) {
        const g = gap(boxAt(A, k), boxAt(B, k));
        if (g < best) {
          best = g;
          bk = k;
        }
      }
      if (best < 1.0 && Number.isFinite(best)) {
        ctx.events.push({ t: tOf(bk), text: `Опасное сближение ${A.label} и ${B.label}: просвет ${best.toFixed(1)} м` });
        for (const i of [A, B]) {
          ctx.findings.push({
            actorId: i.a.id,
            severity: 'info',
            t: tOf(bk),
            causal: false,
            title: `опасное сближение с ${(i === A ? B : A).label}`,
            detail: `Минимальный просвет между кузовами — ${best.toFixed(1)} м. Столкновения не произошло.`,
            refs: ['pdd:9.10'],
          });
        }
      }
    }
  }
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

function missedWrongSide(ctx: Ctx): void {
  // выезд на встречную без столкновения
  for (const [id, w] of ctx.onc) {
    const i = ctx.infos.get(id)!;
    const already = ctx.findings.some((f) => f.actorId === id && f.refs.includes('koap:12.15.4'));
    if (already) continue;
    const t = tOf(w.frames[0]);
    if (w.center === 'solid' || w.center === 'double') {
      const refs = ['pdd:9.1(1)'];
      if (w.lanes >= 2) refs.push('pdd:9.2');
      refs.push('koap:12.15.4');
      addFinding(ctx, {
        actorId: id,
        severity: 'violation',
        t,
        title: 'пересечение сплошной линии разметки / выезд на встречную полосу',
        detail: 'Разметка 1.1/1.3 запрещает пересекать линию и выезжать на сторону встречного движения.',
        refs,
      });
    } else {
      ctx.findings.push({
        actorId: id,
        severity: 'info',
        causal: false,
        t,
        title: 'выезд на полосу встречного движения',
        detail: 'Разметка допускает пересечение, но манёвр разрешён только если он безопасен и не создаёт помех встречным ТС (п. 11.1).',
        refs: ['pdd:11.1'],
      });
    }
    void i;
  }
}

// ---------------------------------------------------------------------------
// Правовая оценка

function harmToAll(reports: CollisionReport[]): Map<string, HarmLevel> {
  const m = new Map<string, HarmLevel>();
  for (const r of reports) {
    for (const h of r.harm) {
      const cur = m.get(h.actorId) ?? 'none';
      if (harmRank(h.level) > harmRank(cur)) m.set(h.actorId, h.level);
    }
  }
  return m;
}

function buildVerdicts(ctx: Ctx, reports: CollisionReport[]): ActorVerdict[] {
  const harm = harmToAll(reports);
  const verdicts: ActorVerdict[] = [];
  const hasCollision = reports.length > 0;

  for (const a of ctx.scene.actors) {
    const i = ctx.infos.get(a.id)!;
    const mine = ctx.findings.filter((f) => f.actorId === a.id);
    const viol = mine.filter((f) => f.severity === 'violation');
    const causal = viol.filter((f) => f.causal);
    const legal: LegalItem[] = [];

    // административные составы
    const seen = new Set<string>();
    for (const f of viol) {
      for (const r of f.refs) {
        if (r.startsWith('koap:') && !seen.has(r)) {
          seen.add(r);
          legal.push({ refs: [r], text: f.title });
        }
      }
    }

    // последствия для других участников (учитываются, если участник виновен)
    const consequences: LegalItem[] = [];
    let criminal = false;
    if (i.isVeh && causal.length) {
      let worst: HarmLevel = 'none';
      let fatalCount = 0;
      for (const [id, lv] of harm) {
        if (id === a.id) continue;
        if (harmRank(lv) > harmRank(worst)) worst = lv;
        if (lv === 'fatal') fatalCount++;
      }
      const agg = a.flags.drunk || a.flags.noLicense || a.flags.flees;
      const aggText = [a.flags.drunk && 'опьянение', a.flags.noLicense && 'отсутствие права управления', a.flags.flees && 'оставление места ДТП'].filter(Boolean).join(', ');
      const est = 'по расчётной оценке тяжести вреда';
      if (worst === 'light') consequences.push({ refs: ['koap:12.24.1'], text: `${est}: нарушение ПДД, повлёкшее лёгкий вред здоровью` });
      else if (worst === 'medium') consequences.push({ refs: ['koap:12.24.2'], text: `${est}: нарушение ПДД, повлёкшее вред здоровью средней тяжести` });
      else if (worst === 'severe') {
        criminal = true;
        consequences.push({ refs: [agg ? 'uk:264.2' : 'uk:264.1'], text: `${est}: нарушение ПДД, повлёкшее тяжкий вред здоровью${agg ? ` (отягчающие: ${aggText})` : ''}` });
      } else if (worst === 'fatal') {
        criminal = true;
        const id = fatalCount >= 2 ? (agg ? 'uk:264.6' : 'uk:264.5') : agg ? 'uk:264.4' : 'uk:264.3';
        consequences.push({ refs: [id], text: `${est}: нарушение ПДД, повлёкшее смерть${fatalCount >= 2 ? ' двух и более лиц' : ' человека'}${agg ? ` (отягчающие: ${aggText})` : ''}` });
      } else if (hasCollision) {
        consequences.push({ refs: ['gk:1064', 'gk:1079'], text: 'вред здоровью маловероятен: имущественный ущерб возмещается в гражданско-правовом порядке (ОСАГО)' });
      }
      if (worst !== 'none') {
        consequences.push({
          refs: ['koap:12.24.1', 'koap:12.24.2', 'uk:264.1', 'uk:264.3'],
          text: 'Окончательная квалификация зависит от тяжести вреда по заключению судебно-медицинской экспертизы: лёгкий — ст. 12.24 ч. 1 КоАП; средней тяжести — ч. 2 той же статьи; тяжкий вред — ч. 1 ст. 264 УК; смерть — ч. 3 ст. 264 УК',
        });
      }
    }

    // водитель-нарушитель: опьянение, права, оставление места
    if (i.isVeh) {
      if (a.flags.drunk) {
        legal.push(
          criminal
            ? { refs: ['pdd:2.7'], text: 'управление в состоянии опьянения — отягчающее обстоятельство по ст. 264 УК РФ' }
            : { refs: ['pdd:2.7', 'koap:12.8.1'], text: 'управление в состоянии опьянения' },
        );
      }
      if (a.flags.noLicense) legal.push({ refs: ['koap:12.7.1'], text: 'управление без права управления' });
      if (a.flags.flees && hasCollision) {
        legal.push(
          criminal
            ? { refs: ['pdd:2.5'], text: 'оставление места ДТП — отягчающее обстоятельство по ст. 264 УК РФ' }
            : { refs: ['pdd:2.5', 'koap:12.27.2'], text: 'оставление места ДТП' },
        );
      }
    }
    legal.push(...consequences);

    let status: ActorVerdict['status'];
    let text: string;
    if (causal.length) {
      status = 'guilty';
      text = `Нарушения в причинной связи со столкновением: ${causal.map((f) => f.title).join('; ')}.`;
    } else if (viol.length) {
      status = 'minor';
      text = hasCollision
        ? `Нарушения ПДД есть, но прямой причинной связи со столкновением не установлено: ${viol.map((f) => f.title).join('; ')}.`
        : `Выявлены нарушения: ${viol.map((f) => f.title).join('; ')}.`;
    } else {
      status = 'clean';
      text = hasCollision && !reports.some((r) => r.collision.a === a.id || r.collision.b === a.id)
        ? 'В столкновении не участвовал, нарушений ПДД не выявлено.'
        : 'Нарушений ПДД не выявлено.';
    }
    verdicts.push({ actorId: a.id, status, text, legal });
  }
  return verdicts;
}

function buildDuties(reports: CollisionReport[]): LegalItem[] {
  if (!reports.length) return [];
  const harm = harmToAll(reports);
  const anyHarm = [...harm.values()].some((h) => h !== 'none');
  const out: LegalItem[] = [
    { refs: ['pdd:2.5'], text: 'Немедленно остановить ТС, включить аварийную сигнализацию, выставить знак аварийной остановки, ничего не перемещать на месте ДТП.' },
  ];
  if (anyHarm) {
    out.push({ refs: ['pdd:2.6'], text: 'Если есть пострадавшие: оказать первую помощь, вызвать скорую помощь и полицию, записать данные очевидцев, дождаться сотрудников полиции.' });
  } else {
    out.push({ refs: ['pdd:2.6.1', 'osago:11.1'], text: 'Если вред причинён только имуществу: зафиксировать обстановку, при создании помех освободить проезжую часть; оформить ДТП с полицией или без неё (европротокол) при выполнении условий закона об ОСАГО.' });
  }
  out.push({ refs: ['koap:12.27.1', 'koap:12.27.2'], text: 'Невыполнение этих обязанностей, а тем более оставление места ДТП, влечёт самостоятельную ответственность.' });
  return out;
}

// ---------------------------------------------------------------------------

export function analyze(scene: Scene, tl: Timeline): Report {
  const ctx = prepare(scene, tl);
  collectGates(ctx);
  computeGateEnds(ctx);
  for (const i of ctx.infos.values()) {
    if (i.a.type === 'train') continue;
    if (i.isVeh) {
      if (!hasEmergencySignals(i.a)) {
        checkSpeed(ctx, i);
        checkPosition(ctx, i);
      }
      checkLights(ctx, i);
      if (!hasEmergencySignals(i.a)) {
        checkSigns(ctx, i);
        checkTurnSignals(ctx, i, (f) => addFinding(ctx, f));
      }
    } else {
      checkPedestrian(ctx, i);
    }
  }
  checkOvertakes(ctx);
  const kit: Kit = { add: (f) => addFinding(ctx, f), reasonToBrake, boxAt, posAt };
  checkSignRules(ctx, kit);
  checkMarkingRules(ctx, kit);
  checkCargoRules(ctx, kit);
  checkRailwayRules(ctx, kit);
  const collisions = analyzeCollisions(ctx);
  nearMisses(ctx);
  missedWrongSide(ctx);

  // скорость — причина, если при допустимой скорости столкновения удалось бы избежать
  for (const r of collisions) {
    for (const t of r.tech) {
      if (t.avoidableAtLimit && !t.avoidable) {
        for (const f of ctx.findings) {
          if (f.actorId === t.actorId && f.severity === 'violation' && f.refs.some((x) => x.startsWith('koap:12.9'))) f.causal = true;
        }
        r.notes.push(`${ctx.infos.get(t.actorId)!.label}: при допустимой скорости (${t.limitKmh} км/ч) остановиться до места столкновения удавалось бы — превышение скорости находится в причинной связи с ДТП.`);
      }
    }
  }

  const verdicts = buildVerdicts(ctx, collisions);
  const duties = buildDuties(collisions);
  const events = ctx.events.sort((a, b) => a.t - b.t);

  const summary: string[] = [];
  if (!collisions.length) {
    summary.push('Столкновений не произошло.');
    const v = verdicts.filter((x) => x.status !== 'clean').length;
    summary.push(v ? 'Тем не менее у части участников выявлены нарушения ПДД.' : 'Нарушений ПДД не выявлено.');
  } else {
    summary.push(collisions.length === 1 ? `Произошло ДТП: ${collisions[0].title.toLowerCase()}.` : `Произошло ${collisions.length} столкновения.`);
    const guilty = verdicts.filter((v) => v.status === 'guilty');
    const labels = actorLabels(scene);
    if (guilty.length === 1) summary.push(`Нарушения ПДД, находящиеся в причинной связи с ДТП, допустил(а): ${labels.get(guilty[0].actorId)}.`);
    else if (guilty.length > 1) summary.push(`Нарушения, находящиеся в причинной связи с ДТП, допустили: ${guilty.map((g) => labels.get(g.actorId)).join(', ')} (обоюдная вина).`);
    else summary.push('Нарушений ПДД в причинной связи со столкновением не выявлено — возможно, ДТП вызвано внешними обстоятельствами или заданы недостаточные данные.');
  }

  const assumptions = [
    `Покрытие: ${SURFACES[scene.env.surface].name.toLowerCase()} (коэффициент сцепления ${tl.mu}).`,
    `Время реакции водителя ${REACT.toFixed(1)} с, запаздывание тормозов ${BRAKE_LAG.toFixed(1)} с.`,
    'Тяжесть вреда здоровью оценена по скорости столкновения ориентировочно; её устанавливает судебно-медицинская экспертиза.',
    'Если на перекрёстке нет знаков приоритета и светофора, он считается равнозначным.',
  ];

  return { hasCollision: collisions.length > 0, summary, events, findings: ctx.findings, collisions, verdicts, duties, assumptions };
}
