import {
  type NearestInfo,
  type OBB,
  type Vec,
  add,
  angDiff,
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
  segIntersect,
  smoothPolyline,
  sub,
} from './geom';
import type { Actor, Crosswalk, EdgePt, Movement, Obstacle, Road, Scene, Sidewalk, Sign, TrafficLight, TramTrack } from './scene';
import { roadWidth } from './scene';
import { dm } from './dmath';

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

export interface IntersectionApproach {
  id: string;
  roadId: string;
  point: Vec;
  /** Курс въезда к центру перекрёстка. */
  heading: number;
  station: number;
  gate: Gate;
  entry: boolean;
  exit: boolean;
  priority: 'main' | 'secondary' | 'equal' | 'unknown';
  surfacePriority: 'hard' | 'unpaved' | 'unknown';
}

export interface IntersectionGeo {
  id: string;
  roadIds: string[];
  center: Vec;
  boundary: Vec[];
  approaches: IntersectionApproach[];
  /** Автоматический контур — оценка; начала закруглений в модели дорог не заданы. */
  boundarySource: 'automatic-estimate' | 'survey';
  roundabout: boolean;
  regulated: boolean;
  equal: boolean;
}

export interface IntersectionMovement {
  maneuver: Movement | 'unknown';
  entryHeading: number;
  exitHeading: number;
  entryRoadId?: string;
  exitRoadId?: string;
  routeSource?: 'boundary' | 'nearby-road-transition';
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
  intersections: IntersectionGeo[];
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
    const l = dm.hypot(n.x, n.y);
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
  const geo: Geo = {
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
    intersections: [],
  };
  geo.intersections = buildIntersections(geo);
  return geo;
}

/** Includes the boundary itself. Supports surveyed, non-convex contours. */
export function inIntersectionBoundary(p: Vec, boundary: Vec[]): boolean {
  if (boundary.length < 3) return false;
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const a = boundary[j];
    const b = boundary[i];
    const ab = sub(b, a);
    const ap = sub(p, a);
    const len2 = dot(ab, ab);
    if (len2 < 1e-14) {
      if (dist(p, a) < 1e-7) return true;
      continue;
    }
    const t = len2 ? dot(ap, ab) / len2 : 0;
    if (t >= 0 && t <= 1 && Math.abs(ab.x * ap.y - ab.y * ap.x) <= 1e-7 * Math.max(1, Math.sqrt(len2))) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function hull(points: Vec[]): Vec[] {
  const ps = [...new Map(points.map(p => [`${p.x.toFixed(6)},${p.y.toFixed(6)}`, p])).values()]
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const cross3 = (a: Vec, b: Vec, c: Vec) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const chain = (list: Vec[]) => {
    const out: Vec[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross3(out[out.length - 2], out[out.length - 1], p) <= 1e-8) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...chain(ps), ...chain([...ps].reverse())];
}

function boundaryCenter(boundary: Vec[]): Vec {
  let area2 = 0, x = 0, y = 0;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    const cross = a.x * b.y - b.x * a.y;
    area2 += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  return Math.abs(area2) > 1e-8 ? { x: x / (3 * area2), y: y / (3 * area2) }
    : mul(boundary.reduce(add, { x: 0, y: 0 }), 1 / Math.max(1, boundary.length));
}

interface IntersectionNode { p: Vec; roadIds: string[] }

function intersectionNodes(roads: RoadGeo[]): IntersectionNode[] {
  const nodes: IntersectionNode[] = [];
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const A = roads[i];
    const B = roads[j];
    if (A.road.role === 'adjacent' || B.road.role === 'adjacent') continue;
    const push = (p: Vec) => {
      if (!nodes.some(n => n.roadIds.includes(A.road.id) && n.roadIds.includes(B.road.id) && dist(n.p, p) < 0.01)) {
        nodes.push({ p, roadIds: [A.road.id, B.road.id] });
      }
    };
    for (let a = 1; a < A.pts.length; a++) for (let b = 1; b < B.pts.length; b++) {
      const hit = segIntersect(A.pts[a - 1], A.pts[a], B.pts[b - 1], B.pts[b]);
      if (hit) push(add(A.pts[a - 1], mul(sub(A.pts[a], A.pts[a - 1]), hit.t)));
    }
    // A T junction may terminate at the other carriageway's edge rather than its axis.
    for (const [endRoad, throughRoad] of [[A, B], [B, A]]) {
      for (const station of [0, endRoad.total]) {
        const endpoint = frameAtStation(endRoad.pts, endRoad.cum, station);
        const near = nearestOnPolyline(throughRoad.pts, endpoint.p);
        const sin = Math.abs(dm.cos(endpoint.a) * near.tangent.y - dm.sin(endpoint.a) * near.tangent.x);
        const w = widthsAt(throughRoad, near.s);
        if (!near.beyond && sin > 0.3 && near.dist <= (near.d >= 0 ? w.r : w.l) + 0.05) push(near.point);
      }
    }
  }
  return nodes;
}

