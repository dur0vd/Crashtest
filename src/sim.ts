import { buildGeo } from './geo';
import {
  type OBB,
  type PathData,
  type Vec,
  add,
  buildPath,
  dist,
  dot,
  fromAngle,
  len,
  mul,
  ms,
  nearestOnPolyline,
  obbContact,
  pathAt,
  sub,
  wrapAngle,
} from './geom';
import { type Actor, type Scene, type VehicleType, SURFACES, VEHICLES, actorSpec, dimsOf, validateSimParameters } from './scene';
import type { DynamicControl, DynamicRoad, DynamicState, DynamicVehicleParameters, ParameterSource } from './physics/types';
import { DYNAMIC_FRAME_DT, DYNAMIC_SUBSTEP, DYNAMICS_LIMITATIONS, bodyVelocity, integrateSubstep } from './physics/dynamics';
import { dynamicSupport, initialDynamicState } from './physics/actor';
import { validateDynamicParameters } from './physics/parameters';
import { type PhysicsZone, type ResolvedSurface, resolveSurface, validateZones } from './physics/zones';
import {
  type BrakeTiming, type ControllerSettings, type HazardResponse, BrakeActuator, defaultController, limitSteer, lookahead,
  purePursuitSteer, stanleySteer, validateController, validateHazard,
} from './physics/controller';
import {
  type Barrier, type ImpactSettings, type PostImpactSettings, type SimulationOptions, type VulnerableBodyInput, DEFAULT_POST_IMPACT_SOURCE,
  validateBarrier, validateBraking, validateImpact, validatePostImpact, validateVulnerable,
} from './physics/extension';
import { type ImpactBody, type ImpactResult, planarImpact } from './physics/impact';

/** Geometric half-width of a guardrail polyline treated as a thin rigid body, m (model choice). */
const GUARDRAIL_HALF_WIDTH = 0.1;

export const DT = 0.025;
const G = 9.81;
/** замедление при плановом снижении скорости (не до остановки), м/с² */
const SERVICE_DECEL = 3.5;

export interface Track {
  id: string;
  x: Float32Array;
  y: Float32Array;
  /** курс, рад */
  h: Float32Array;
  /** Модуль физической скорости, м/с; направление заднего хода — reversing. */
  v: Float32Array;
  /** участник находится на сцене */
  present: Uint8Array;
  /** после столкновения движется по инерции */
  free: Uint8Array;
  /** Задний ход в текущем кадре, курс h относится к кузову, не к вектору скорости. */
  reversing?: Uint8Array;
  /** Фактические абсолютные времена достижения точек Actor.path; -1 — не достигнута. */
  waypointTimes?: number[];
  /** Dynamic mode only: samples of the force model for traces and rendering (not a second simulation). */
  dynamics?: DynamicTrackSamples;
}

/** Per-frame samples; wheel arrays hold 4 values per frame in FL, FR, RL, RR order. */
export interface DynamicTrackSamples {
  vx: Float32Array;
  vy: Float32Array;
  yawRate: Float32Array;
  /** Body sideslip atan2(v, u), rad; 0 at rest. */
  sideslip: Float32Array;
  steering: Float32Array;
  drive: Float32Array;
  brake: Float32Array;
  mu: Float32Array;
  muKnown: Uint8Array;
  gradeKnown: Uint8Array;
  staticHold: Uint8Array;
  /** mu zone id per frame, null when the scene surface preset was used. */
  zone: (string | null)[];
  wheelLoad: Float32Array;
  wheelFx: Float32Array;
  wheelFy: Float32Array;
  wheelUse: Float32Array;
  /** 0 rolling, 1 locked, 2 unloaded. */
  wheelMode: Uint8Array;
}

export type PhysicsMode = 'kinematic' | 'dynamic';
export type ActorMotionMethod = 'legacy-kinematic' | 'dynamic-four-wheel' | 'pedestrian-kinematic'
  | 'rail-kinematic' | 'two-wheeler-or-sim-kinematic';

export interface TimelinePhysics {
  mode: PhysicsMode;
  methods: Record<string, ActorMotionMethod>;
  substepSeconds?: number;
  controllers?: Record<string, ControllerSettings>;
  brakeTiming?: Record<string, BrakeTiming>;
  hazards?: Record<string, HazardResponse>;
  postImpact?: Record<string, PostImpactSettings>;
  impact?: ImpactSettings;
  vulnerableImpact?: ImpactSettings;
  zones?: PhysicsZone[];
  barriers?: Barrier[];
  rest?: Record<string, RestPose>;
  vulnerable?: Record<string, VulnerableBodyInput>;
  /** Separated riders of two-wheelers (stage 09), not scene actors. */
  riders?: Record<string, { x: Float32Array; y: Float32Array; v: Float32Array; present: Uint8Array; mass: number;
    separation: string; rest: { x: number; y: number; atRest: boolean } | null }>;
  assumptions: string[];
  limitations: string[];
}

export interface PhysicsIssue {
  actorId: string;
  code: 'unsupported-class' | 'missing-parameters' | 'abs-unknown' | 'invalid-input';
  message: string;
}

/** Dynamic mode never silently falls back to kinematics; unsupported actors are listed. */
export class PhysicsUnsupportedError extends Error {
  constructor(readonly issues: PhysicsIssue[]) {
    super(`Динамический режим недоступен: ${issues.map(i => `${i.actorId}: ${i.message}`).join('; ')}`);
    this.name = 'PhysicsUnsupportedError';
  }
}

export interface Collision {
  /** порядковый номер */
  idx: number;
  t: number;
  frame: number;
  a: string;
  /** второй участник или препятствие */
  b: string;
  kind: 'vv' | 'vp' | 'vo';
  point: Vec;
  /** нормаль от A к B */
  n: Vec;
  /** векторы скорости до удара, м/с */
  vA: Vec;
  vB: Vec;
  /** скорость сближения вдоль нормали, м/с */
  rel: number;
  /** изменение скорости каждого участника при ударе, м/с */
  dvA: number;
  dvB: number;
  /** Dynamic mode: planar impulse with rotation (stage 08). */
  impact?: ImpactRecord;
}

export interface Timeline {
  dt: number;
  n: number;
  duration: number;
  mu: number;
  tracks: Map<string, Track>;
  collisions: Collision[];
  /** Selected motion model per actor and its explicit assumptions. */
  physics?: TimelinePhysics;
}

export interface RestPose { x: number; y: number; heading: number; atRest: boolean }

/** Stage 08 impact record (dynamic mode); dvA/dvB of Collision are |deltaV| over the contact episode. */
export interface ImpactRecord {
  method: string;
  target: 'vehicle' | 'kinematic-vehicle' | 'pedestrian' | 'obstacle' | 'guardrail' | 'curb';
  /** n-th separate contact episode of this pair (1 = first impact). */
  sequence: number;
  restitution: number;
  contactFriction?: number;
  settingsSource: ParameterSource;
  mode: 'full' | 'sliding';
  impulses: number;
  impulse: Vec;
  deltaVA: Vec;
  deltaVB: Vec;
  deltaYawRateA: number;
  deltaYawRateB: number;
  energyLoss: number;
  energyNormal: number;
  energyTangential: number;
  energyIncrease: boolean;
  pdofA?: number;
  clockA?: number;
  pdofB?: number;
  clockB?: number;
  /** Full trace of the first impulse of the episode. */
  first: ImpactResult;
}

interface Node {
  s: number;
  V: number;
  hold: number;
  reverse: boolean;
  waypointIndex?: number;
  /** Before the next segment changes direction this node is a mandatory stop. */
  directionStop?: boolean;
}

/** Stage 09 post-impact phases of a particle body: flight without friction, landing, slide. */
type ThrowState = { mode: 'flight'; remaining: number; landingVz: number; friction: number } | { mode: 'slide'; friction: number };

interface Rt {
  thrown?: ThrowState;
  a: Actor;
  path: PathData;
  nodes: Node[];
  next: number;
  s: number;
  v: number;
  pos: Vec;
  h: number;
  mode: 'path' | 'free';
  vel: Vec;
  hold: number;
  present: boolean;
  down: boolean;
  mass: number;
  accel: number;
  brake: number;
  /** замедление, на которое рассчитывает водитель при планировании торможения (как на сухой дороге) */
  plan: number;
  box: { hl: number; hw: number };
  /** смещение центра кузова с грузом относительно опорной точки вдоль курса */
  shift: number;
  /** едет по рельсам: путь лежит на колее, а удар не сбивает с неё (если нет схода) */
  rail: boolean;
  reverse: boolean;
  waypointTimes: number[];
  /** Braking past a reversing point continues in the incoming direction. */
  stopOverrun: boolean;
}

/** Закрытие скорости при ударе, с которой трамвай с разрешённым сходом покидает рельсы, м/с (≈ 20 км/ч). */
const DERAIL_REL = 5.5;

/**
 * Путь трамвая строго по колее: контрольные точки проецируются на ближайший путь,
 * между ними берутся вершины самого пути. Если пути рядом нет, возвращается null.
 */
