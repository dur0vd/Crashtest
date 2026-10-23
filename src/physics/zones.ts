import type { ParameterSource, SurfaceGrade } from './types';
import { finite, validateSource } from './parameters';
import { dm } from '../dmath';

/** Planar point in scene metres. Local type keeps the physics package free of geom imports. */
export interface ZonePoint { x: number; y: number }

/**
 * Measured roughness is stored for traces only. Its effect on tyre/suspension
 * forces is NOT computed: there is no verified transfer model in this kernel,
 * and a friction multiplier would be an invented substitute (TODO(source-check)).
 */
export type RoughnessObservation =
  | { kind: 'elevation-profile'; samples: { s: number; z: number }[]; direction: number; source: ParameterSource }
  | { kind: 'iri'; value: number; source: ParameterSource };

/** extensions.physics.zones item. Unknown fields stay unknown; nothing defaults to 0. */
export interface PhysicsZone {
  id: string;
  /** Closed polygon, metres; the boundary itself belongs to the zone. */
  boundary: ZonePoint[];
  /** Measured tyre-road friction coefficient, dimensionless. */
  mu?: number;
  /** Reference direction of the zone, rad, project heading convention. Required with a grade. */
  direction?: number;
  /** Rise per metre along direction, dimensionless; positive is uphill along it. */
  gradeLongitudinal?: number;
  /** Rise per metre to the right of direction (rightOf(direction)), dimensionless. */
  gradeCross?: number;
  roughness?: RoughnessObservation;
  /** Higher wins for a field defined by several overlapping zones; default 0. */
  priority?: number;
  source: ParameterSource;
  measuredAt?: string;
  conditions?: string;
}

/** What the scene runner actually used at one point; recorded in traces. */
export interface ResolvedSurface {
  mu: number;
  muSource: ParameterSource;
  muZoneId?: string;
  /** World gradient of the plane, undefined when no zone provides one. */
  grade?: SurfaceGrade;
  gradeZoneId?: string;
  /** True only when a zone supplied the value; otherwise an explicit assumption was used. */
  muKnown: boolean;
  gradeKnown: boolean;
  roughness: { zoneId: string; kind: RoughnessObservation['kind']; effect: 'not-modelled' }[];
}

