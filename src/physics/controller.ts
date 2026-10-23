import type { ParameterSource } from './types';
import { finite, validateSource } from './parameters';
import { dm } from '../dmath';

/** Planar point; local type avoids a dependency on the scene geometry module. */
export interface CtrlPoint { x: number; y: number }

const wrap = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/**
 * Numerical tracking controller settings. These are tuning values of the
 * simulated driver/controller, NOT measured driver properties; they appear in
 * every trace and can be overridden per actor (extensions.physics.vehicles.*.controller).
 */
export interface ControllerSettings {
  method: 'pure-pursuit' | 'stanley';
  /** Pure pursuit lookahead Ld=clamp(min+gain*|v|, min, max): m, s, m. */
  lookaheadMin: number;
  lookaheadGain: number;
  lookaheadMax: number;
  /** Stanley cross-track gain k (1) and softening speed ks (m/s). */
  stanleyGain: number;
  stanleySoftening: number;
  /** Steering-angle limit (rad) and rate limit (rad/s) at the road wheels. */
  maxSteer: number;
  steerRate: number;
  /** Proportional speed loop, 1/s: a_cmd = gain*(v_plan - v) + dv_plan/dt. */
  speedGain: number;
  /** Planned acceleration and decelerations of the intent profile, m/s². */
  plannedAccel: number;
  serviceDecel: number;
  stopDecel: number;
  /** Distance from a stop waypoint within which coming to rest counts as reaching it, m. */
  stopTolerance: number;
  source: ParameterSource;
}

export const CONTROLLER_TUNING_SOURCE: ParameterSource = {
  kind: 'synthetic',
  description: 'Настройка численного регулятора (не измерение водителя): lookahead 4 м + 0,6 с·v (≤30 м), руль ≤0,6 рад и ≤0,8 рад/с, P-контур скорости 1,5 1/с, допуск остановки 0,5 м.',
};

/** Default tuning; planned accel/decel are filled from the legacy class profile by the caller. */
export function defaultController(planned: { accel: number; serviceDecel: number; stopDecel: number }, source?: ParameterSource): ControllerSettings {
  return {
    method: 'pure-pursuit', lookaheadMin: 4, lookaheadGain: 0.6, lookaheadMax: 30,
    stanleyGain: 1.5, stanleySoftening: 1, maxSteer: 0.6, steerRate: 0.8, speedGain: 1.5,
    plannedAccel: planned.accel, serviceDecel: planned.serviceDecel, stopDecel: planned.stopDecel,
    stopTolerance: 0.5, source: source ?? { ...CONTROLLER_TUNING_SOURCE },
  };
}

export function validateController(c: ControllerSettings): void {
  if (!c || !['pure-pursuit', 'stanley'].includes(c.method)) throw new Error('Регулятор: метод pure-pursuit или stanley');
  finite(c.lookaheadMin, 'lookaheadMin', 0.1, 200);
  finite(c.lookaheadGain, 'lookaheadGain', 0, 10);
  finite(c.lookaheadMax, 'lookaheadMax', c.lookaheadMin, 500);
  finite(c.stanleyGain, 'stanleyGain', 0, 100);
  finite(c.stanleySoftening, 'stanleySoftening', 0.01, 100);
  finite(c.maxSteer, 'maxSteer', 0.01, Math.PI / 3);
  finite(c.steerRate, 'steerRate', 0.01, 20);
  finite(c.speedGain, 'speedGain', 0.01, 50);
  finite(c.plannedAccel, 'plannedAccel', 0, 20);
  finite(c.serviceDecel, 'serviceDecel', 0.01, 20);
  finite(c.stopDecel, 'stopDecel', 0.01, 20);
  finite(c.stopTolerance, 'stopTolerance', 0.01, 10);
  validateSource(c.source);
}

/**
 * Pure pursuit, Coulter (1992) CMU-RI-TR-92-01 §2: curvature 2*sin(alpha)/Ld of
 * the arc through the rear axle tangent to the body axis; delta=atan(L*kappa).
 * Reverse: the rear axle leads; the travel-frame curvature maps to -tan(delta)/L.
 */