function railPath(a: Actor, tracks: Vec[][]): { path: PathData; nodeS: number[] } | null {
  const ctrl: Vec[] = [{ x: a.x, y: a.y }, ...a.path.map((w) => ({ x: w.x, y: w.y }))];
  let best: { pts: Vec[]; d: number } | null = null;
  for (const pts of tracks) {
    if (pts.length < 2) continue;
    const d = nearestOnPolyline(pts, ctrl[0]).dist;
    if (d <= 4 && (!best || d < best.d)) best = { pts, d };
  }
  if (!best) return null;
  const pts = best.pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const at = (st: number): Vec => {
    const q = pathAt({ pts, cum, total, nodeS: [] }, Math.max(0, Math.min(total, st)));
    return q.p;
  };
  const near0 = nearestOnPolyline(pts, ctrl[0]);
  const stations = ctrl.map((c) => nearestOnPolyline(pts, c).s);
  // направление движения: по последней точке, а без неё — по курсу
  let fwd = dot(near0.tangent, fromAngle(a.heading)) >= 0;
  if (ctrl.length > 1) {
    const last = stations[stations.length - 1];
    if (Math.abs(last - stations[0]) > 0.5) fwd = last > stations[0];
  }
  const sign = fwd ? 1 : -1;
  const out: Vec[] = [at(stations[0])];
  const nodeIdx: number[] = [0];
  let cur = stations[0];
  for (let i = 1; i < ctrl.length; i++) {
    const target = sign > 0 ? Math.max(cur, stations[i]) : Math.min(cur, stations[i]);
    for (let j = 0; j < pts.length; j++) {
      if (sign > 0 ? cum[j] > cur + 1e-6 && cum[j] < target - 1e-6 : cum[j] < cur - 1e-6 && cum[j] > target + 1e-6) out.push(pts[j]);
    }
    if (sign < 0) {
      // вершины при движении назад идут в обратном порядке
      const k = nodeIdx[nodeIdx.length - 1];
      const seg = out.splice(k + 1).reverse();
      out.push(...seg);
    }
    out.push(at(target));
    nodeIdx.push(out.length - 1);
    cur = target;
  }
  if (ctrl.length === 1) {
    // без маршрута: до конца пути в сторону движения
    for (let j = 0; j < pts.length; j++) {
      if (sign > 0 ? cum[j] > cur + 1e-6 : cum[j] < cur - 1e-6) out.push(pts[j]);
    }
    if (sign < 0) {
      const seg = out.splice(1).reverse();
      out.push(...seg);
    }
  }
  const c2 = [0];
  for (let i = 1; i < out.length; i++) c2.push(c2[i - 1] + dist(out[i - 1], out[i]));
  return { path: { pts: out, cum: c2, total: c2[c2.length - 1], nodeS: nodeIdx.map((i) => c2[i]) }, nodeS: nodeIdx.map((i) => c2[i]) };
}

function makeRuntime(a: Actor, mu: number, tracks: Vec[][]): Rt {
  const spec = dimsOf(a);
  const start: Vec = { x: a.x, y: a.y };
  const ctrl: Vec[] = [start, ...a.path.map((w) => ({ x: w.x, y: w.y }))];
  if (ctrl.length === 1) ctrl.push(add(start, mul(fromAngle(a.heading), a.speed < 0 ? -2000 : 2000)));
  const onRail = a.kind === 'vehicle' && VEHICLES[a.type as VehicleType].rail;
  const rp = onRail ? railPath(a, tracks) : null;
  if (a.railwayTrain && !rp) throw new Error(`Поезд ${a.id}: задайте железнодорожный путь не далее 4 м от начальной точки`);
  const path = rp ? rp.path : buildPath(ctrl, true);
  // A waypoint's signed speed describes travel towards that waypoint. An
  // initial zero-speed target preserves the starting gear until it is reached.
  const initialReverse = a.kind === 'vehicle' && (a.path[0]?.v ? a.path[0].v < 0 : a.speed < 0);
  const nodes: Node[] = [{ s: 0, V: ms(Math.abs(a.speed)), hold: 0, reverse: initialReverse }];
  let reverse = initialReverse;
  a.path.forEach((w, i) => {
    if (w.v !== 0) reverse = a.kind === 'vehicle' && w.v < 0;
    nodes.push({ s: path.nodeS[i + 1], V: ms(Math.abs(w.v)), hold: w.hold ?? 0, reverse, waypointIndex: i });
  });
  // Switching between forward and reverse is never a change of signed velocity
  // at speed. The preceding waypoint becomes a stop even if its authored speed
  // is nonzero; the next segment starts only after a recorded resting frame.
  for (let i = 1; i < nodes.length - 1; i++) if (nodes[i].reverse !== nodes[i + 1].reverse) {
    nodes[i].V = 0;
    nodes[i].directionStop = true;
  }
  let accel = 2;
  let brake = 3;
  let plan = 3;
  if (a.kind === 'vehicle') {
    const vs = VEHICLES[a.type as VehicleType];
    // гружёный автомобиль разгоняется медленнее
    accel = (vs.accel * vs.mass) / spec.mass;
    brake = Math.min(vs.brakeCap ?? Infinity, mu * G * vs.brakeFactor);
    plan = Math.min(vs.brakeCap ?? Infinity, SURFACES.dry.mu * G * vs.brakeFactor);
    if (a.type === 'sim') {
      accel = a.simParameters!.accel!;
      // User-entered dry maximum, scaled by the selected surface's friction.
      plan = a.simParameters!.brakeDecel!;
      brake = plan * mu / SURFACES.dry.mu;
    }
    if (a.railwayTrain) {
      // TODO(source-check): каталог составов и тяговая модель. Здесь только
      // явно заданная исходная скорость и постоянное замедление из источника.
      accel = 0;
      brake = a.railwayTrain.brakeDecel;
      plan = brake;
    }
  }
  const p0 = pathAt(path, 0);
  return {
    a,
    path,
    nodes,
    next: 1,
    s: 0,
    v: nodes[0].V,
    pos: p0.p,
    h: initialReverse ? wrapAngle(p0.a + Math.PI) : p0.a,
    mode: 'path',
    vel: { x: 0, y: 0 },
    hold: 0,
    present: false,
    down: false,
    mass: spec.mass,
    accel,
    brake,
    plan,
    box: { hl: spec.length / 2, hw: spec.width / 2 },
    shift: spec.shift,
    rail: !!rp,
    reverse: initialReverse,
    waypointTimes: a.path.map(() => -1),
    stopOverrun: false,
  };
}

function boxOf(r: Rt): OBB {
  return { cx: r.pos.x + Math.cos(r.h) * r.shift, cy: r.pos.y + Math.sin(r.h) * r.shift, hl: r.box.hl, hw: r.box.hw, a: r.h };
}

/** Reconnect the still-unvisited route after a friction-limited gear-change stop.
 * A missed stop is not corrected by teleporting backwards to the drawn waypoint. */
function continueAfterOverrun(r: Rt): void {
  const tail = r.nodes.slice(r.next);
  if (!tail.length) return;
  const ctrl = [r.pos, ...tail.map(nd => pathAt(r.path, nd.s).p)];
  const path = buildPath(ctrl, true);
  r.path = path;
  r.nodes = [{ s: 0, V: 0, hold: 0, reverse: r.reverse }, ...tail.map((nd, i) => ({ ...nd, s: path.nodeS[i + 1] }))];
  r.next = 1;
  r.s = 0;
}

function stepPath(r: Rt, dt: number, time: number): void {
  if (r.hold > 0) {
    r.hold = Math.max(0, r.hold - dt);
    r.v = 0;
    return;
  }
  let nodes = r.nodes;
  // A preceding mandatory stop has already produced a resting frame.
  if (r.next < nodes.length && nodes[r.next].reverse !== r.reverse && r.v === 0) r.reverse = nodes[r.next].reverse;
  // достигнутые узлы
  while (r.next < nodes.length) {
    const nd = nodes[r.next];
    const left = nd.s - r.s;
    const settled = nd.directionStop || r.a.railwayTrain ? r.v <= r.brake * dt + 1e-9 : r.v < 1.0;
    if (nd.V < 0.3 && left <= Math.max(0.03, r.v * dt) && settled) {
      // On a slippery surface an unreachable stop may have been passed. Keep
      // braking to rest there; never skip the requested hold or move backwards.
      r.s = Math.max(r.s, nd.s);
      r.v = 0;
      r.hold = nd.hold;
      if (!r.stopOverrun) r.pos = pathAt(r.path, r.s).p;
      // Preserve body orientation during the stop/hold. At a reverse cusp the
      // outgoing path tangent points backwards, though the body has not turned.
      if (nd.waypointIndex !== undefined && r.waypointTimes[nd.waypointIndex] < 0) r.waypointTimes[nd.waypointIndex] = time;
      r.next++;
      const changesDirection = nd.directionStop === true;
      if (r.stopOverrun) {
        continueAfterOverrun(r);
        r.stopOverrun = false;
        nodes = r.nodes;
      }
      if (nd.hold > 0 || changesDirection) return;
      continue;
    }
    if (left <= 0 && nd.V >= 0.3) {
      if (nd.waypointIndex !== undefined && r.waypointTimes[nd.waypointIndex] < 0) r.waypointTimes[nd.waypointIndex] = time;
      r.next++;
    } else break;
  }
  const last = nodes[nodes.length - 1];
  const vDes = r.next < nodes.length ? nodes[r.next].V : last.V;
  let v = r.v;
  if (v < vDes) v = Math.min(vDes, v + r.accel * dt);
  else if (r.next >= nodes.length && v > vDes) v = Math.max(vDes, v - r.brake * dt);
  // огибающая торможения: к каждому узлу впереди водитель планирует успеть сбросить скорость
  let allowed = Infinity;
  for (let j = r.next; j < nodes.length; j++) {
    const nd = nodes[j];
    const b = nd.V < 0.3 ? r.plan : Math.min(r.plan, SERVICE_DECEL);
    const lim = Math.sqrt(nd.V * nd.V + 2 * b * Math.max(0, nd.s - r.s));
    if (lim < allowed) allowed = lim;
  }
  // реальное замедление ограничено сцеплением, поэтому на скользкой дороге ТС может не успеть
  if (v > allowed) v = Math.max(allowed, v - r.brake * dt);
  r.v = Math.max(0, v);
  const step = r.v * dt;
  const target = nodes[r.next];
  if (r.stopOverrun || target?.directionStop && r.s + step >= target.s && r.v > r.brake * dt + 1e-9) {
    // Continue the incoming physical movement while the brakes bring the car
    // to rest; following the outgoing cusp at speed would rotate its body.
    r.pos = add(r.pos, mul(fromAngle(r.h), step * (r.reverse ? -1 : 1)));
    r.s = target.s;
    r.stopOverrun = true;
    return;
  }
  r.s += step;
  const p = pathAt(r.path, r.s);
  r.pos = p.p;
  if (r.v > 0) r.h = r.reverse ? wrapAngle(p.a + Math.PI) : p.a;
  for (const nd of nodes) if (nd.V >= 0.3 && nd.s <= r.s && nd.waypointIndex !== undefined && r.waypointTimes[nd.waypointIndex] < 0) {
    r.waypointTimes[nd.waypointIndex] = time;
  }
}