function approachesFor(geo: Geo, roadIds: string[], boundary: Vec[]): IntersectionApproach[] {
  const approaches: IntersectionApproach[] = [];
  for (const rg of geo.roads.filter(r => roadIds.includes(r.road.id))) {
    const crossings: { p: Vec; s: number; tangent: Vec }[] = [];
    for (let n = 1; n < rg.pts.length; n++) for (let e = 0; e < boundary.length; e++) {
      const hit = segIntersect(rg.pts[n - 1], rg.pts[n], boundary[e], boundary[(e + 1) % boundary.length]);
      if (!hit) continue;
      const vector = sub(rg.pts[n], rg.pts[n - 1]);
      const s = rg.cum[n - 1] + dist(rg.pts[n - 1], rg.pts[n]) * hit.t;
      if (!crossings.some(x => Math.abs(x.s - s) < 0.01)) crossings.push({ p: add(rg.pts[n - 1], mul(vector, hit.t)), s, tangent: norm(vector) });
    }
    for (const crossing of crossings.sort((a, b) => a.s - b.s)) {
      const before = frameAtStation(rg.pts, rg.cum, Math.max(0, crossing.s - 0.02)).p;
      const after = frameAtStation(rg.pts, rg.cum, Math.min(rg.total, crossing.s + 0.02)).p;
      const beforeInside = inIntersectionBoundary(before, boundary);
      const afterInside = inIntersectionBoundary(after, boundary);
      if (beforeInside === afterInside) continue;
      const forward = afterInside;
      const heading = angleOf(mul(crossing.tangent, forward ? 1 : -1));
      const w = widthsAt(rg, crossing.s);
      const right = rightOf(heading);
      const surfacePriority = rg.road.surfacePriority ?? 'hard';
      approaches.push({ id: `${rg.road.id}:${crossing.s.toFixed(3)}:${forward ? '+' : '-'}`, roadId: rg.road.id,
        point: crossing.p, heading, station: crossing.s,
        gate: { a: add(crossing.p, mul(right, forward ? w.r : w.l)), b: add(crossing.p, mul(right, -(forward ? w.l : w.r))) },
        entry: !rg.road.oneWay || forward, exit: !rg.road.oneWay || !forward,
        priority: surfacePriority === 'unknown' ? 'unknown' : 'equal', surfacePriority });
    }
  }
  return approaches;
}

function classifyControls(geo: Geo, junction: IntersectionGeo): void {
  const radius = Math.max(0, ...junction.boundary.map(p => dist(p, junction.center)));
  const nearby = geo.scene.signs.filter(s => dist(s, junction.center) <= radius + 35);
  const hardAndUnpaved = junction.approaches.some(a => a.surfacePriority === 'hard') && junction.approaches.some(a => a.surfacePriority === 'unpaved');
  for (const a of junction.approaches) {
    if (hardAndUnpaved && a.surfacePriority !== 'unknown') a.priority = a.surfacePriority === 'hard' ? 'main' : 'secondary';
    const priorityPlate = nearby.find(s => s.plates?.includes('8.13') && s.mainDirections?.length);
    if (priorityPlate) a.priority = priorityPlate.mainDirections!.some(h => Math.abs(angDiff(h, a.heading)) < Math.PI / 5) ? 'main' : 'secondary';
    const candidates = nearby.filter(s => ['2.1', '2.4', '2.5'].includes(s.kind)
      && Math.abs(angDiff(s.angle, a.heading)) < Math.PI / 4
      && dot(sub(s, a.point), fromAngle(a.heading)) <= 1
      && Math.abs(dot(sub(s, a.point), rightOf(a.heading))) < dist(a.gate.a, a.gate.b) / 2 + 8)
      .sort((s1, s2) => dist(s1, a.point) - dist(s2, a.point));
    if (candidates[0]) a.priority = candidates[0].kind === '2.1' ? 'main' : 'secondary';
  }
  junction.regulated = geo.scene.lights.some(l => l.mode !== 'off' && l.mode !== 'flashing-yellow'
    && l.kind !== 'reversible' && dist(l, junction.center) <= radius + 25
    && (l.kind === 'controller' || junction.approaches.some(a => a.entry && Math.abs(angDiff(a.heading, l.angle)) < Math.PI / 3)));
  junction.equal = junction.approaches.every(a => a.priority === 'equal');
}

