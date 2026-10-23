import type { Actor } from '../scene';
import type { DynamicState, DynamicVehicleParameters } from './types';
import { finite, validateDynamicParameters } from './parameters';
import { dm } from '../dmath';

/** Also used by actorSpec/normalization: invalid dynamics never silently change mass. */
export function validateActorDynamics(actor: Actor): void {
  if (actor.dynamics === undefined) return;
  validateDynamicParameters(actor.dynamics);
  if (actor.kind !== 'vehicle' || actor.railwayTrain
    || !actor.dynamics.vehicleTypes.some(type => type === actor.type)) {
    throw new Error(`Динамика ${actor.id}: класс не поддерживается выбранными параметрами`);
  }
  if (actor.cargo && actor.cargo.mass !== 0) {
    throw new Error(`Динамика ${actor.id}: масса груза требует отдельного согласованного набора mass/Iz/CG; сложение масс не поддержано`);
  }
}

export type DynamicSupport = { supported: true; parameters: DynamicVehicleParameters }
  | { supported: false; reason: string };

/** No implicit passenger-car substitution for any actor (including a plain car). */
export function dynamicSupport(actor: Actor): DynamicSupport {
  if (!actor.dynamics) return { supported: false, reason: 'Не задан явный набор динамических параметров с источниками' };
  try {
    validateActorDynamics(actor);
    return { supported: true, parameters: structuredClone(actor.dynamics) };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function initialDynamicState(actor: Actor): DynamicState {
  const support = dynamicSupport(actor);
  if (!support.supported) throw new Error(`Динамика ${actor.id}: ${support.reason}`);
  for (const key of ['x', 'y', 'heading', 'speed'] as const) finite(actor[key], key);
  const speed = actor.speed / 3.6;
  return { x: actor.x, y: actor.y, heading: actor.heading, vx: speed * dm.cos(actor.heading),
    vy: speed * dm.sin(actor.heading), yawRate: 0, ax: 0, ay: 0 };
}