/** Реакция на удар: обычное ТС и пешеход слетают с траектории, трамвай остаётся на рельсах и тормозит. */
function hit(r: Rt, rel: number): void {
  if (!r.rail || r.mode !== 'path') {
    toFree(r);
    return;
  }
  if (!r.a.railwayTrain && r.a.derail && rel >= DERAIL_REL) {
    r.rail = false;
    toFree(r);
    return;
  }
  const d = (r.v * r.v) / (2 * Math.min(r.brake, r.plan));
  r.nodes = [
    { s: r.s, V: r.v, hold: 0, reverse: r.reverse },
    { s: r.s + d, V: 0, hold: 0, reverse: r.reverse },
  ];
  r.next = 1;
}

function velocityOf(r: Rt): Vec {
  return r.mode === 'free' ? r.vel : mul(fromAngle(r.h), r.v * (r.reverse ? -1 : 1));
}

function toFree(r: Rt): void {
  if (r.mode === 'free') return;
  r.vel = velocityOf(r);
  r.mode = 'free';
}

/**
 * env.physics absent or 'kinematic' keeps the legacy kinematic simulator
 * unchanged; 'dynamic' runs the force model with a route controller.
 */
export function simulate(scene: Scene, options: SimulationOptions = {}): Timeline {
  if ((scene.env.physics ?? 'kinematic') === 'dynamic') return simulateDynamic(scene, options);
  const tl = simulateKinematic(scene);
  tl.physics = { mode: 'kinematic', methods: Object.fromEntries(scene.actors.map(a => [a.id, 'legacy-kinematic' as const])),
    assumptions: ['Кинематический (упрощённый) режим: участники следуют траектории, ускорения не ограничены сцеплением, удар поступательный.'],
    limitations: ['Не является динамической реконструкцией; для неё выберите env.physics=dynamic и задайте параметры ТС с источниками.'] };
  return tl;
}

function simulateKinematic(scene: Scene): Timeline {
  scene.actors.forEach(validateSimParameters);
  const geo = buildGeo(scene);
  const mu = SURFACES[scene.env.surface].mu;
  const duration = Math.max(1, scene.env.duration);
  const n = Math.floor(duration / DT) + 1;

  const rts = scene.actors.map((a) => makeRuntime(a, mu, geo.tracks.filter(t => a.railwayTrain
    ? t.item.kind === 'railway' && (!a.railwayTrain.trackId || t.item.id === a.railwayTrain.trackId)
    : t.item.kind !== 'railway').map(t => t.pts)));
  const tracks = new Map<string, Track>();
  for (const r of rts) {
    tracks.set(r.a.id, {
      id: r.a.id,
      x: new Float32Array(n),
      y: new Float32Array(n),
      h: new Float32Array(n),
      v: new Float32Array(n),
      present: new Uint8Array(n),
      free: new Uint8Array(n),
      reversing: new Uint8Array(n),
      waypointTimes: r.waypointTimes,
    });
  }

  const collisions: Collision[] = [];
  /** пары, у которых первый контакт уже зафиксирован (повторные касания не считаем новыми ДТП) */
  const contacts = new Set<string>();

  for (let k = 0; k < n; k++) {
    const t = k * DT;

    for (const r of rts) {
      if (!r.present && t >= r.a.delay - 1e-9) r.present = true;
      if (!r.present) continue;
      if (r.mode === 'path') {
        if (k > 0 || r.a.delay > 0) stepPath(r, DT, t);
      } else {
        const sp = len(r.vel);
        if (sp > 0) {
          const dec = r.a.kind === 'pedestrian' ? 4 : mu * G;
          const nsp = Math.max(0, sp - dec * DT);
          r.vel = mul(r.vel, nsp / sp);
          r.pos = add(r.pos, mul(r.vel, DT));
          if (nsp < 0.02) r.vel = { x: 0, y: 0 };
        }
      }
    }

    // столкновения
    for (let i = 0; i < rts.length; i++) {
      const A = rts[i];
      if (!A.present) continue;
      for (let j = i + 1; j < rts.length; j++) {
        const B = rts[j];
        if (!B.present) continue;
        if (A.a.kind === 'pedestrian' && B.a.kind === 'pedestrian') continue;
        const c = obbContact(boxOf(A), boxOf(B), sub(velocityOf(A), velocityOf(B)));
        const key = `${A.a.id}|${B.a.id}`;
        if (!c) continue;
        resolve(A, B, 1 / A.mass, 1 / B.mass, c, key);
      }
      for (const og of geo.obstacles) {
        const c = obbContact(boxOf(A), og.box, velocityOf(A));
        const key = `${A.a.id}|${og.item.id}`;
        if (!c) continue;
        resolve(A, null, 1 / A.mass, 0, c, key, og.item.id);
      }
    }

    for (const r of rts) {
      const tr = tracks.get(r.a.id)!;
      tr.x[k] = r.pos.x;
      tr.y[k] = r.pos.y;
      tr.h[k] = r.h;
      tr.v[k] = r.mode === 'free' ? len(r.vel) : r.v;
      tr.present[k] = r.present ? 1 : 0;
      tr.free[k] = r.mode === 'free' ? 1 : 0;
      tr.reversing![k] = r.present && (r.mode === 'path' ? r.reverse : dot(r.vel, fromAngle(r.h)) < -1e-6) ? 1 : 0;
    }

    function resolve(
      A: Rt,
      B: Rt | null,
      invA: number,
      invB: number,
      c: { n: Vec; depth: number; point: Vec },
      key: string,
      obstacleId?: string,
    ): void {
      const fresh = !contacts.has(key);
      if (fresh) {
        contacts.add(key);
        const vA = velocityOf(A);
        const vB = B ? velocityOf(B) : { x: 0, y: 0 };
        const rel = dot(sub(vA, vB), c.n);
        for (const r of B ? [A, B] : [A]) hit(r, rel);
        const railA = A.rail && A.mode === 'path';
        const railB = !!B && B.rail && B.mode === 'path';
        let dvA = 0;
        let dvB = 0;
        if (rel > 0) {
          const e = 0.12;
          const j = ((1 + e) * rel) / (invA + invB);
          if (!railA) A.vel = sub(A.vel, mul(c.n, j * invA));
          if (B && !railB) B.vel = add(B.vel, mul(c.n, j * invB));
          dvA = j * invA;
          dvB = j * invB;
        }
        if (A.a.kind === 'pedestrian') A.down = true;
        if (B?.a.kind === 'pedestrian') B.down = true;
        collisions.push({
          idx: collisions.length,
          t: k * DT,
          frame: k,
          a: A.a.id,
          b: B ? B.a.id : obstacleId!,
          kind: !B ? 'vo' : A.a.kind === 'pedestrian' || B.a.kind === 'pedestrian' ? 'vp' : 'vv',
          point: c.point,
          n: c.n,
          vA,
          vB,
          rel: Math.max(0, rel),
          dvA,
          dvB,
        });
      }
      // раздвигаем пересёкшиеся тела
      // трамвай на рельсах с места не сдвигается: другое тело отодвигается целиком
      const wA = A.rail && A.mode === 'path' ? 0 : invA;
      const wB = B && B.rail && B.mode === 'path' ? 0 : invB;
      const tot = wA + wB;
      if (tot > 0) {
        A.pos = sub(A.pos, mul(c.n, (c.depth * wA) / tot));
        if (B) B.pos = add(B.pos, mul(c.n, (c.depth * wB) / tot));
      }
    }
  }

  return { dt: DT, n, duration, mu, tracks, collisions };
}

// ---------------------------------------------------------------------------
// Dynamic mode (07.2): the drawn route is an intent; a controller converts it
// into steering/drive/brake commands for the force model. Positions are never
// pulled back onto the path when tyres saturate.

const TWO_WHEEL_OR_SIM: VehicleType[] = ['bicycle', 'moped', 'motorcycle', 'sim'];

/** Motion model chosen for an actor in dynamic mode, or the reason it is unsupported. */
export function dynamicMotionMethod(a: Actor): ActorMotionMethod | PhysicsIssue {
  if (a.kind === 'pedestrian') return 'pedestrian-kinematic';
  const type = a.type as VehicleType;
  if (a.railwayTrain || VEHICLES[type].rail) return 'rail-kinematic';
  if (TWO_WHEEL_OR_SIM.includes(type)) return 'two-wheeler-or-sim-kinematic';
  if (type === 'cart') return { actorId: a.id, code: 'unsupported-class', message: 'для гужевой повозки нет динамической модели' };
  const support = dynamicSupport(a);
  if (!support.supported) return { actorId: a.id, code: 'missing-parameters', message: support.reason };
  if (support.parameters.brakes.abs === 'unknown') {
    return { actorId: a.id, code: 'abs-unknown', message: 'ABS не задан явно (unknown): регулятор маршрута не может применять тормоз' };
  }
  return 'dynamic-four-wheel';
}

