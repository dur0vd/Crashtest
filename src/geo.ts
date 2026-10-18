import {
  type NearestInfo,
  type OBB,
  type Vec,
  add,
  angleOf,
  dist,
  dot,
  filletPolyline,
  frameAtStation,
  fromAngle,
  mul,
  nearestOnPolyline,
  norm,
  rightOf,
  smoothPolyline,
  sub,
} from './geom';
import type { Crosswalk, EdgePt, Obstacle, Road, Scene, Sidewalk, Sign, TrafficLight, TramTrack } from './scene';
import { roadWidth } from './scene';

/** Расстояние, на которое знак «простреливает» поперёк дороги влево от своей опоры. */
export const SIGN_REACH = 14;

/** Узел разбивки дороги: точка на оси и смещённые кромки. */
export interface RoadSample {
  p: Vec;
  s: number;
  /** правая нормаль, масштабированная для сохранения ширины на изгибах */
  n: Vec;
  /** полуширина слева и справа в этой точке */
  wl: number;
  wr: number;
}

export interface RoadGeo {
  road: Road;
  /** ось дороги (с учётом сглаживания) */
  pts: Vec[];
  /** накопленная длина оси */
  cum: number[];
  total: number;
  /** номинальная ширина по числу полос */
  width: number;
  /** номинальная полуширина */
  half: number;
  samples: RoadSample[];
  /** кромки */
  left: Vec[];
  right: Vec[];
}

export interface SidewalkGeo {
  item: Sidewalk;
  pts: Vec[];
}

export interface TrackGeo {
  item: TramTrack;
  pts: Vec[];
}

export interface Gate {
  a: Vec;
  b: Vec;
}

export interface SignGeo {
  sign: Sign;
  gate: Gate;
}

export interface LightGeo {
  light: TrafficLight;
  line: Gate;
}

export interface CrosswalkGeo {
  item: Crosswalk;
  box: OBB;
}

export interface ObstacleGeo {
  item: Obstacle;
  box: OBB;
}

export interface Geo {
  scene: Scene;
  roads: RoadGeo[];
  sidewalks: SidewalkGeo[];
  tracks: TrackGeo[];
  signs: SignGeo[];
  lights: LightGeo[];
  crosswalks: CrosswalkGeo[];
  obstacles: ObstacleGeo[];
}

/** Ломаная с учётом скругления поворотов (радиус в приоритете) или сплайна. */
export function densify(pts: Vec[], smooth: boolean, radius = 0): Vec[] {
  if (pts.length < 3) return pts;
  if (radius > 0.05) return filletPolyline(pts, radius);
  return smooth ? smoothPolyline(pts, 12).pts : pts;
}

/** Значение профиля кромки на станции s (линейная интерполяция, за краями — константа). */
export function profileAt(prof: EdgePt[] | undefined, nominal: number, s: number): number {
  if (!prof || !prof.length) return nominal;
  if (s <= prof[0].s) return prof[0].w;
  const last = prof[prof.length - 1];
  if (s >= last.s) return last.w;
  for (let i = 1; i < prof.length; i++) {
    if (s <= prof[i].s) {
      const a = prof[i - 1];
      const b = prof[i];
      const t = b.s - a.s < 1e-9 ? 1 : (s - a.s) / (b.s - a.s);
      return a.w + (b.w - a.w) * t;
    }
  }
  return nominal;
}

export function widthsAt(rg: RoadGeo, s: number): { l: number; r: number } {
  return { l: profileAt(rg.road.wl, rg.half, s), r: profileAt(rg.road.wr, rg.half, s) };
}