export function purePursuitSteer(rearAxle: CtrlPoint, heading: number, target: CtrlPoint, wheelbase: number, reverse: boolean): { steering: number; alpha: number; lookahead: number } {
  const dx = target.x - rearAxle.x, dy = target.y - rearAxle.y;
  const ld = dm.hypot(dx, dy);
  if (ld < 1e-9) return { steering: 0, alpha: 0, lookahead: 0 };
  const travel = reverse ? heading + Math.PI : heading;
  const alpha = wrap(dm.atan2(dy, dx) - travel);
  const curvature = 2 * dm.sin(alpha) / ld;
  const steering = dm.atan(wheelbase * curvature) * (reverse ? -1 : 1);
  return { steering, alpha, lookahead: ld };
}

/**
 * Stanley, Hoffmann et al. (2007) / Thrun et al. (2006): delta = psi_e + atan(k*e/(ks+v)).
 * e is the signed offset of the front axle, positive to the right of the path
 * tangent; psi_e = path heading - body heading. Forward travel only.
 */
export function stanleySteer(heading: number, pathHeading: number, crossTrack: number, speed: number, gain: number, softening: number): { steering: number; headingError: number } {
  const headingError = wrap(pathHeading - heading);
  return { steering: headingError - dm.atan(gain * crossTrack / (softening + Math.abs(speed))), headingError };
}

export function lookahead(c: ControllerSettings, speed: number): number {
  return Math.min(c.lookaheadMax, Math.max(c.lookaheadMin, c.lookaheadMin + c.lookaheadGain * Math.abs(speed)));
}

/** Rate- and range-limited steering update over dt seconds. */
export function limitSteer(current: number, target: number, c: ControllerSettings, dt: number): number {
  const step = c.steerRate * dt;
  const next = current + Math.max(-step, Math.min(step, target - current));
  return Math.max(-c.maxSteer, Math.min(c.maxSteer, next));
}

/**
 * Brake actuator: pure delay t2 and a linear rise over t3 from the moment the
 * delayed command becomes positive: b(t)=b_cmd(t-t2)*min(1,(t-t_on)/t3).
 * With a constant target this gives deceleration rising linearly to j over t3,
 * the assumption behind S=v*(t1+t2+0.5*t3)+v²/(2j) (exact: minus j*t3²/24).
 * Zero t2/t3 is an explicitly ideal actuator, never an implied measurement.
 */
export interface BrakeTiming {
  lag: number;
  rise: number;
  source: ParameterSource;
}

export class BrakeActuator {
  private history: { t: number; brake: number }[] = [];
  private onset: number | null = null;
  private last = 0;
  constructor(readonly timing: BrakeTiming) {
    finite(timing.lag, 't2', 0, 5);
    finite(timing.rise, 't3', 0, 5);
    validateSource(timing.source);
  }
  /** Record a command issued at time t (piecewise constant until the next one). */
  command(t: number, brake: number): void {
    finite(brake, 'brake', 0, 1);
    const prev = this.history[this.history.length - 1];
    if (prev && Math.abs(prev.t - t) < 1e-12) prev.brake = brake;
    else this.history.push({ t, brake });
    // Keep only what can still be read with the delay.
    while (this.history.length > 2 && this.history[1].t <= t - this.timing.lag - 1) this.history.shift();
  }
  private delayed(t: number): number {
    const tau = t - this.timing.lag + 1e-12;
    let value = 0;
    for (const h of this.history) if (h.t <= tau) value = h.brake; else break;
    return value;
  }
  /** Applied brake fraction at time t; call with non-decreasing t. */
  applied(t: number): number {
    const b = this.delayed(t);
    if (b <= 0) {
      this.onset = null;
      this.last = 0;
      return 0;
    }
    if (this.onset === null) this.onset = t;
    const ramp = this.timing.rise > 0 ? Math.min(1, (t - this.onset) / this.timing.rise) : 1;
    this.last = b * ramp;
    return this.last;
  }
  get current(): number {
    return this.last;
  }
}

/** Established hazard response (the moment itself is an expert/user input, not derived here). */
export interface HazardResponse {
  /** Moment of hazard onset, s from simulation start. */
  at: number;
  /** Driver reaction time, s. */
  reaction: number;
  /** Target steady deceleration j, m/s². */
  deceleration: number;
  /** Keep tracking the path or hold the wheel during braking. */
  steering: 'track' | 'hold';
  source: ParameterSource;
}

export function validateHazard(h: HazardResponse): void {
  finite(h.at, 'hazard.at', 0);
  finite(h.reaction, 'hazard.reaction', 0, 10);
  finite(h.deceleration, 'hazard.deceleration', 0.01, 20);
  if (!['track', 'hold'].includes(h.steering)) throw new Error('Регулятор: hazard.steering — track или hold');
  validateSource(h.source);
}