interface PathProjection { s: number; d: number; angle: number; point: Vec }

/** Nearest point of the path restricted to stations [sMin, sMax]; extends past the ends linearly. */
export function projectOnPath(path: PathData, p: Vec, sMin: number, sMax: number): PathProjection {
  const pts = path.pts;
  let best: PathProjection | null = null;
  const consider = (a: Vec, b: Vec, s0: number, lo: number, hi: number): void => {
    const ab = sub(b, a), l = len(ab);
    if (l < 1e-12) return;
    const dir = mul(ab, 1 / l);
    const t = Math.max(lo, Math.min(hi, dot(sub(p, a), dir)));
    const q = add(a, mul(dir, t));
    const dd = dist(p, q);
    if (!best || dd < dist(p, best.point)) {
      const right = { x: -dir.y, y: dir.x };
      best = { s: s0 + t, d: dot(sub(p, q), right), angle: Math.atan2(dir.y, dir.x), point: q };
    }
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const s0 = path.cum[i], s1 = path.cum[i + 1];
    if (s1 < sMin || s0 > sMax) continue;
    consider(pts[i], pts[i + 1], s0, Math.max(0, sMin - s0), Math.min(s1 - s0, sMax - s0));
  }
  if (sMax > path.total && pts.length >= 2) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const segLen = path.total - path.cum[pts.length - 2];
    consider(a, b, path.cum[pts.length - 2], Math.max(segLen, sMin - path.cum[pts.length - 2]), sMax - path.cum[pts.length - 2]);
  }
  if (!best) {
    const q = pathAt(path, Math.max(0, Math.min(path.total, sMin)));
    return { s: Math.max(0, Math.min(path.total, sMin)), d: 0, angle: q.a, point: q.p };
  }
  return best;
}

/**
 * Guardrail segment as a half-plane on the side of the vehicle CG, thickness
 * 2*GUARDRAIL_HALF_WIDTH: robust for any penetration depth (no tunnelling
 * through a thin box). Returns the deepest corner as the contact point.
 */
export function barrierContact(box: OBB, cg: Vec, a: Vec, b: Vec): { n: Vec; depth: number; point: Vec } | null {
  const c = Math.cos(box.a), sn = Math.sin(box.a);
  const corners = [[box.hl, box.hw], [box.hl, -box.hw], [-box.hl, box.hw], [-box.hl, -box.hw]]
    .map(([lx, ly]) => ({ x: box.cx + c * lx - sn * ly, y: box.cy + sn * lx + c * ly }));
  return halfPlaneContact(corners, cg, a, b, GUARDRAIL_HALF_WIDTH);
}

/** Deepest of the given points beyond a segment's half-plane (offset `half` towards the CG side). */
export function halfPlaneContact(points: Vec[], cg: Vec, a: Vec, b: Vec, half: number): { n: Vec; depth: number; point: Vec } | null {
  const d = sub(b, a), L = len(d);
  if (L < 1e-9) return null;
  const u = mul(d, 1 / L), m = { x: -u.y, y: u.x };
  const side = Math.sign(dot(sub(cg, a), m)) || 1;
  let best: { delta: number; point: Vec } | null = null;
  for (const p of points) {
    const along = dot(sub(p, a), u);
    if (along < 0 || along > L) continue;
    const delta = side * dot(sub(p, a), m);
    if (delta < half && (!best || delta < best.delta)) best = { delta, point: p };
  }
  if (!best) return null;
  return { n: mul(m, -side), depth: half - best.delta, point: best.point };
}

interface ThrownBody { pos: Vec; vel: Vec; thrown?: ThrowState }

/** Flight from height h with vertical launch speed |v_h|·tan(angle); horizontal speed unchanged until landing. */
function startFlight(b: ThrownBody, angle: number, h: number, friction: number): void {
  const vh = len(b.vel), vz0 = vh * Math.tan(angle), vz = Math.sqrt(vz0 * vz0 + 2 * G * h);
  b.thrown = { mode: 'flight', remaining: (vz0 + vz) / G, landingVz: vz, friction };
}

/** Exact piecewise kinematics: flight, landing impulse (−μ·|vz| horizontally), slide at μg to rest. */
function advanceThrown(b: ThrownBody, dt: number): void {
  let left = dt;
  const st = b.thrown!;
  if (st.mode === 'flight') {
    const step = Math.min(left, st.remaining);
    b.pos = add(b.pos, mul(b.vel, step));
    st.remaining -= step;
    left -= step;
    if (st.remaining > 1e-12) return;
    const sp = len(b.vel), after = sp - st.friction * st.landingVz;
    b.vel = after > 0 && sp > 0 ? mul(b.vel, after / sp) : { x: 0, y: 0 };
    b.thrown = { mode: 'slide', friction: st.friction };
  }
  const sp = len(b.vel);
  if (!sp || left <= 0) return;
  const dec = (b.thrown as { friction: number }).friction * G, tStop = sp / dec, tt = Math.min(left, tStop);
  const nsp = tt >= tStop ? 0 : sp - dec * tt, dir = mul(b.vel, 1 / sp);
  b.pos = add(b.pos, mul(dir, (sp + nsp) / 2 * tt));
  b.vel = mul(dir, nsp);
}

interface RiderState extends ThrownBody { id: string; mass: number; separatedAt: number }

interface DynRt {
  r: Rt;
  p: DynamicVehicleParameters;
  state: DynamicState;
  ctrl: ControllerSettings;
  actuator: BrakeActuator;
  hazard?: HazardResponse;
  post: PostImpactSettings;
  steer: number;
  /** CG station along the intent path and the floor set by the last reached node. */
  s: number;
  sFloor: number;
  /** Intended speed of the profile along the travel direction, m/s. */
  plan: number;
  drive: number;
  controlled: boolean;
  impactSteer: number;
  control: DynamicControl;
  surface?: ResolvedSurface;
  samples: DynamicTrackSamples;
}

function newSamples(n: number): DynamicTrackSamples {
  const f = () => new Float32Array(n), w = () => new Float32Array(4 * n);
  return { vx: f(), vy: f(), yawRate: f(), sideslip: f(), steering: f(), drive: f(), brake: f(), mu: f(),
    muKnown: new Uint8Array(n), gradeKnown: new Uint8Array(n), staticHold: new Uint8Array(n), zone: new Array(n).fill(null),
    wheelLoad: w(), wheelFx: w(), wheelFy: w(), wheelUse: w(), wheelMode: new Uint8Array(4 * n) };
}

const SCENE_SURFACE_SOURCE = (surface: string, mu: number): ParameterSource => ({
  kind: 'synthetic',
  description: `Классовое значение покрытия сцены прежней модели (env.surface=${surface}, μ=${mu}); не измерение конкретной дороги.`,
});

const IDEAL_ACTUATOR: ParameterSource = {
  kind: 'synthetic',
  description: 'Идеальный тормозной привод: t2 и t3 не заданы (extensions.physics.vehicles.*.braking), запаздывание и нарастание не моделируются.',
};

function wheelPoints(st: DynamicState, p: DynamicVehicleParameters): Vec[] {
  const c = Math.cos(st.heading), sn = Math.sin(st.heading), b = p.body;
  return ([[b.lf, -b.trackFront / 2], [b.lf, b.trackFront / 2], [-b.lr, -b.trackRear / 2], [-b.lr, b.trackRear / 2]] as const)
    .map(([x, y]) => ({ x: st.x + c * x - sn * y, y: st.y + sn * x + c * y }));
}

function roadFor(d: DynRt, st: DynamicState, zones: PhysicsZone[], fallback: { mu: number; source: ParameterSource }): DynamicRoad {
  if (!zones.length) {
    d.surface = { mu: fallback.mu, muSource: fallback.source, muKnown: false, gradeKnown: false, roughness: [] };
    return { mu: fallback.mu, source: fallback.source };
  }
  const cg = resolveSurface({ x: st.x, y: st.y }, zones, fallback);
  d.surface = cg;
  const wheelMu = wheelPoints(st, d.p).map(w => resolveSurface(w, zones, fallback).mu) as [number, number, number, number];
  return { mu: cg.mu, source: cg.muSource, ...(cg.grade ? { grade: cg.grade } : {}),
    ...(cg.muZoneId ? { zoneId: cg.muZoneId } : {}),
    ...(wheelMu.some(mu => mu !== cg.mu) ? { wheelMu } : {}) };
}

