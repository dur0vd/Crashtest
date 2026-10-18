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
} from './geom';
import { type Actor, type Scene, type VehicleType, SURFACES, VEHICLES, dimsOf } from './scene';

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
  /** скорость, м/с */
  v: Float32Array;
  /** участник находится на сцене */
  present: Uint8Array;
  /** после столкновения движется по инерции */
  free: Uint8Array;
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
}

export interface Timeline {
  dt: number;
  n: number;
  duration: number;
  mu: number;
  tracks: Map<string, Track>;
  collisions: Collision[];
}

interface Node {
  s: number;
  V: number;
  hold: number;
}

interface Rt {
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
  if (ctrl.length === 1) ctrl.push(add(start, mul(fromAngle(a.heading), 2000)));
  const onRail = a.kind === 'vehicle' && VEHICLES[a.type as VehicleType].rail;
  const rp = onRail ? railPath(a, tracks) : null;
  const path = rp ? rp.path : buildPath(ctrl, true);
  const nodes: Node[] = [{ s: 0, V: ms(a.speed), hold: 0 }];
  a.path.forEach((w, i) => nodes.push({ s: path.nodeS[i + 1], V: ms(Math.max(0, w.v)), hold: w.hold ?? 0 }));
  let accel = 2;
  let brake = 3;
  let plan = 3;
  if (a.kind === 'vehicle') {
    const vs = VEHICLES[a.type as VehicleType];
    // гружёный автомобиль разгоняется медленнее
    accel = (vs.accel * vs.mass) / spec.mass;
    brake = Math.min(vs.brakeCap ?? Infinity, mu * G * vs.brakeFactor);
    plan = Math.min(vs.brakeCap ?? Infinity, SURFACES.dry.mu * G * vs.brakeFactor);
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
    h: p0.a,
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
  };
}

function boxOf(r: Rt): OBB {
  return { cx: r.pos.x + Math.cos(r.h) * r.shift, cy: r.pos.y + Math.sin(r.h) * r.shift, hl: r.box.hl, hw: r.box.hw, a: r.h };
}

function stepPath(r: Rt, dt: number): void {
  const nodes = r.nodes;
  if (r.hold > 0) {
    r.hold -= dt;
    r.v = 0;
    return;
  }
  // достигнутые узлы
  while (r.next < nodes.length) {
    const nd = nodes[r.next];
    const left = nd.s - r.s;
    if (nd.V < 0.3 && left <= Math.max(0.03, r.v * dt) && r.v < 1.0) {
      r.s = nd.s;
      r.v = 0;
      r.hold = nd.hold;
      r.next++;
      if (nd.hold > 0) return;
      continue;
    }
    if (left <= 0) r.next++;
    else break;
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
  r.s += r.v * dt;
  const p = pathAt(r.path, r.s);
  r.pos = p.p;
  r.h = p.a;
}

/** Реакция на удар: обычное ТС и пешеход слетают с траектории, трамвай остаётся на рельсах и тормозит. */
function hit(r: Rt, rel: number): void {
  if (!r.rail || r.mode !== 'path') {
    toFree(r);
    return;
  }
  if (r.a.derail && rel >= DERAIL_REL) {
    r.rail = false;
    toFree(r);
    return;
  }
  const d = (r.v * r.v) / (2 * Math.min(r.brake, r.plan));
  r.nodes = [
    { s: r.s, V: r.v, hold: 0 },
    { s: r.s + d, V: 0, hold: 0 },
  ];
  r.next = 1;
}

function velocityOf(r: Rt): Vec {
  return r.mode === 'free' ? r.vel : mul(fromAngle(r.h), r.v);
}

function toFree(r: Rt): void {
  if (r.mode === 'free') return;
  r.vel = velocityOf(r);
  r.mode = 'free';
}

export function simulate(scene: Scene): Timeline {
  const geo = buildGeo(scene);
  const mu = SURFACES[scene.env.surface].mu;
  const duration = Math.max(1, scene.env.duration);
  const n = Math.floor(duration / DT) + 1;

  const rts = scene.actors.map((a) => makeRuntime(a, mu, geo.tracks.map((t) => t.pts)));
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
        if (k > 0 || r.a.delay > 0) stepPath(r, DT);
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

/** Нужные для разбора характеристики участника на кадре. */
export function stateAt(tl: Timeline, id: string, k: number): { p: Vec; h: number; v: number; present: boolean; free: boolean } {
  const tr = tl.tracks.get(id)!;
  return { p: { x: tr.x[k], y: tr.y[k] }, h: tr.h[k], v: tr.v[k], present: !!tr.present[k], free: !!tr.free[k] };
}
