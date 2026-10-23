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

export interface VehiclePhysicsInput {
  braking?: BrakingParameters;
  controller?: Partial<ControllerSettings>;
  hazard?: HazardResponse;
  postImpact?: PostImpactSettings;
  impact?: Partial<ImpactSettings>;
}

/** Options of simulate(scene, options); the port fills them from extensions.physics. */
export interface SimulationOptions {
  zones?: PhysicsZone[];
  vehicles?: Record<string, VehiclePhysicsInput>;
  impact?: ImpactSettings;
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