/** Controller evaluation at frame start t: progress, waypoint events, intent profile, commands. */
function controlFrame(d: DynRt, t: number): void {
  const r = d.r, st = d.state, p = d.p, c = d.ctrl, nodes = r.nodes;
  const speed = Math.hypot(st.vx, st.vy);
  const proj = projectOnPath(r.path, { x: st.x, y: st.y }, Math.max(d.sFloor, d.s - 2), d.s + Math.max(5, 2 * speed * DT + 2));
  d.s = Math.max(d.sFloor, proj.s);
  let brake = 0, drive = 0;
  if (r.hold > 0) {
    r.hold = Math.max(0, r.hold - DT);
    d.plan = 0;
    brake = 1;
  } else {
    if (r.next < nodes.length && nodes[r.next].reverse !== r.reverse && speed < 1e-6) r.reverse = nodes[r.next].reverse;
    while (r.next < nodes.length) {
      const nd = nodes[r.next];
      if (nd.V < 0.3) {
        // A stop counts as reached only at actual rest near or past it.
        if (!(speed < 0.05 && d.s >= nd.s - c.stopTolerance)) break;
        if (nd.waypointIndex !== undefined && r.waypointTimes[nd.waypointIndex] < 0) r.waypointTimes[nd.waypointIndex] = t;
        r.next++;
        d.sFloor = Math.max(d.sFloor, nd.s);
        d.s = Math.max(d.s, d.sFloor);
        r.hold = nd.hold;
        d.plan = 0;
        if (nd.hold > 0 || nd.directionStop) break;
      } else if (d.s >= nd.s) {
        if (nd.waypointIndex !== undefined && r.waypointTimes[nd.waypointIndex] < 0) r.waypointTimes[nd.waypointIndex] = t;
        r.next++;
        d.sFloor = Math.max(d.sFloor, nd.s - 1);
      } else break;
    }
    const last = nodes[nodes.length - 1];
    const vDes = r.next < nodes.length ? nodes[r.next].V : last.V;
    const before = d.plan;
    if (r.hold <= 0) {
      if (d.plan < vDes) d.plan = Math.min(vDes, d.plan + c.plannedAccel * DT);
      else if (r.next >= nodes.length && d.plan > vDes) d.plan = Math.max(vDes, d.plan - c.serviceDecel * DT);
      let allowed = Infinity;
      for (let j = r.next; j < nodes.length; j++) {
        const nd = nodes[j];
        const b = nd.V < 0.3 ? c.stopDecel : Math.min(c.stopDecel, c.serviceDecel);
        allowed = Math.min(allowed, Math.sqrt(nd.V * nd.V + 2 * b * Math.max(0, nd.s - d.s)));
      }
      if (d.plan > allowed) d.plan = allowed;
    }
    const { u } = bodyVelocity(st);
    const travel = r.reverse ? -u : u;
    let aCmd = c.speedGain * (d.plan - travel) + (d.plan - before) / DT;
    const stopNext = r.next < nodes.length && nodes[r.next].V < 0.3;
    const remaining = stopNext ? nodes[r.next].s - d.s : Infinity;
    if (stopNext && travel > 0.05) {
      // Constant-deceleration stop law a=v²/(2*remaining): brakes as needed to
      // rest at the waypoint; physical limits may still cause an overrun.
      const required = travel * travel / (2 * Math.max(remaining, 0.01));
      if (required >= 0.5 * c.stopDecel || remaining <= 0) aCmd = Math.min(aCmd, -required);
    }
    if (d.plan <= 1e-9 && travel > 0.05) aCmd = Math.min(aCmd, -c.stopDecel);
    if (r.hold > 0 || d.plan <= 1e-9 && Math.abs(travel) < 0.05 || stopNext && remaining <= c.stopTolerance && Math.abs(travel) < 0.5) brake = 1;
    else if (aCmd > 0.02 && p.drive.maxForce > 0) drive = (r.reverse ? -1 : 1) * Math.min(1, p.body.mass * aCmd / p.drive.maxForce);
    else if (aCmd < -0.02 && p.brakes.maxForce > 0) brake = Math.min(1, p.body.mass * -aCmd / p.brakes.maxForce);
  }
  const hazardActive = !!d.hazard && t >= d.hazard.at + d.hazard.reaction - 1e-9;
  if (hazardActive) {
    drive = 0;
    brake = p.brakes.maxForce > 0 ? Math.min(1, p.body.mass * d.hazard!.deceleration / p.brakes.maxForce) : 0;
  }
  // Steering from the geometric intent only; never a correction of the pose.
  const fwd = fromAngle(st.heading), L = p.body.lf + p.body.lr;
  let target: number;
  if (c.method === 'stanley' && !r.reverse) {
    const front = add({ x: st.x, y: st.y }, mul(fwd, p.body.lf));
    const pf = projectOnPath(r.path, front, Math.max(d.sFloor, d.s - 2), d.s + p.body.lf + Math.max(5, 2 * speed * DT + 2));
    target = stanleySteer(st.heading, pf.angle, pf.d, speed, c.stanleyGain, c.stanleySoftening).steering;
  } else {
    const rear = sub({ x: st.x, y: st.y }, mul(fwd, p.body.lr));
    target = purePursuitSteer(rear, st.heading, pathAt(r.path, d.s + lookahead(c, speed)).p, L, r.reverse).steering;
  }
  if (hazardActive && d.hazard!.steering === 'hold') target = d.steer;
  d.steer = limitSteer(d.steer, target, c, DT);
  d.actuator.command(t, brake);
  d.drive = drive;
}

function substepControl(d: DynRt, time: number): DynamicControl {
  if (!d.controlled) {
    const w = d.post.wheels;
    return { steering: d.post.steering ?? d.impactSteer, drive: 0, brake: 0,
      ...(w === 'free' ? {} : { wheelLock: w === 'locked' ? [true, true, true, true] : [...w] as [boolean, boolean, boolean, boolean] }) };
  }
  const brake = d.actuator.applied(time);
  return { steering: d.steer, drive: brake > 0 ? 0 : d.drive, brake };
}

