import {
  type NearestInfo,
  type OBB,
  type Vec,
  add,
  fromAngle,
  mul,
  nearestOnPolyline,
  rightOf,
  smoothPolyline,
} from './geom';
import type { Crosswalk, Obstacle, Road, Scene, Sidewalk, Sign, TrafficLight, TramTrack } from './scene';
import { roadWidth } from './scene';

/** Расстояние, на которое знак «простреливает» поперёк дороги влево от своей опоры. */
export const SIGN_REACH = 14;

export interface RoadGeo {
  road: Road;
  pts: Vec[];
  width: number;
  half: number;
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

export function densify(pts: Vec[], smooth: boolean): Vec[] {
  return smooth && pts.length >= 3 ? smoothPolyline(pts, 12).pts : pts;
}

/** Отрезок от опоры (правый край) поперёк проезжей части влево. */
export function gateFor(x: number, y: number, angle: number, reach: number, back = 0): Gate {
  const p = { x, y };
  const r = rightOf(angle);
  return { a: add(p, mul(r, back)), b: add(p, mul(r, -reach)) };
}

export function buildGeo(scene: Scene): Geo {
  return {
    scene,
    roads: scene.roads.map((road) => {
      const width = roadWidth(road);
      return { road, pts: densify(road.pts, road.smooth), width, half: width / 2 };
    }),
    sidewalks: scene.sidewalks.map((item) => ({ item, pts: densify(item.pts, item.smooth) })),
    tracks: scene.tracks.map((item) => ({ item, pts: densify(item.pts, item.smooth) })),
    signs: scene.signs.map((sign) => ({ sign, gate: gateFor(sign.x, sign.y, sign.angle, SIGN_REACH, 1) })),
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
    if (near.dist <= rg.half + margin) out.push({ rg, near, rel: near.dist / rg.half });
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