function validPoint(p: ZonePoint): boolean {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function polygonArea(ps: ZonePoint[]): number {
  let a = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], q = ps[(i + 1) % ps.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function validateZone(z: PhysicsZone): void {
  if (!z || typeof z.id !== 'string' || !z.id.trim()) throw new Error('Зона: нужен идентификатор');
  if (!Array.isArray(z.boundary) || z.boundary.length < 3 || !z.boundary.every(validPoint)
    || Math.abs(polygonArea(z.boundary)) < 1e-9) throw new Error(`Зона ${z.id}: нужен невырожденный контур из ≥3 точек`);
  validateSource(z.source);
  if (z.mu !== undefined) finite(z.mu, `зона ${z.id}: mu`, 0, 2);
  const graded = z.gradeLongitudinal !== undefined || z.gradeCross !== undefined;
  if (z.gradeLongitudinal !== undefined) finite(z.gradeLongitudinal, `зона ${z.id}: продольный уклон`, -1, 1);
  if (z.gradeCross !== undefined) finite(z.gradeCross, `зона ${z.id}: поперечный уклон`, -1, 1);
  if (graded) {
    if (z.direction === undefined) throw new Error(`Зона ${z.id}: уклон без направления зоны не определён`);
    finite(z.direction, `зона ${z.id}: направление`);
  }
  if (z.priority !== undefined) finite(z.priority, `зона ${z.id}: приоритет`);
  if (z.roughness !== undefined) {
    const r = z.roughness;
    if (r.kind === 'iri') finite(r.value, `зона ${z.id}: IRI`, 0);
    else if (r.kind === 'elevation-profile') {
      if (!Array.isArray(r.samples) || r.samples.length < 2
        || r.samples.some(p => !Number.isFinite(p?.s) || !Number.isFinite(p?.z))) throw new Error(`Зона ${z.id}: профиль неровности — ≥2 точек s/z`);
      finite(r.direction, `зона ${z.id}: направление профиля`);
    } else throw new Error(`Зона ${z.id}: неизвестный вид неровности`);
    validateSource(r.source);
  }
}

export function validateZones(zones: PhysicsZone[]): void {
  const ids = new Set<string>();
  for (const z of zones) {
    validateZone(z);
    if (ids.has(z.id)) throw new Error(`Зона ${z.id}: повторяющийся идентификатор`);
    ids.add(z.id);
  }
}

/** Closed-set test: points on an edge (within 1e-9 m) are inside. */
export function pointInZone(p: ZonePoint, boundary: ZonePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const a = boundary[i], b = boundary[j];
    const abx = b.x - a.x, aby = b.y - a.y, l2 = abx * abx + aby * aby;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2)) : 0;
    if (dm.hypot(p.x - a.x - t * abx, p.y - a.y - t * aby) <= 1e-9) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** World gradient grad z = gL*d + gC*r, d=(cos,sin), r=(-sin,cos) as geom.rightOf. */
export function zoneGradient(z: PhysicsZone): { x: number; y: number } | undefined {
  if (z.gradeLongitudinal === undefined && z.gradeCross === undefined) return undefined;
  const gl = z.gradeLongitudinal ?? 0, gc = z.gradeCross ?? 0, a = z.direction!;
  // A zone defining only one component declares the other as zero for that plane.
  return { x: gl * dm.cos(a) - gc * dm.sin(a), y: gl * dm.sin(a) + gc * dm.cos(a) };
}

function pick<T>(field: string, point: ZonePoint, candidates: { zone: PhysicsZone; value: T }[], same: (a: T, b: T) => boolean): { zone: PhysicsZone; value: T } | undefined {
  if (!candidates.length) return undefined;
  const top = Math.max(...candidates.map(c => c.zone.priority ?? 0));
  const best = candidates.filter(c => (c.zone.priority ?? 0) === top);
  if (best.some(c => !same(c.value, best[0].value))) {
    throw new Error(`Зоны ${best.map(c => c.zone.id).join(', ')}: неоднозначное значение ${field} в точке (${point.x.toFixed(2)}; ${point.y.toFixed(2)}) при равном приоритете`);
  }
  return best[0];
}

/**
 * Field-wise resolution: for mu and for grade separately, the containing zone
 * with the highest priority that defines the field wins; equal priorities with
 * different values are an error, never "first match". Outside zones, the caller's
 * fallback mu is used and the grade is reported unknown (treated as flat).
 */
export function resolveSurface(point: ZonePoint, zones: PhysicsZone[], fallback: { mu: number; source: ParameterSource }): ResolvedSurface {
  const containing = zones.filter(z => pointInZone(point, z.boundary));
  const muPick = pick('mu', point, containing.filter(z => z.mu !== undefined).map(zone => ({ zone, value: zone.mu! })), (a, b) => a === b);
  const gradePick = pick('уклона', point, containing.flatMap(zone => {
    const g = zoneGradient(zone);
    return g ? [{ zone, value: g }] : [];
  }), (a, b) => a.x === b.x && a.y === b.y);
  return {
    mu: muPick ? muPick.value : fallback.mu,
    muSource: muPick ? muPick.zone.source : fallback.source,
    ...(muPick ? { muZoneId: muPick.zone.id } : {}),
    ...(gradePick ? { grade: { ...gradePick.value, source: gradePick.zone.source }, gradeZoneId: gradePick.zone.id } : {}),
    muKnown: !!muPick,
    gradeKnown: !!gradePick,
    roughness: containing.filter(z => z.roughness).map(z => ({ zoneId: z.id, kind: z.roughness!.kind, effect: 'not-modelled' as const })),
  };
}