function simulateDynamic(scene: Scene, options: SimulationOptions): Timeline {
  scene.actors.forEach(validateSimParameters);
  const methods: Record<string, ActorMotionMethod> = {};
  const issues: PhysicsIssue[] = [];
  for (const a of scene.actors) {
    const m = dynamicMotionMethod(a);
    if (typeof m === 'string') methods[a.id] = m;
    else issues.push(m);
  }
  const ids = new Set(scene.actors.map(a => a.id));
  for (const id of Object.keys(options.vehicles ?? {})) {
    if (!ids.has(id)) issues.push({ actorId: id, code: 'invalid-input', message: 'параметры заданы для отсутствующего участника' });
    else if (methods[id] && methods[id] !== 'dynamic-four-wheel') issues.push({ actorId: id, code: 'invalid-input', message: `параметры динамики ТС не применимы к модели ${methods[id]}` });
  }
  for (const [id, v] of Object.entries(options.vulnerable ?? {})) {
    const m = methods[id];
    if (!ids.has(id)) issues.push({ actorId: id, code: 'invalid-input', message: 'параметры заданы для отсутствующего участника' });
    else if (v.throw && m !== 'pedestrian-kinematic') issues.push({ actorId: id, code: 'invalid-input', message: 'модель отброса применима только к пешеходу' });
    else if (v.twoWheeler && m !== 'two-wheeler-or-sim-kinematic') issues.push({ actorId: id, code: 'invalid-input', message: 'модель падения применима только к двухколёсному/СИМ' });
    else {
      try {
        validateVulnerable(v);
        const total = actorSpec(scene.actors.find(a => a.id === id)!).mass;
        if (v.twoWheeler && v.twoWheeler.riderMass >= total) issues.push({ actorId: id, code: 'invalid-input', message: `масса ездока ${v.twoWheeler.riderMass} кг не меньше общей массы ${total} кг` });
      } catch (error) { issues.push({ actorId: id, code: 'invalid-input', message: error instanceof Error ? error.message : String(error) }); }
    }
  }
  if (issues.length) throw new PhysicsUnsupportedError(issues);
  const zones = options.zones ?? [];
  validateZones(zones);
  const impact: ImpactSettings = options.impact ?? { restitution: 0.12, source: { kind: 'synthetic',
    description: 'Значение по умолчанию прежней кинематической модели (k=0,12); не измерено для данного столкновения.' } };
  validateImpact(impact);
  const dt = options.substepSeconds ?? DYNAMIC_SUBSTEP;
  const count = Math.round(DYNAMIC_FRAME_DT / dt);
  if (!(dt >= 0.0001 && dt <= DYNAMIC_SUBSTEP) || Math.abs(count * dt - DYNAMIC_FRAME_DT) > 1e-12) throw new Error('Динамика: подшаг должен делить 25 мс без остатка и быть ≤5 мс');

  const geo = buildGeo(scene);
  const mu = SURFACES[scene.env.surface].mu;
  const fallback = { mu, source: SCENE_SURFACE_SOURCE(scene.env.surface, mu) };
  const duration = Math.max(1, scene.env.duration);
  const n = Math.floor(duration / DT) + 1;
  const rts = scene.actors.map((a) => makeRuntime(a, mu, geo.tracks.filter(t => a.railwayTrain
    ? t.item.kind === 'railway' && (!a.railwayTrain.trackId || t.item.id === a.railwayTrain.trackId)
    : t.item.kind !== 'railway').map(t => t.pts)));
  const assumptions: string[] = [];
  const dyn = new Map<string, DynRt>();
  for (const r of rts) {
    if (methods[r.a.id] !== 'dynamic-four-wheel') continue;
    const a = r.a, p = structuredClone(a.dynamics!);
    validateDynamicParameters(p);
    const input = options.vehicles?.[a.id] ?? {};
    validateBraking(input.braking);
    const vs = VEHICLES[a.type as VehicleType];
    const ctrl: ControllerSettings = { ...defaultController({ accel: (vs.accel * vs.mass) / dimsOf(a).mass, serviceDecel: SERVICE_DECEL, stopDecel: r.plan }), ...(input.controller ?? {}) };
    if (!input.controller?.source && (input.controller?.plannedAccel === undefined || input.controller?.stopDecel === undefined)) {
      assumptions.push(`${a.id}: плановые ускорение ${ctrl.plannedAccel.toFixed(2)} и замедления ${ctrl.serviceDecel.toFixed(2)}/${ctrl.stopDecel.toFixed(2)} м/с² — профиль намерения из классовых значений прежней модели, не параметры водителя.`);
    }
    validateController(ctrl);
    const t2 = input.braking?.t2?.value, t3 = input.braking?.t3?.value;
    const timing: BrakeTiming = t2 === undefined && t3 === undefined ? { lag: 0, rise: 0, source: IDEAL_ACTUATOR }
      : { lag: t2 ?? 0, rise: t3 ?? 0, source: { kind: 'reference', description: `t2/t3 из extensions.physics (вид источника не указан автором): ${[input.braking?.t2?.source, input.braking?.t3?.source].filter(Boolean).join('; ')}` } };
    if (t2 === undefined || t3 === undefined) assumptions.push(`${a.id}: ${t2 === undefined ? 't2' : ''}${t2 === undefined && t3 === undefined ? ' и ' : ''}${t3 === undefined ? 't3' : ''} не заданы — принят идеальный привод по отсутствующей величине (0 с).`);
    if (input.hazard) validateHazard(input.hazard);
    validatePostImpact(input.postImpact);
    const post = input.postImpact ?? { wheels: 'free' as const, source: DEFAULT_POST_IMPACT_SOURCE };
    if (!input.postImpact) assumptions.push(`${a.id}: после удара — свободное качение без управления (допущение по умолчанию).`);
    const state = initialDynamicState(a);
    dyn.set(a.id, { r, p, state, ctrl, actuator: new BrakeActuator(timing), hazard: input.hazard, post, steer: 0, s: 0, sFloor: 0,
      plan: Math.abs(a.speed) / 3.6, drive: 0, controlled: true, impactSteer: 0,
      control: { steering: 0, drive: 0, brake: 0 }, samples: newSamples(n) });
    r.pos = { x: state.x, y: state.y };
    r.h = state.heading;
    const d = dyn.get(a.id)!;
    roadFor(d, state, zones, fallback);
  }
  if (!zones.length) assumptions.push(`Зоны не заданы: μ=${mu} — классовое значение покрытия сцены, уклон не задан (горизонтальная плоскость — допущение).`);
  else {
    assumptions.push(`Вне измеренных зон: μ=${mu} — классовое значение покрытия сцены; где уклон не задан — горизонтальная плоскость (допущение).`);
    if (zones.some(z => z.roughness)) assumptions.push('Неровность в зонах сохранена как наблюдение; её влияние на силы не рассчитано (нет подтверждённой модели передачи), множитель μ не подставлялся.');
  }
  for (const [id, m] of Object.entries(methods)) if (m !== 'dynamic-four-wheel') {
    assumptions.push(`${id}: собственная модель ${m} (кинематическое следование траектории прежнего симулятора), не динамика сил.`);
  }

  const tracks = new Map<string, Track>();
  for (const r of rts) {
    const d = dyn.get(r.a.id);
    tracks.set(r.a.id, { id: r.a.id, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n), v: new Float32Array(n),
      present: new Uint8Array(n), free: new Uint8Array(n), reversing: new Uint8Array(n), waypointTimes: r.waypointTimes,
      ...(d ? { dynamics: d.samples } : {}) });
  }
  const collisions: Collision[] = [];
  /** Legacy first-contact suppression, used only for pairs of kinematic actors. */
  const contacts = new Set<string>();
  /** Contact episodes of pairs involving a dynamic body: a new impact needs prior separation. */
  const episodes = new Map<string, { inContact: boolean; record?: Collision; sequence: number }>();
  const barriers = options.barriers ?? [];
  barriers.forEach(validateBarrier);
  const guardSegments = barriers.filter(b => b.kind === 'guardrail').flatMap(item => item.points.slice(1).map((q, i) => ({ item, a: item.points[i], b: q })));
  const curbSegments = barriers.filter(b => b.kind === 'curb').flatMap(item => item.points.slice(1).map((q, i) => ({ item, a: item.points[i], b: q })));
  const vulnerable: ImpactSettings = options.vulnerableImpact ?? { restitution: 0, source: { kind: 'synthetic',
    description: 'Допущение пластического контакта с пешеходом/двухколёсным (общая скорость точки удара), как в формуле Wood (1988) по Soica (2018); не измерение.' } };
  validateImpact(vulnerable);
  if (barriers.length) assumptions.push('Отбойник — жёсткая тонкая преграда (геометрия 0,2 м); бордюр действует только на точки контакта колёс, наезд на бордюр не моделируется.');
  const kinPrev = new Map<string, { pos: Vec; h: number }>();
  const riders = new Map<string, RiderState>();
  const riderTracks = new Map<string, { x: Float32Array; y: Float32Array; v: Float32Array; present: Uint8Array }>();
  for (const [id, v] of Object.entries(options.vulnerable ?? {})) {
    if (v.twoWheeler) riderTracks.set(id, { x: new Float32Array(n), y: new Float32Array(n), v: new Float32Array(n), present: new Uint8Array(n) });
    if (v.throw) assumptions.push(`${id}: после контакта — накат не моделируется во времени; полёт с высоты ${v.throw.launchHeight} м под углом ${(v.throw.launchAngle * 180 / Math.PI).toFixed(1)}°, затем скольжение μ=${v.throw.friction} (входные допущения с источником).`);
    if (v.twoWheeler) assumptions.push(`${id}: двухколёсное падает при ударе и скользит с μ=${v.twoWheeler.vehicleFriction}; ездок (${v.twoWheeler.riderMass} кг) отделяется со скоростью ${v.twoWheeler.riderSeparation === 'pre-impact-velocity' ? 'до удара' : 'после удара'} при сохранении общего импульса.`);
  }
  for (const r of rts) if (!dyn.has(r.a.id) && r.a.kind === 'pedestrian' && !options.vulnerable?.[r.a.id]?.throw) {
    assumptions.push(`${r.a.id}: после удара — прежняя модель свободного движения пешехода (замедление 4 м/с²), фазы отброса не заданы.`);
  }
  const kinPose = (r: Rt, f: number): { pos: Vec; h: number } => {
    const p0 = kinPrev.get(r.a.id) ?? { pos: r.pos, h: r.h };
    return { pos: add(p0.pos, mul(sub(r.pos, p0.pos), f)), h: p0.h + f * wrapAngle(r.h - p0.h) };
  };
  const boxAtF = (r: Rt, f: number): OBB => {
    const d = dyn.get(r.a.id);
    if (d) return { cx: d.state.x + Math.cos(d.state.heading) * r.shift, cy: d.state.y + Math.sin(d.state.heading) * r.shift, hl: r.box.hl, hw: r.box.hw, a: d.state.heading };
    const q = kinPose(r, f);
    return { cx: q.pos.x + Math.cos(q.h) * r.shift, cy: q.pos.y + Math.sin(q.h) * r.shift, hl: r.box.hl, hw: r.box.hw, a: q.h };
  };
  const velocityAt = (r: Rt): Vec => {
    const d = dyn.get(r.a.id);
    return d ? { x: d.state.vx, y: d.state.vy } : velocityOf(r);
  };
  const bodyOf = (r: Rt, f: number): ImpactBody => {
    const d = dyn.get(r.a.id);
    if (d) return { mass: d.p.body.mass, yawInertia: d.p.body.yawInertia, position: { x: d.state.x, y: d.state.y },
      velocity: { x: d.state.vx, y: d.state.vy }, yawRate: d.state.yawRate, heading: d.state.heading };
    const q = kinPose(r, f), fixed = r.rail && r.mode === 'path';
    // Kinematic participants are particles (no modelled rotation); a tram on rails is held by them.
    return { mass: fixed ? Infinity : r.mass, yawInertia: Infinity, position: q.pos, velocity: velocityOf(r), yawRate: 0, heading: q.h };
  };
  const settingsFor = (A: Rt, B: Rt | null): ImpactSettings => {
    if (B && !dyn.has(B.a.id) || !dyn.has(A.a.id)) return vulnerable;
    const oa = options.vehicles?.[A.a.id]?.impact, ob = B ? options.vehicles?.[B.a.id]?.impact : undefined;
    if (oa && ob && JSON.stringify(oa) !== JSON.stringify(ob)) {
      throw new PhysicsUnsupportedError([{ actorId: `${A.a.id}|${B!.a.id}`, code: 'invalid-input', message: 'разные параметры удара у участников пары' }]);
    }
    const o = oa ?? ob;
    const merged = o ? { ...impact, ...o, source: o.source ?? impact.source } as ImpactSettings : impact;
    validateImpact(merged);
    return merged;
  };

  for (let k = 0; k < n; k++) {
    const t = k * DT;
    const integrating = new Set<DynRt>();
    for (const r of rts) {
      const d = dyn.get(r.a.id);
      const wasPresent = r.present;
      if (!r.present && t >= r.a.delay - 1e-9) r.present = true;
      if (!r.present) continue;
      if (d) {
        if (k === 0 || !wasPresent) continue;
        integrating.add(d);
        if (d.controlled) controlFrame(d, t - DT);
        continue;
      }
      kinPrev.set(r.a.id, { pos: { ...r.pos }, h: r.h });
      if (r.mode === 'path') {
        if (k > 0 || r.a.delay > 0) stepPath(r, DT, t);
      } else if (r.thrown) {
        advanceThrown(r, DT);
      } else {
        const sp = len(r.vel);
        if (sp > 0) {
          const dec = r.a.kind === 'pedestrian' ? 4 : mu * G;
          const nsp = Math.max(0, sp - dec * DT);
          r.vel = mul(r.vel, nsp / sp);
          r.pos = add(r.pos, mul(r.vel, DT));
          if (nsp < 0.02) r.vel = { x: 0, y: 0 };
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const ts = t - DT + i * dt, f = (i + 1) / count;
      for (const d of integrating) {
        const control = substepControl(d, ts);
        const road = roadFor(d, d.state, zones, fallback);
        const res = integrateSubstep(d.state, d.p, control, road, dt);
        d.state = res.state;
        d.control = control;
        if (i === count - 1) recordForces(d, k, res.forces, res.staticHold);
      }
      const touched = new Set<string>();
      for (let a = 0; a < rts.length; a++) {
        const A = rts[a];
        if (!A.present) continue;
        const dA = dyn.get(A.a.id);
        for (let b = a + 1; b < rts.length; b++) {
          const B = rts[b];
          if (!B.present || !dA && !dyn.has(B.a.id)) continue;
          // A fallen pedestrian is run over, not struck again: no planar impulse (limitation).
          if (A.a.kind === 'pedestrian' && A.down || B.a.kind === 'pedestrian' && B.down) continue;
          // Minimum-overlap axis: with substeps of at most 5 ms overlaps stay shallow,
          // so the legacy time-of-impact heuristic for deep 25 ms overlaps is not used.
          const c = obbContact(boxAtF(A, f), boxAtF(B, f));
          if (c) contactImpulse(A, B, c, `${A.a.id}|${B.a.id}`, ts + dt, k, f, touched);
        }
        if (!dA) continue;
        for (const og of geo.obstacles) {
          const c = obbContact(boxAtF(A, f), og.box);
          if (c) contactImpulse(A, null, c, `${A.a.id}|${og.item.id}`, ts + dt, k, f, touched, { id: og.item.id, target: 'obstacle', settings: settingsFor(A, null), position: { x: og.box.cx, y: og.box.cy } });
        }
        for (const g of guardSegments) {
          const c = barrierContact(boxAtF(A, f), { x: dA.state.x, y: dA.state.y }, g.a, g.b);
          if (c) contactImpulse(A, null, c, `${A.a.id}|${g.item.id}`, ts + dt, k, f, touched, { id: g.item.id, target: 'guardrail',
            settings: { restitution: g.item.restitution, contactFriction: g.item.contactFriction, source: g.item.source }, position: c.point });
        }
        if (curbSegments.length) {
          const wheels = wheelPoints(dA.state, dA.p), cg = { x: dA.state.x, y: dA.state.y };
          for (const seg of curbSegments) {
            const c = halfPlaneContact(wheels, cg, seg.a, seg.b, 0);
            if (c) contactImpulse(A, null, c, `${A.a.id}|${seg.item.id}`, ts + dt, k, f, touched, { id: seg.item.id, target: 'curb',
              settings: { restitution: seg.item.restitution, contactFriction: seg.item.contactFriction, source: seg.item.source }, position: c.point });
          }
        }
      }
      for (const [key, ep] of episodes) if (!touched.has(key)) { ep.inContact = false; ep.record = undefined; }
    }
    // Pairs of kinematic actors keep the legacy translational contact of their own model.
    for (let a = 0; a < rts.length; a++) {
      const A = rts[a];
      if (!A.present || dyn.has(A.a.id)) continue;
      for (let b = a + 1; b < rts.length; b++) {
        const B = rts[b];
        if (!B.present || dyn.has(B.a.id) || A.a.kind === 'pedestrian' && B.a.kind === 'pedestrian') continue;
        const c = obbContact(boxOf(A), boxOf(B), sub(velocityOf(A), velocityOf(B)));
        if (c) kinematicContact(A, B, c, `${A.a.id}|${B.a.id}`, k);
      }
      for (const og of geo.obstacles) {
        const c = obbContact(boxOf(A), og.box, velocityOf(A));
        if (c) kinematicContact(A, null, c, `${A.a.id}|${og.item.id}`, k, og.item.id);
      }
    }
    for (const [id, rt] of riderTracks) {
      const rider = riders.get(id), r = rts.find(x => x.a.id === id)!;
      if (rider && rider.separatedAt < k) advanceThrown(rider, DT);
      const q = rider ?? { pos: r.pos, vel: { x: 0, y: 0 } };
      rt.x[k] = q.pos.x; rt.y[k] = q.pos.y; rt.v[k] = len(q.vel); rt.present[k] = rider ? 1 : 0;
    }
    for (const r of rts) {
      const tr = tracks.get(r.a.id)!, d = dyn.get(r.a.id);
      if (d) { r.pos = { x: d.state.x, y: d.state.y }; r.h = d.state.heading; }
      tr.x[k] = r.pos.x;
      tr.y[k] = r.pos.y;
      tr.h[k] = r.h;
      tr.present[k] = r.present ? 1 : 0;
      if (d) {
        const { u, v } = bodyVelocity(d.state);
        tr.v[k] = Math.hypot(d.state.vx, d.state.vy);
        tr.free[k] = d.controlled ? 0 : 1;
        tr.reversing![k] = r.present && u < -1e-6 ? 1 : 0;
        const sm = d.samples;
        sm.vx[k] = d.state.vx; sm.vy[k] = d.state.vy; sm.yawRate[k] = d.state.yawRate;
        sm.sideslip[k] = Math.hypot(u, v) > 1e-6 ? Math.atan2(v, Math.abs(u)) : 0;
        sm.steering[k] = d.control.steering; sm.drive[k] = d.control.drive; sm.brake[k] = d.control.brake;
        sm.mu[k] = d.surface?.mu ?? mu; sm.muKnown[k] = d.surface?.muKnown ? 1 : 0; sm.gradeKnown[k] = d.surface?.gradeKnown ? 1 : 0;
        sm.zone[k] = d.surface?.muZoneId ?? null;
      } else {
        tr.v[k] = r.mode === 'free' ? len(r.vel) : r.v;
        tr.free[k] = r.mode === 'free' ? 1 : 0;
        tr.reversing![k] = r.present && (r.mode === 'path' ? r.reverse : dot(r.vel, fromAngle(r.h)) < -1e-6) ? 1 : 0;
      }
    }
  }

  /**
   * Planar impulse at a detected overlap (stage 08). A pair registers a new
   * impact only after separating; impulses during one contact episode are
   * accumulated into the same record. Position projection is numerical.
   */
  function contactImpulse(A: Rt, B: Rt | null, c: { n: Vec; depth: number; point: Vec }, key: string, time: number, k: number, f: number,
    touched: Set<string>, fixed?: { id: string; target: ImpactRecord['target']; settings: ImpactSettings; position: Vec }): void {
    touched.add(key);
    const ep = episodes.get(key) ?? { inContact: false, sequence: 0 };
    episodes.set(key, ep);
    const bodyA = bodyOf(A, f);
    const bodyB: ImpactBody = B ? bodyOf(B, f) : { mass: Infinity, yawInertia: Infinity, position: fixed!.position, velocity: { x: 0, y: 0 }, yawRate: 0 };
    const settings = fixed ? fixed.settings : settingsFor(A, B);
    // Approach test before any state change (legacy hit() may derail a tram).
    let res = planarImpact({ a: bodyA, b: bodyB, point: c.point, normal: c.n, restitution: settings.restitution, contactFriction: settings.contactFriction });
    if (res.mode !== 'separating') {
      const fresh = !ep.inContact || !ep.record;
      const preA = velocityAt(A), preB = B ? velocityAt(B) : { x: 0, y: 0 };
      if (fresh) for (const r of B ? [A, B] : [A]) {
        const d = dyn.get(r.a.id);
        if (d) { if (d.controlled) { d.controlled = false; d.impactSteer = d.steer; } r.mode = 'free'; }
        else {
          const q = kinPose(r, f);
          hit(r, res.approachSpeed);
          if (r.mode === 'free') { r.pos = q.pos; r.h = q.h; kinPrev.set(r.a.id, { pos: { ...q.pos }, h: q.h }); }
        }
      }
      // Recompute after a possible derailment changed the constraint of a tram.
      if (fresh) res = planarImpact({ a: bodyOf(A, f), b: B ? bodyOf(B, f) : bodyB, point: c.point, normal: c.n, restitution: settings.restitution, contactFriction: settings.contactFriction });
      applyImpact(A, res.a, f);
      if (B) applyImpact(B, res.b, f);
      if (fresh) for (const [r, pre] of (B ? [[A, preA], [B, preB]] : [[A, preA]]) as [Rt, Vec][]) startPostImpact(r, pre, k, f);
      if (A.a.kind === 'pedestrian') A.down = true;
      if (B?.a.kind === 'pedestrian') B.down = true;
      if (fresh) {
        ep.sequence++;
        const target: ImpactRecord['target'] = fixed ? fixed.target : B!.a.kind === 'pedestrian' ? 'pedestrian' : dyn.has(B!.a.id) ? 'vehicle' : 'kinematic-vehicle';
        const record: Collision = { idx: collisions.length, t: time, frame: k, a: A.a.id, b: B ? B.a.id : fixed!.id,
          kind: !B ? 'vo' : A.a.kind === 'pedestrian' || B.a.kind === 'pedestrian' ? 'vp' : 'vv',
          point: c.point, n: c.n, vA: preA, vB: preB, rel: Math.max(0, res.approachSpeed), dvA: 0, dvB: 0,
          impact: { method: res.method, target, sequence: ep.sequence, restitution: settings.restitution, contactFriction: settings.contactFriction,
            settingsSource: structuredClone(settings.source), mode: res.mode === 'sliding' ? 'sliding' : 'full', impulses: 0, impulse: { x: 0, y: 0 }, deltaVA: { x: 0, y: 0 }, deltaVB: { x: 0, y: 0 },
            deltaYawRateA: 0, deltaYawRateB: 0, energyLoss: 0, energyNormal: 0, energyTangential: 0, energyIncrease: false,
            pdofA: res.a.pdofDeg, clockA: res.a.clock, pdofB: res.b.pdofDeg, clockB: res.b.clock, first: res } };
        collisions.push(record);
        ep.record = record;
      }
      const rec = ep.record!, im = rec.impact!;
      im.impulses++;
      im.impulse = add(im.impulse, res.impulse);
      im.deltaVA = add(im.deltaVA, res.a.deltaV); im.deltaVB = add(im.deltaVB, res.b.deltaV);
      im.deltaYawRateA += res.a.deltaYawRate; im.deltaYawRateB += res.b.deltaYawRate;
      im.energyLoss += res.energyLoss; im.energyNormal += res.energyNormal; im.energyTangential += res.energyTangential;
      im.energyIncrease ||= res.energyIncrease;
      if (res.mode === 'sliding') im.mode = 'sliding';
      rec.dvA = len(im.deltaVA); rec.dvB = len(im.deltaVB);
    }
    ep.inContact = true;
    // Separate overlapping bodies by inverse mass (numerical projection, not physics).
    const wA = Number.isFinite(bodyA.mass) ? 1 / bodyA.mass : 0, wB = Number.isFinite(bodyB.mass) ? 1 / bodyB.mass : 0;
    const tot = wA + wB;
    if (tot > 0 && c.depth > 0) {
      movePos(A, mul(c.n, -(c.depth * wA) / tot));
      if (B) movePos(B, mul(c.n, (c.depth * wB) / tot));
    }
  }

  /** Stage 09: explicit post-impact phases for a pedestrian (flight/slide) or a two-wheeler (fall, rider). */
  function startPostImpact(r: Rt, pre: Vec, k: number, f: number): void {
    if (dyn.has(r.a.id) || r.rail && r.mode === 'path') return;
    const input = options.vulnerable?.[r.a.id];
    if (!input) return;
    if (input.throw && !r.thrown) {
      // The frame remainder after the impact is replayed with the flight model.
      const q = kinPose(r, f);
      r.pos = q.pos;
      startFlight(r, input.throw.launchAngle, input.throw.launchHeight, input.throw.friction);
      advanceThrown(r, (1 - f) * DT);
      kinPrev.set(r.a.id, { pos: q.pos, h: q.h });
    }
    if (input.twoWheeler && !riders.has(r.a.id)) {
      const tw = input.twoWheeler, m = r.mass, mr = tw.riderMass;
      const q = kinPose(r, f);
      const vr = tw.riderSeparation === 'pre-impact-velocity' ? { ...pre } : { ...r.vel };
      const vv = mul(sub(mul(r.vel, m), mul(vr, mr)), 1 / (m - mr));
      const rider: RiderState = { id: `${r.a.id}:rider`, mass: mr, pos: { ...q.pos }, vel: vr, separatedAt: k };
      startFlight(rider, 0, tw.riderLaunchHeight, tw.riderFriction);
      advanceThrown(rider, (1 - f) * DT);
      riders.set(r.a.id, rider);
      r.vel = vv;
      r.pos = q.pos;
      r.thrown = { mode: 'slide', friction: tw.vehicleFriction };
      advanceThrown(r, (1 - f) * DT);
      kinPrev.set(r.a.id, { pos: q.pos, h: q.h });
    }
  }

  function applyImpact(r: Rt, out: { deltaV: Vec; deltaYawRate: number; velocity: Vec }, f: number): void {
    const d = dyn.get(r.a.id);
    if (d) { d.state = { ...d.state, vx: d.state.vx + out.deltaV.x, vy: d.state.vy + out.deltaV.y, yawRate: d.state.yawRate + out.deltaYawRate }; return; }
    if (r.rail && r.mode === 'path') return;
    r.vel = { ...out.velocity };
    // Continue the frame from the impact pose with the new velocity (interpolation stays linear).
    const q = kinPose(r, f);
    kinPrev.set(r.a.id, { pos: sub(q.pos, mul(r.vel, f * DT)), h: q.h });
    r.pos = add(q.pos, mul(r.vel, (1 - f) * DT));
  }

  function kinematicContact(A: Rt, B: Rt | null, c: { n: Vec; depth: number; point: Vec }, key: string, k: number, obstacleId?: string): void {
    const invA = 1 / A.mass, invB = B ? 1 / B.mass : 0;
    if (!contacts.has(key)) {
      contacts.add(key);
      const vA = velocityOf(A), vB = B ? velocityOf(B) : { x: 0, y: 0 };
      const rel = dot(sub(vA, vB), c.n);
      for (const r of B ? [A, B] : [A]) hit(r, rel);
      const railA = A.rail && A.mode === 'path', railB = !!B && B.rail && B.mode === 'path';
      let dvA = 0, dvB = 0;
      if (rel > 0) {
        const e = 0.12;
        const j = ((1 + e) * rel) / (invA + invB);
        if (!railA) A.vel = sub(A.vel, mul(c.n, j * invA));
        if (B && !railB) B.vel = add(B.vel, mul(c.n, j * invB));
        dvA = j * invA;
        dvB = j * invB;
      }
      if (A.a.kind === 'pedestrian') A.down = true;
      if (B?.a.kind === 'pedestrian') B.down = true;
      collisions.push({ idx: collisions.length, t: k * DT, frame: k, a: A.a.id, b: B ? B.a.id : obstacleId!,
        kind: !B ? 'vo' : A.a.kind === 'pedestrian' || B.a.kind === 'pedestrian' ? 'vp' : 'vv',
        point: c.point, n: c.n, vA, vB, rel: Math.max(0, rel), dvA, dvB });
    }
    const wA = A.rail && A.mode === 'path' ? 0 : invA;
    const wB = B && B.rail && B.mode === 'path' ? 0 : invB;
    const tot = wA + wB;
    if (tot > 0) {
      A.pos = sub(A.pos, mul(c.n, (c.depth * wA) / tot));
      if (B) B.pos = add(B.pos, mul(c.n, (c.depth * wB) / tot));
    }
  }

  function movePos(r: Rt, dp: Vec): void {
    const d = dyn.get(r.a.id);
    if (d) { d.state = { ...d.state, x: d.state.x + dp.x, y: d.state.y + dp.y }; return; }
    r.pos = add(r.pos, dp);
    const p0 = kinPrev.get(r.a.id);
    if (p0) kinPrev.set(r.a.id, { pos: add(p0.pos, dp), h: p0.h });
  }
  function recordForces(d: DynRt, k: number, f: { wheels: { normalLoad: number; fx: number; fy: number; ellipseUse: number; mode: string }[] }, held: boolean): void {
    const sm = d.samples;
    f.wheels.forEach((w, i) => {
      sm.wheelLoad[4 * k + i] = w.normalLoad; sm.wheelFx[4 * k + i] = w.fx; sm.wheelFy[4 * k + i] = w.fy;
      sm.wheelUse[4 * k + i] = w.ellipseUse; sm.wheelMode[4 * k + i] = w.mode === 'locked' ? 1 : w.mode === 'unloaded' ? 2 : 0;
    });
    sm.staticHold[k] = held ? 1 : 0;
  }

  const rest: Record<string, RestPose> = {};
  for (const r of rts) {
    const d = dyn.get(r.a.id);
    rest[r.a.id] = d ? { x: d.state.x, y: d.state.y, heading: d.state.heading, atRest: !d.state.vx && !d.state.vy && !d.state.yawRate }
      : { x: r.pos.x, y: r.pos.y, heading: r.h, atRest: r.mode === 'free' ? !len(r.vel) : r.v === 0 };
  }
  const record = <T>(pick: (d: DynRt) => T): Record<string, T> => Object.fromEntries([...dyn].map(([id, d]) => [id, pick(d)]));
  return { dt: DT, n, duration, mu, tracks, collisions, physics: {
    mode: 'dynamic', methods, substepSeconds: dt,
    controllers: record(d => structuredClone(d.ctrl)), brakeTiming: record(d => structuredClone(d.actuator.timing)),
    hazards: Object.fromEntries([...dyn].filter(([, d]) => d.hazard).map(([id, d]) => [id, structuredClone(d.hazard!)])),
    postImpact: record(d => structuredClone(d.post)), impact: structuredClone(impact), vulnerableImpact: structuredClone(vulnerable),
    zones: structuredClone(zones), barriers: structuredClone(barriers), rest,
    vulnerable: structuredClone(options.vulnerable ?? {}),
    riders: Object.fromEntries([...riderTracks].map(([id, rt]) => [id, { ...rt, mass: options.vulnerable![id].twoWheeler!.riderMass,
      separation: options.vulnerable![id].twoWheeler!.riderSeparation, rest: riders.get(id) ? { x: riders.get(id)!.pos.x, y: riders.get(id)!.pos.y, atRest: !len(riders.get(id)!.vel) } : null }])),
    assumptions, limitations: [...DYNAMICS_LIMITATIONS,
      'Удар: мгновенный импульс твёрдых тел в точке перекрытия контуров (обнаружение на каждом подшаге); деформация кузова — только энергетический итог; раздвижение тел — численная проекция.',
      'Пешеходы, двухколёсные и рельсовые в ударе — частицы без вращения; трамвай на рельсах — с заданным движением (бесконечная масса) до схода.',
      'Переезд/наезд на упавшего пешехода не моделируется: после первого удара пешеход не участвует в импульсных контактах с ТС.',
      'Регулятор (pure pursuit/Stanley и P-контур скорости) — численная настройка, не модель конкретного водителя; реакция на опасность только по явно заданному моменту.',
      'Тяга без запаздывания двигателя/трансмиссии; тормоз — чистая задержка t2 и линейное нарастание t3.'] } };
}

/** Нужные для разбора характеристики участника на кадре. */
export function stateAt(tl: Timeline, id: string, k: number): { p: Vec; h: number; v: number; present: boolean; free: boolean } {
  const tr = tl.tracks.get(id)!;
  return { p: { x: tr.x[k], y: tr.y[k] }, h: tr.h[k], v: tr.v[k], present: !!tr.present[k], free: !!tr.free[k] };
}
