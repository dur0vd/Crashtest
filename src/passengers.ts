import type { Actor } from './scene';

/** Facts are constant during the run. undefined means unknown, never false.
 * IDs are local to the vehicle; no names or medical conclusions are stored. */
export interface Passenger {
  id: string;
  age?: number;
  place?: 'front' | 'rear' | 'cab' | 'body' | 'outside' | 'motorcycle-rear' | 'other';
  beltUsed?: boolean;
  helmetFastened?: boolean;
  restraintUsed?: boolean;
  restraintFits?: boolean;
  restraintInstalledCorrectly?: boolean;
  weightKg?: number;
  heightCm?: number;
}
export interface PassengerContext {
  /** Legal class must be established separately, especially for vans. */
  vehicleClass?: 'passenger-car' | 'truck' | 'other';
  beltsProvided?: boolean;
  driverBeltUsed?: boolean;
  driverHelmetFastened?: boolean;
  /** Number of passengers permitted by specification, excluding driver. */
  passengerCapacity?: number;
  /** Years holding A/A1 (motorcycle) or any category (moped). */
  qualifyingLicenseYears?: number;
  boardingWhileMoving?: boolean;
  doorsClosedWhileMoving?: boolean;
  organizedChildren?: boolean;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Additive scene-v1 migration: absence of a list remains unknown, [] means
 * explicitly no passengers. Invalid facts are discarded, not defaulted. */
export function normalizePassengers(a: Actor): void {
  if (a.kind !== 'vehicle' || a.railwayTrain) { delete a.passengers; delete a.passengerContext; return; }
  const raw = record(a.passengerContext);
  delete a.passengerContext;
  if (raw) {
    const c: PassengerContext = {};
    if (['passenger-car', 'truck', 'other'].includes(String(raw.vehicleClass))) c.vehicleClass = raw.vehicleClass as PassengerContext['vehicleClass'];
    for (const key of ['beltsProvided', 'driverBeltUsed', 'driverHelmetFastened', 'boardingWhileMoving', 'doorsClosedWhileMoving', 'organizedChildren'] as const)
      if (typeof raw[key] === 'boolean') c[key] = raw[key];
    if (nonnegative(raw.passengerCapacity) && Number.isInteger(raw.passengerCapacity)) c.passengerCapacity = raw.passengerCapacity;
    if (nonnegative(raw.qualifyingLicenseYears)) c.qualifyingLicenseYears = raw.qualifyingLicenseYears;
    a.passengerContext = c;
  }
  if (!Array.isArray(a.passengers)) { delete a.passengers; return; }
  const ids = new Set<string>();
  a.passengers = a.passengers.flatMap((value, index) => {
    const p = record(value);
    if (!p) return [];
    let id = typeof p.id === 'string' && p.id.trim() ? p.id : `passenger-${index + 1}`;
    while (ids.has(id)) id += '-copy';
    ids.add(id);
    const next: Passenger = { id };
    if (nonnegative(p.age) && Number.isInteger(p.age) && p.age <= 120) next.age = p.age;
    if (['front', 'rear', 'cab', 'body', 'outside', 'motorcycle-rear', 'other'].includes(String(p.place))) next.place = p.place as Passenger['place'];
    for (const key of ['beltUsed', 'helmetFastened', 'restraintUsed', 'restraintFits', 'restraintInstalledCorrectly'] as const)
      if (typeof p[key] === 'boolean') next[key] = p[key];
    for (const key of ['weightKg', 'heightCm'] as const) if (nonnegative(p[key]) && p[key] > 0) next[key] = p[key];
    return [next];
  });
}

/** Inspectable downstream input for stage 09. No injury modifiers or inferred
 * protection, no addition of passenger mass to the existing vehicle model. */
export function passengerFacts(a: Actor) {
  return { passengers: a.passengers === undefined ? null : structuredClone(a.passengers),
    context: a.passengerContext === undefined ? null : structuredClone(a.passengerContext),
    injuryModel: 'not-assessed', protectionCoefficients: null,
    units: { age: 'completed years', weightKg: 'kg', heightCm: 'cm', qualifyingLicenseYears: 'years' } };
}
