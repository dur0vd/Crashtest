import { finite } from './parameters';

export interface DugoffInput {
  /** Travel-oriented (R*omega - |Vx|)/|Vx|, > -1 (rolling); negative while braking. */
  kappa: number;
  /** Vy / |Vx| in wheel frame. Reverse changes longitudinal force sign only. */
  tanAlpha: number;
  direction: 1 | -1;
  normalLoad: number;
  muX: number;
  muY: number;
  longitudinalStiffness: number;
  corneringStiffness: number;
}

/**
 * Constant-mu Dugoff brush envelope, not a clipped linear tyre.
 * qx=Cx*kappa/(1+kappa), qy=-Ca*tan(alpha)/(1+kappa).
 * lambda=1/(2*hypot(qx/(muX*Fz), qy/(muY*Fz))); f=lambda*(2-lambda) below 1.
 * See docs/PHYSICS.md for the slip-convention conversion and source caveats.
 * Anisotropic ellipse is an explicit extension of the isotropic Dugoff circle.
 */
export function dugoffTyre(i: DugoffInput): { fx: number; fy: number; lambda: number | null; ellipseUse: number } {
  finite(i.kappa, 'kappa', -1 + Number.EPSILON);
  finite(i.tanAlpha, 'tanAlpha');
  finite(i.normalLoad, 'normalLoad', 0);
  finite(i.muX, 'muX', 0);
  finite(i.muY, 'muY', 0);
  finite(i.longitudinalStiffness, 'longitudinalStiffness', Number.MIN_VALUE);
  finite(i.corneringStiffness, 'corneringStiffness', Number.MIN_VALUE);
  if (i.direction !== 1 && i.direction !== -1) throw new Error('Динамика: неверное направление шины');
  if (!i.normalLoad || !i.muX || !i.muY) return { fx: 0, fy: 0, lambda: null, ellipseUse: 0 };
  // Scale both elastic forces by (1+kappa) before evaluating the norm. This
  // avoids overflow near wheel lock without altering the nonlinear formula.
  const qx = i.longitudinalStiffness * i.kappa;
  const qy = -i.corneringStiffness * i.tanAlpha;
  const norm = Math.hypot(qx / (i.muX * i.normalLoad), qy / (i.muY * i.normalLoad));
  if (!norm) return { fx: 0, fy: 0, lambda: null, ellipseUse: 0 };
  const lambda = (1 + i.kappa) / (2 * norm);
  const gain = lambda < 1 ? (1 - lambda / 2) / norm : 1 / (1 + i.kappa);
  const fx = i.direction * qx * gain;
  const fy = qy * gain;
  return { fx, fy, lambda, ellipseUse: Math.hypot(fx / (i.muX * i.normalLoad), fy / (i.muY * i.normalLoad)) };
}

/** Exact inverse of the pure-slip Dugoff envelope for |force| < capacity. */
export function elasticDemand(force: number, capacity: number): number {
  finite(capacity, 'capacity', Number.MIN_VALUE);
  finite(force, 'force', -capacity, capacity);
  if (Math.abs(force) >= capacity) throw new Error('Динамика: предел Dugoff достигается только асимптотически');
  const a = Math.abs(force);
  return Math.sign(force) * (a <= capacity / 2 ? a : capacity * capacity / (4 * (capacity - a)));
}

/** Locked contact: maximum-dissipation Coulomb ellipse, independent of steering. */
export function lockedTyre(vx: number, vy: number, normalLoad: number, muX: number, muY: number): { fx: number; fy: number } {
  for (const [name, value] of Object.entries({ vx, vy, normalLoad, muX, muY })) finite(value, name);
  if (normalLoad < 0 || muX < 0 || muY < 0) throw new Error('Динамика: отрицательная нагрузка/сцепление');
  // Normalise before products/division: subnormal velocities must not amplify
  // a rounding error into a force outside the ellipse near a complete stop.
  const speedScale = Math.max(Math.abs(vx), Math.abs(vy));
  if (!speedScale) return { fx: 0, fy: 0 };
  const nx = vx / speedScale, ny = vy / speedScale;
  const denominator = Math.hypot(muX * nx, muY * ny);
  if (!denominator) return { fx: 0, fy: 0 };
  return { fx: -normalLoad * muX ** 2 * nx / denominator, fy: -normalLoad * muY ** 2 * ny / denominator };
}
