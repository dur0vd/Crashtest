import type { ControllerSettings, HazardResponse } from './controller';
import type { PhysicsZone } from './zones';
import type { ParameterSource } from './types';
import { finite, validateSource } from './parameters';

/**
 * A value with its documented range. `value` is the typical/selected value used
 * in a single run; min/max feed range calculations. Nothing is inferred when absent.
 */
export interface RangedValue {
  value?: number;
  min?: number;
  max?: number;
  source: string;
}

/** extensions.physics.vehicles[id].braking: t1/t2/t3 in s, j in m/s². */
export interface BrakingParameters {
  t1?: RangedValue;
  t2?: RangedValue;
  t3?: RangedValue;
  j?: RangedValue;
}

/** After the first impact the driver no longer controls the vehicle (explicit assumption). */
export interface PostImpactSettings {
  /** free: rolling wheels; locked: all wheels Coulomb-locked; per-wheel FL, FR, RL, RR. */
  wheels: 'free' | 'locked' | [boolean, boolean, boolean, boolean];
  /** Road-wheel steering after impact, rad; undefined keeps the angle at impact. */
  steering?: number;
  source: ParameterSource;
}

export const DEFAULT_POST_IMPACT_SOURCE: ParameterSource = {
  kind: 'synthetic',
  description: 'Допущение по умолчанию: после удара водитель не управляет, колёса катятся свободно, руль сохраняет угол в момент удара.',
};

/** Contact parameters for the planar impulse model (stage 08). */
export interface ImpactSettings {
  /** Newton restitution along the contact normal, 0..1. */
  restitution: number;
  /** Coulomb friction in the contact plane; undefined = full (sticking) tangential impulse. */
  contactFriction?: number;
  source: ParameterSource;
}

/**
 * Line barriers (extensions.physics.barriers). guardrail: rigid thin body
 * (0.2 m wide geometric model) contacting the vehicle body. curb: line acting on
 * wheel contact points only; mounting/overriding the curb is NOT modelled.
 */
export interface Barrier {
  id: string;
  kind: 'curb' | 'guardrail';
  points: { x: number; y: number }[];
  restitution: number;
  contactFriction?: number;
  source: ParameterSource;
}

export function validateBarrier(b: Barrier): void {
  if (!b || typeof b.id !== 'string' || !b.id.trim() || !['curb', 'guardrail'].includes(b.kind)) throw new Error('Преграда: нужен id и вид curb/guardrail');
  if (!Array.isArray(b.points) || b.points.length < 2 || b.points.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) throw new Error(`Преграда ${b.id}: нужна ломаная из ≥2 точек`);
  finite(b.restitution, `${b.id}.restitution`, 0, 1);
  if (b.contactFriction !== undefined) finite(b.contactFriction, `${b.id}.contactFriction`, 0, 5);
  validateSource(b.source);
}

export interface VehiclePhysicsInput {
  braking?: BrakingParameters;
  controller?: Partial<ControllerSettings>;
  hazard?: HazardResponse;
  postImpact?: PostImpactSettings;
  impact?: Partial<ImpactSettings>;
}

/**
 * Post-impact model of a pedestrian or two-wheeler (dynamic mode). All values are
 * explicit inputs with a source; absent input keeps the legacy free-motion model.
 */
export interface VulnerableBodyInput {
  /** Pedestrian: contact is instantaneous (carry phase not timed), then flight from launchHeight at launchAngle, landing, slide. */
  throw?: { launchAngle: number; launchHeight: number; friction: number; source: ParameterSource };
  /**
   * Two-wheeler: the fallen vehicle slides with vehicleFriction; the rider separates
   * (momentum conserved) with the pre- or post-impact velocity, flies from
   * riderLaunchHeight horizontally and slides with riderFriction.
   */
  twoWheeler?: {
    vehicleFriction: number;
    riderFriction: number;
    riderMass: number;
    riderLaunchHeight: number;
    riderSeparation: 'pre-impact-velocity' | 'post-impact-velocity';
    source: ParameterSource;
  };
}

export function validateVulnerable(v: VulnerableBodyInput | undefined): void {
  if (!v) return;
  if (v.throw) {
    finite(v.throw.launchAngle, 'throw.launchAngle', -Math.PI / 4, Math.PI / 2 - 0.01);
    finite(v.throw.launchHeight, 'throw.launchHeight', 0, 5);
    finite(v.throw.friction, 'throw.friction', 0.01, 3);
    validateSource(v.throw.source);
  }
  if (v.twoWheeler) {
    const t = v.twoWheeler;
    finite(t.vehicleFriction, 'vehicleFriction', 0.01, 3);
    finite(t.riderFriction, 'riderFriction', 0.01, 3);
    finite(t.riderMass, 'riderMass', 1, 400);
    finite(t.riderLaunchHeight, 'riderLaunchHeight', 0, 5);
    if (!['pre-impact-velocity', 'post-impact-velocity'].includes(t.riderSeparation)) throw new Error('riderSeparation: pre-impact-velocity или post-impact-velocity');
    validateSource(t.source);
  }
}

/** Options of simulate(scene, options); the port fills them from extensions.physics. */
export interface SimulationOptions {
  zones?: PhysicsZone[];
  barriers?: Barrier[];
  vehicles?: Record<string, VehiclePhysicsInput>;
  /** Pedestrians and two-wheelers by actor id (stage 09). */
  vulnerable?: Record<string, VulnerableBodyInput>;
  /** Vehicle–vehicle and vehicle–obstacle contact; default k=0.12 (legacy value), full impact. */
  impact?: ImpactSettings;
  /** Vehicle–pedestrian/two-wheeler contact; default plastic (k=0), full impact. */
  vulnerableImpact?: ImpactSettings;
  /** Fixed substep, s; must divide 25 ms; default 5 ms. For convergence checks only. */
  substepSeconds?: number;
}

export function validateRanged(name: string, r: RangedValue | undefined, lo = 0, hi = Infinity): void {
  if (r === undefined) return;
  if (!r || typeof r.source !== 'string' || !r.source.trim()) throw new Error(`${name}: нужен источник значения`);
  for (const key of ['value', 'min', 'max'] as const) if (r[key] !== undefined) finite(r[key]!, `${name}.${key}`, lo, hi);
  if (r.min !== undefined && r.max !== undefined && r.min > r.max) throw new Error(`${name}: min > max`);
  if (r.value !== undefined && (r.min !== undefined && r.value < r.min || r.max !== undefined && r.value > r.max)) {
    throw new Error(`${name}: значение вне заданного диапазона`);
  }
}

export function validateBraking(b: BrakingParameters | undefined): void {
  if (!b) return;
  validateRanged('t1', b.t1, 0, 10);
  validateRanged('t2', b.t2, 0, 5);
  validateRanged('t3', b.t3, 0, 5);
  validateRanged('j', b.j, 0.01, 20);
}

export function validatePostImpact(p: PostImpactSettings | undefined): void {
  if (!p) return;
  const w = p.wheels;
  if (!(w === 'free' || w === 'locked' || Array.isArray(w) && w.length === 4 && w.every(v => typeof v === 'boolean'))) {
    throw new Error('После удара: wheels — free, locked или четыре логических значения');
  }
  if (p.steering !== undefined) finite(p.steering, 'postImpact.steering', -Math.PI / 3, Math.PI / 3);
  validateSource(p.source);
}

export function validateImpact(i: ImpactSettings): void {
  finite(i.restitution, 'restitution', 0, 1);
  if (i.contactFriction !== undefined) finite(i.contactFriction, 'contactFriction', 0, 5);
  validateSource(i.source);
}