/**
 * Estimate junction limits from road edges and crossing axes. The road model has no
 * surveyed starts of carriageway corner radii required by PDD 1.2: these limits are
 * explicitly automatic-estimate and can be replaced by scene.intersectionBounds.
 * All roads are assumed to meet at one level; bridges need surveyed input.
 */
function buildIntersections(geo: Geo): IntersectionGeo[] {
  const nodes = intersectionNodes(geo.roads.filter(r => r.pts.length >= 2));
  const groups: IntersectionNode[][] = [];
  for (const node of nodes) {
    const nearGroups = groups.filter(group => group.some(other => dist(other.p, node.p) < 1
      || other.roadIds.some(id => node.roadIds.includes(id) && geo.roads.find(r => r.road.id === id)?.road.role === 'roundabout')));
    if (!nearGroups.length) groups.push([node]);
    else {
      nearGroups[0].push(node, ...nearGroups.slice(1).flat());
      for (const group of nearGroups.slice(1)) groups.splice(groups.indexOf(group), 1);
    }
  }
  const junctions = groups.map((group, index): IntersectionGeo => {
    const roadIds = [...new Set(group.flatMap(n => n.roadIds))].sort();
    const roads = geo.roads.filter(r => roadIds.includes(r.road.id));
    const points: Vec[] = [];
    for (const rg of roads) {
      if (rg.road.role === 'roundabout') {
        points.push(...roadOutlinePoly(rg));
        continue;
      }
      const anchors = group.filter(n => n.roadIds.includes(rg.road.id));
      for (const anchor of anchors) {
        const near = nearestOnPolyline(rg.pts, anchor.p);
        const own = widthsAt(rg, near.s);
        let reach = Math.max(own.l, own.r);
        for (const other of roads) {
          if (other === rg) continue;
          const on = nearestOnPolyline(other.pts, anchor.p);
          const cos = Math.abs(dot(near.tangent, on.tangent));
          const sin = Math.abs(near.tangent.x * on.tangent.y - near.tangent.y * on.tangent.x);
          if (sin > 0.1) reach = Math.max(reach, (Math.max(widthsAt(other, on.s).l, widthsAt(other, on.s).r) + Math.max(own.l, own.r) * cos) / sin);
        }
        for (const station of [Math.max(0, near.s - reach), Math.min(rg.total, near.s + reach)]) {
          const frame = frameAtStation(rg.pts, rg.cum, station);
          const w = widthsAt(rg, station);
          points.push(add(frame.p, mul(rightOf(frame.a), w.r)), add(frame.p, mul(rightOf(frame.a), -w.l)));
        }
      }
    }
    const boundary = hull(points);
    const ring = roads.find(r => r.road.role === 'roundabout');
    return { id: `intersection-${index + 1}`, roadIds, center: boundaryCenter(ring?.pts ?? boundary), boundary,
      approaches: approachesFor(geo, roadIds, boundary), boundarySource: 'automatic-estimate',
      roundabout: roads.some(r => r.road.role === 'roundabout'), regulated: false, equal: true };
  }).filter(j => j.boundary.length >= 3 && (j.roundabout || j.approaches.filter(a => a.entry || a.exit).length >= 3));
  for (const surveyed of geo.scene.intersectionBounds ?? []) {
    if (surveyed.boundary.length < 3) continue;
    const center = boundaryCenter(surveyed.boundary);
    const matching = junctions.filter(j => j.roadIds.length === surveyed.roadIds.length && j.roadIds.every(id => surveyed.roadIds.includes(id)))
      .sort((a, b) => dist(a.center, center) - dist(b.center, center))[0];
    const junction: IntersectionGeo = { id: surveyed.id, roadIds: [...surveyed.roadIds], center,
      boundary: surveyed.boundary.map(p => ({ ...p })), approaches: approachesFor(geo, surveyed.roadIds, surveyed.boundary),
      boundarySource: 'survey', roundabout: geo.roads.some(r => surveyed.roadIds.includes(r.road.id) && r.road.role === 'roundabout'), regulated: false, equal: true };
    if (matching) junctions[junctions.indexOf(matching)] = junction;
    else junctions.push(junction);
  }
  for (const junction of junctions) classifyControls(geo, junction);
  return junctions;
}