function cumulative(pts: Vec[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return cum;
}

export function buildRoadGeo(road: Road): RoadGeo {
  const width = roadWidth(road);
  const half = width / 2;
  const pts = densify(road.pts, road.smooth, road.radius ?? 0);
  const cum = cumulative(pts);
  const total = cum[cum.length - 1] ?? 0;
  const rg: RoadGeo = { road, pts, cum, total, width, half, samples: [], left: [], right: [] };
  if (pts.length < 2) return rg;

  // станции, на которых нужны узлы: вершины оси и точки профилей кромок
  const stations = new Set<number>(cum.map((c) => +c.toFixed(4)));
  for (const prof of [road.wl, road.wr]) for (const e of prof ?? []) if (e.s > 0 && e.s < total) stations.add(+e.s.toFixed(4));
  const ss = [...stations].sort((a, b) => a - b);
  const frames = ss.map((s) => ({ s, ...frameAtStation(pts, cum, s) }));
  frames.forEach((f, i) => {
    // касательная в узле — биссектриса соседних отрезков, длина нормали компенсирует изгиб
    const prev = i > 0 ? norm(sub(f.p, frames[i - 1].p)) : null;
    const next = i < frames.length - 1 ? norm(sub(frames[i + 1].p, f.p)) : null;
    const t1 = prev ?? next!;
    const t2 = next ?? prev!;
    const r1 = rightOf(angleOf(t1));
    const r2 = rightOf(angleOf(t2));
    let n = { x: r1.x + r2.x, y: r1.y + r2.y };
    const l = Math.hypot(n.x, n.y);
    if (l < 1e-6) n = r1;
    else {
      const cos = Math.max(0.35, l / 2);
      n = { x: n.x / l / cos, y: n.y / l / cos };
    }
    const wl = profileAt(road.wl, half, f.s);
    const wr = profileAt(road.wr, half, f.s);
    rg.samples.push({ p: f.p, s: f.s, n, wl, wr });
    rg.left.push(sub(f.p, mul(n, wl)));
    rg.right.push(add(f.p, mul(n, wr)));
  });
  return rg;
}

/** Контур проезжей части для заливки и обрезки разметки. */
export function roadOutlinePoly(rg: RoadGeo): Vec[] {
  return [...rg.left, ...[...rg.right].reverse()];
}

/** Отрезок от опоры (правый край) поперёк проезжей части влево. */
export function gateFor(x: number, y: number, angle: number, reach: number, back = 0): Gate {
  const p = { x, y };
  const r = rightOf(angle);
  return { a: add(p, mul(r, back)), b: add(p, mul(r, -reach)) };
}

/** Ширина «простреливаемой» зоны знака: по ширине полосы движения рядом с ним. */
function signReach(scene: Scene, sign: Sign): number {
  let best = SIGN_REACH;
  let bestDist = 12;
  const dir = fromAngle(sign.angle);
  for (const road of scene.roads) {
    if (road.pts.length < 2) continue;
    const rg = buildRoadGeo(road);
    const near = nearestOnPolyline(rg.pts, { x: sign.x, y: sign.y });
    if (near.dist < bestDist) {
      bestDist = near.dist;
      const w = widthsAt(rg, near.s);
      const fwd = dot(dir, near.tangent) >= 0;
      best = (road.oneWay ? w.l + w.r : fwd ? w.r : w.l) + 0.5;
    }
  }
  return best;
}

export function buildGeo(scene: Scene): Geo {
  return {
    scene,
    roads: scene.roads.map((road) => buildRoadGeo(road)),
    sidewalks: scene.sidewalks.map((item) => ({ item, pts: densify(item.pts, item.smooth, item.radius ?? 0) })),
    tracks: scene.tracks.map((item) => ({ item, pts: densify(item.pts, item.smooth, item.radius ?? 0) })),
    signs: scene.signs.map((sign) => ({ sign, gate: gateFor(sign.x, sign.y, sign.angle, signReach(scene, sign), 1) })),
    lights: scene.lights.map((light) => ({ light, line: gateFor(light.x, light.y, light.angle, light.lineLength) })),
    crosswalks: scene.crosswalks.map((item) => ({
      item,
      box: { cx: item.x, cy: item.y, hl: item.length / 2, hw: item.width / 2, a: item.angle },
    })),
    obstacles: scene.obstacles.map((item) => ({
      item,
      box: { cx: item.x, cy: item.y, hl: item.w / 2, hw: item.h / 2, a: item.angle },
    })),
  };
}

export interface RoadHit {
  rg: RoadGeo;
  near: NearestInfo;
  /** расстояние до оси в долях полуширины */
  rel: number;
}

/** Все дороги, асфальт которых накрывает точку (ближайшая к оси — первой). */
export function roadsAt(geo: Geo, p: Vec, margin = 0): RoadHit[] {
  const out: RoadHit[] = [];
  for (const rg of geo.roads) {
    if (rg.pts.length < 2) continue;
    const near = nearestOnPolyline(rg.pts, p);
    if (near.beyond) continue;
    const w = widthsAt(rg, near.s);
    const side = near.d >= 0 ? w.r : w.l;
    if (near.dist <= side + margin) out.push({ rg, near, rel: near.dist / Math.max(0.1, side) });
  }
  return out.sort((a, b) => a.rel - b.rel);
}

export function inIntersection(geo: Geo, p: Vec): boolean {
  return roadsAt(geo, p).length >= 2;
}

/**
 * Положение точки относительно оси дороги с точки зрения участника, едущего по курсу `heading`:
 * положительное значение — своя (правая) половина, отрицательное — встречная.
 */
export function lateralFor(near: NearestInfo, heading: number): { lat: number; forward: boolean } {
  const f = fromAngle(heading);
  const forward = f.x * near.tangent.x + f.y * near.tangent.y >= 0;
  return { lat: forward ? near.d : -near.d, forward };
}

export function sidewalkAt(geo: Geo, p: Vec): SidewalkGeo | null {
  for (const sg of geo.sidewalks) {
    if (sg.pts.length < 2) continue;
    const near = nearestOnPolyline(sg.pts, p);
    if (near.dist <= sg.item.width / 2) return sg;
  }
  return null;
}

export function trackAt(geo: Geo, p: Vec, tol = 1.2): { tg: TrackGeo; near: NearestInfo } | null {
  for (const tg of geo.tracks) {
    if (tg.pts.length < 2) continue;
    const near = nearestOnPolyline(tg.pts, p);
    if (near.dist <= tol) return { tg, near };
  }
  return null;
}
