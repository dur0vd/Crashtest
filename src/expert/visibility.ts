import type { OBB, Vec } from '../geom';
import { dm } from '../dmath';

/**
 * 2D line of sight (stage 10). Occluders are opaque rectangles (buildings,
 * fences, trees, barriers, other vehicles); A-pillars are blind sectors in the
 * observer body frame; the visibility distance (lighting/weather) must be a
 * measured value with its source — without it only geometry limits detection.
 * Heights, partial transparency and glare are not modelled.
 */
export interface BlindSector { fromDeg: number; toDeg: number; source: string }

export interface SightInput {
  eye: Vec;
  heading: number;
  target: OBB;
  occluders: { id: string; kind: string; box: OBB }[];
  pillars?: BlindSector[];
  visibilityDistance?: number;
}

export interface SightResult {
  visible: boolean;
  /** Fraction of the 5 target sample points (corners + centre) that are visible. */
  visibleFraction: number;
  distance: number;
  bearingDeg: number;
  blockedBy: string[];
  reasons: string[];
}

const wrapDeg = (d: number) => ((d + 180) % 360 + 360) % 360 - 180;

/** Liang–Barsky clip of segment p→q against the OBB in its local frame. */
export function segmentHitsObb(p: Vec, q: Vec, o: OBB): boolean {
  const c = dm.cos(o.a), s = dm.sin(o.a);
  const loc = (v: Vec) => ({ x: (v.x - o.cx) * c + (v.y - o.cy) * s, y: -(v.x - o.cx) * s + (v.y - o.cy) * c });
  const a = loc(p), b = loc(q), d = { x: b.x - a.x, y: b.y - a.y };
  let t0 = 0, t1 = 1;
  for (const [pv, qv] of [[-d.x, a.x + o.hl], [d.x, o.hl - a.x], [-d.y, a.y + o.hw], [d.y, o.hw - a.y]]) {
    if (pv === 0) { if (qv < 0) return false; continue; }
    const r = qv / pv;
    if (pv < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 < t1;
}

export function obbPoints(o: OBB): Vec[] {
  const c = dm.cos(o.a), s = dm.sin(o.a);
  return [[0, 0], [o.hl, o.hw], [o.hl, -o.hw], [-o.hl, o.hw], [-o.hl, -o.hw]]
    .map(([x, y]) => ({ x: o.cx + c * x - s * y, y: o.cy + s * x + c * y }));
}

export function lineOfSight(i: SightInput): SightResult {
  for (const p of i.pillars ?? []) if (!p.source?.trim()) throw new Error('Обзорность: сектор стойки без источника');
  if (i.visibilityDistance !== undefined && !(i.visibilityDistance > 0)) throw new Error('Обзорность: дальность видимости > 0');
  const points = obbPoints(i.target);
  const blocked = new Set<string>(), reasons = new Set<string>();
  let visible = 0;
  for (const pt of points) {
    const dx = pt.x - i.eye.x, dy = pt.y - i.eye.y, dist = dm.hypot(dx, dy);
    const bearing = wrapDeg((dm.atan2(dy, dx) - i.heading) * 180 / Math.PI);
    if (i.visibilityDistance !== undefined && dist > i.visibilityDistance) { reasons.add('дальше измеренной дальности видимости'); continue; }
    const pillar = (i.pillars ?? []).find(p => wrapDeg(bearing - p.fromDeg) >= 0 && wrapDeg(p.toDeg - bearing) >= 0);
    if (pillar) { reasons.add(`в секторе стойки ${pillar.fromDeg}…${pillar.toDeg}°`); continue; }
    const occ = i.occluders.filter(o => segmentHitsObb(i.eye, pt, o.box));
    if (occ.length) { occ.forEach(o => blocked.add(o.id)); reasons.add('линия видимости перекрыта'); continue; }
    visible++;
  }
  const centre = points[0];
  return { visible: visible > 0, visibleFraction: visible / points.length, distance: dm.hypot(centre.x - i.eye.x, centre.y - i.eye.y),
    bearingDeg: wrapDeg((dm.atan2(centre.y - i.eye.y, centre.x - i.eye.x) - i.heading) * 180 / Math.PI), blockedBy: [...blocked], reasons: [...reasons] };
}
