import type { DynamicVehicleParameters, ParameterSource } from './types';

export function finite(value: number, name: string, min = -Infinity, max = Infinity): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Динамика: неверный ${name}`);
}

export function validateSource(source: ParameterSource): void {
  if (!source || !['measured', 'reference', 'synthetic'].includes(source.kind)
    || typeof source.description !== 'string' || !source.description.trim()) {
    throw new Error('Динамика: нужны вид и описание источника параметров');
  }
}

/** Fail closed on malformed imported data; do not replace unknowns with catalogue defaults. */
export function validateDynamicParameters(p: DynamicVehicleParameters): void {
  if (!p || p.schemaVersion !== 1 || typeof p.id !== 'string' || !p.id.trim()
    || !p.body || !p.tyres || !p.brakes || !p.drive || !p.loadTransfer
    || !Array.isArray(p.vehicleTypes) || !p.vehicleTypes.length
    || p.vehicleTypes.some(t => !['car', 'suv', 'van', 'truck', 'bus', 'trolleybus'].includes(t))) {
    throw new Error('Динамика: неполный набор параметров версии 1');
  }
  const b = p.body;
  for (const key of ['mass', 'yawInertia', 'length', 'width', 'lf', 'lr', 'trackFront', 'trackRear'] as const) finite(b[key], key, Number.MIN_VALUE);
  finite(b.cgHeight, 'cgHeight', 0);
  finite(b.bodyCenterOffset, 'bodyCenterOffset');
  if (b.lf > b.length / 2 + b.bodyCenterOffset || b.lr > b.length / 2 - b.bodyCenterOffset
    || b.trackFront > b.width || b.trackRear > b.width) throw new Error('Динамика: оси/колея за пределами кузова');
  if (p.tyres.model !== 'dugoff') throw new Error('Динамика: неподдерживаемая модель шин');
  for (const key of ['longitudinalStiffness', 'corneringStiffnessFront', 'corneringStiffnessRear', 'frictionScaleX', 'frictionScaleY'] as const) {
    finite(p.tyres[key], key, Number.MIN_VALUE);
  }
  finite(p.brakes.maxForce, 'brakes.maxForce', 0);
  finite(p.brakes.frontFraction, 'brakes.frontFraction', 0, 1);
  if (!['unknown', 'disabled', 'ideal'].includes(p.brakes.abs)) throw new Error('Динамика: ABS должен быть задан явно');
  finite(p.drive.maxForce, 'drive.maxForce', 0);
  if (!['front', 'rear', 'all'].includes(p.drive.axle)) throw new Error('Динамика: неизвестный привод');
  finite(p.loadTransfer.frontRollFraction, 'frontRollFraction', 0, 1);
  if (p.rollingResistance !== undefined) {
    if (!p.rollingResistance || typeof p.rollingResistance !== 'object') throw new Error('Динамика: неверное сопротивление качению');
    finite(p.rollingResistance.coefficient, 'rollingResistance.coefficient', 0, 1);
    validateSource(p.rollingResistance.source);
  }
  for (const source of [b.source, b.bodyCenterSource, p.tyres.source, p.brakes.source, p.drive.source, p.loadTransfer.source]) validateSource(source);
}

/** Bicycle limit, rad/(m/s²): delta = L/R + K * v²/R. Axle stiffness = 2 * per-tyre stiffness. */
export function understeerGradient(p: DynamicVehicleParameters): number {
  validateDynamicParameters(p);
  const { mass, lf, lr } = p.body;
  return mass / (lf + lr) * (lr / (2 * p.tyres.corneringStiffnessFront) - lf / (2 * p.tyres.corneringStiffnessRear));
}

/** Flat-road, purely lateral force bound, not a rollover or combined-braking guarantee. */
export function lateralGripSpeed(mu: number, radius: number, gravity = 9.81): number {
  finite(mu, 'mu', 0);
  finite(radius, 'radius', Number.MIN_VALUE);
  finite(gravity, 'gravity', Number.MIN_VALUE);
  return Math.sqrt(mu * gravity * radius);
}