export function intersectionAt(geo: Geo, p: Vec): IntersectionGeo | undefined {
  return geo.intersections.find(junction => inIntersectionBoundary(p, junction.boundary));
}

/** Classifies the first passage using the complete planned path, including its exit after a collision. */
export function classifyIntersectionMovement(geo: Geo, actor: Actor, junction: IntersectionGeo): IntersectionMovement {
  const ctrl = [{ x: actor.x, y: actor.y }, ...actor.path.map(p => ({ x: p.x, y: p.y }))]
    .filter((p, i, ps) => i === 0 || dist(p, ps[i - 1]) > 0.001);
  if (ctrl.length === 1) ctrl.push(add(ctrl[0], mul(fromAngle(actor.heading), 1000)));
  const points = smoothPolyline(ctrl, 12).pts;
  const last = points[points.length - 1];
  const endDirection = norm(sub(last, points[points.length - 2]));
  points.push(add(last, mul(endDirection, 1000)));
  const startsInside = inIntersectionBoundary(points[0], junction.boundary);
  let entry: { point: Vec; heading: number } | undefined = startsInside ? { point: points[0], heading: actor.heading } : undefined;
  let exit: { point: Vec; heading: number } | undefined;
  for (let i = 1; i < points.length && !exit; i++) {
    const start = points[i - 1];
    const delta = sub(points[i], start);
    const length = dm.hypot(delta.x, delta.y);
    const crossings = junction.boundary.flatMap((a, n) => {
      const hit = segIntersect(start, points[i], a, junction.boundary[(n + 1) % junction.boundary.length]);
      return hit ? [hit.t] : [];
    }).sort((a, b) => a - b);
    for (const t of crossings) {
      const p = add(start, mul(delta, t));
      const epsilon = Math.min(0.001, 0.01 / Math.max(length, 0.001));
      const before = inIntersectionBoundary(add(start, mul(delta, t - epsilon)), junction.boundary);
      const after = inIntersectionBoundary(add(start, mul(delta, t + epsilon)), junction.boundary);
      if (!entry && !before && after) entry = { point: p, heading: angleOf(delta) };
      else if (entry && before && !after) { exit = { point: p, heading: angleOf(delta) }; break; }
    }
  }
  if (!entry || !exit) {
    if (junction.boundarySource !== 'automatic-estimate') return { maneuver: 'unknown', entryHeading: entry?.heading ?? actor.heading, exitHeading: exit?.heading ?? actor.heading };
    // With no surveyed corner radii an outer turn can skirt the estimated overlap
    // polygon. Associate only a local transition between this junction's roads;
    // a distant bend or a path merely passing nearby is not a junction passage.
    const nearbyLimit = Math.max(...junction.boundary.map(p => dist(p, junction.center)))
      + Math.max(...geo.roads.filter(r => junction.roadIds.includes(r.road.id)).map(r => r.width)) + 2;
    const observations: { roadId: string; heading: number }[] = [];
    for (let i = 1; i < points.length; i++) {
      if (dist(points[i - 1], junction.center) > nearbyLimit) continue;
      const heading = angleOf(sub(points[i], points[i - 1]));
      const hit = roadsAt(geo, points[i - 1], 0.3).filter(r => junction.roadIds.includes(r.rg.road.id))
        .sort((a, b) => Math.abs(dm.sin(angDiff(angleOf(a.near.tangent), heading))) - Math.abs(dm.sin(angDiff(angleOf(b.near.tangent), heading))))[0];
      if (!hit) continue;
      const roadHeading = angleOf(hit.near.tangent);
      observations.push({ roadId: hit.rg.road.id, heading: dot(fromAngle(heading), hit.near.tangent) >= 0 ? roadHeading : roadHeading + Math.PI });
    }
    const first = observations[0];
    const last = observations.at(-1);
    if (first && last && first.roadId !== last.roadId) {
      const incoming = junction.approaches.find(a => a.roadId === first.roadId && a.entry && Math.abs(angDiff(a.heading, first.heading)) < Math.PI / 4);
      const outgoing = junction.approaches.find(a => a.roadId === last.roadId && a.exit && Math.abs(angDiff(a.heading + Math.PI, last.heading)) < Math.PI / 4);
      if (incoming && outgoing) {
        const turn = angDiff(incoming.heading, outgoing.heading + Math.PI);
        return { maneuver: Math.abs(turn) < Math.PI / 4 ? 'straight' : Math.abs(turn) > Math.PI * 3 / 4 ? 'uturn' : turn > 0 ? 'right' : 'left',
          entryHeading: incoming.heading, exitHeading: outgoing.heading + Math.PI,
          entryRoadId: first.roadId, exitRoadId: last.roadId, routeSource: 'nearby-road-transition' };
      }
    }
    return { maneuver: 'unknown', entryHeading: entry?.heading ?? actor.heading, exitHeading: exit?.heading ?? actor.heading };
  }
  const approachFor = (event: { point: Vec; heading: number }, entering: boolean) => junction.approaches
    .filter(a => (entering ? a.entry : a.exit) && Math.abs(angDiff(a.heading + (entering ? 0 : Math.PI), event.heading)) < Math.PI / 3)
    .sort((a, b) => dist(a.point, event.point) - dist(b.point, event.point))[0];
  const entryApproach = startsInside ? undefined : approachFor(entry, true);
  const exitApproach = approachFor(exit, false);
  const entryHeading = entryApproach?.heading ?? entry.heading;
  const exitHeading = exitApproach ? exitApproach.heading + Math.PI : exit.heading;
  const delta = angDiff(entryHeading, exitHeading);
  const roadAt = (p: Vec, heading: number) => roadsAt(geo, p, 0.5)
    .filter(r => junction.roadIds.includes(r.rg.road.id))
    .sort((a, b) => Math.abs(dm.sin(angDiff(angleOf(a.near.tangent), heading))) - Math.abs(dm.sin(angDiff(angleOf(b.near.tangent), heading))))[0]?.rg.road.id;
  return { maneuver: Math.abs(delta) < Math.PI / 4 ? 'straight' : Math.abs(delta) > Math.PI * 3 / 4 ? 'uturn' : delta > 0 ? 'right' : 'left',
    entryHeading, exitHeading,
    entryRoadId: entryApproach?.roadId ?? roadAt(entry.point, entryHeading),
    exitRoadId: exitApproach?.roadId ?? roadAt(exit.point, exitHeading), routeSource: 'boundary' };
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
  return !!intersectionAt(geo, p);
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
    if (sg.item.mobilityKind && !['sidewalk', 'footpath', 'pedestrian-side', 'sharedpath', 'pedestrian-zone'].includes(sg.item.mobilityKind)) continue;
    if (sg.pts.length < 2) continue;
    const near = nearestOnPolyline(sg.pts, p);
    if (near.dist <= sg.item.width / 2) return sg;
  }
  return null;
}

export function trackAt(geo: Geo, p: Vec, tol = 1.2): { tg: TrackGeo; near: NearestInfo } | null {
  for (const tg of geo.tracks) {
    if (tg.item.kind === 'railway') continue;
    if (tg.pts.length < 2) continue;
    const near = nearestOnPolyline(tg.pts, p);
    if (near.dist <= tol) return { tg, near };
  }
  return null;
}
