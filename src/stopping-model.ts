import { segIntersect, type Vec } from './geom';

/** Established facts; missing booleans remain unknown. SI units throughout. */
export interface StopContext {
  reason?: 'passengers' | 'cargo' | 'rest' | 'other-voluntary' | 'traffic' | 'forced';
  intentional?: boolean;
  durationBeforeStart?: number;
  source?: string;
  signApplicability?: { signId: string; applies: boolean }[];
  side?: 'right' | 'left';
  onShoulder?: boolean; shoulderPresent?: boolean; atCarriagewayEdge?: boolean;
  onCarriageway?: boolean; stoppingProhibited?: boolean;
  rowFromEdge?: number; parallelToEdge?: boolean; twoWheelsWithoutSidecar?: boolean;
  permissibleMaxMass?: number;
  registeredClass?: 'passenger-car' | 'motorcycle' | 'moped' | 'other';
  clearanceMeters?: number;
  visibilityForward?: number; visibilityBackward?: number;
  tramObstructed?: boolean; routeTaxiUnimpeded?: boolean;
  signsSignalsBlocked?: boolean; otherAccessBlocked?: boolean; pedestriansObstructed?: boolean;
  tIntersectionOppositeException?: boolean;
  parkingArrangementComplied?: boolean;
  angularParkingGeometrySuitable?: boolean;
  disabledParkingEligible?: boolean; disabilityBadge?: boolean;
  /** Complete conditions of the 3.28–30 disability exemption, including badge separately. */
  disabilityExemptionEligible?: boolean;
  postalLiveryEligible?: boolean; taxiMeterOn?: boolean;
  relocationMeasuresTaken?: boolean; relocationPossible?: boolean;
  driverLeft?: boolean; rollawaySecured?: boolean; unauthorizedUsePrevented?: boolean;
  childUnder7Present?: boolean; adultPresent?: boolean;
  designatedRestArea?: boolean; outsideRoad?: boolean;
}

/** Use existing crosswalks, sidewalks, tracks, railwayCrossings, routeStops and
 * routeLanes. These polygons cover only additional surveyed local places. */
export interface StopPlace {
  id: string; roadId?: string; boundary: Vec[]; source: string; signIds?: string[];
  kind: 'shoulder' | 'sidewalk-edge' | 'parking' | 'disabled-parking' | 'tunnel' | 'bridge' |
    'under-bridge' | 'dangerous-bend' | 'crest' | 'intersection-carriageways' |
    'bicycle-lane' | 'bicycle-path' | 'bicycle-crossing' | 'pedestrian-ramp' | 'safety-island';
}
export interface WarningContext {
  hazardAvailable?: boolean;
  accident?: boolean; dazzled?: boolean; towedMechanical?: boolean;
  childrenBoardingWithSign?: boolean; otherDanger?: boolean;
  trianglePlaced?: boolean;
  triangle?: Vec & { source: string };
  triangleDistance?: number;
  trianglePromptly?: boolean; timelyWarningEnsured?: boolean; timelyVisibleToOthers?: boolean;
  source?: string;
}
export interface DoorContext {
  opened?: boolean; createsObstruction?: boolean; otherId?: string;
  operator?: 'driver' | 'passenger'; source?: string;
}
export interface StopSignContext {
  roadId?: string;
  /** Surveyed longitudinal zone in authored road coordinates (metres).
   * Required for facade plates 8.2.5/6. Does not bypass side/date/end signs. */
  fromS?: number; toS?: number;
  scheduleDays?: 'working' | 'nonworking' | 'weekdays';
  weekdays?: number[]; // ISO Monday=1, Sunday=7, for 8.5.3/7
  hours?: { from: string; to: string }; // local HH:mm; end exclusive
}

const stopBooleans = ['intentional', 'onShoulder', 'shoulderPresent', 'atCarriagewayEdge', 'onCarriageway',
  'stoppingProhibited', 'parallelToEdge', 'twoWheelsWithoutSidecar', 'tramObstructed', 'routeTaxiUnimpeded', 'signsSignalsBlocked',
  'otherAccessBlocked', 'pedestriansObstructed', 'tIntersectionOppositeException', 'parkingArrangementComplied',
  'angularParkingGeometrySuitable', 'disabledParkingEligible', 'disabilityBadge', 'disabilityExemptionEligible',
  'postalLiveryEligible', 'taxiMeterOn', 'relocationMeasuresTaken', 'relocationPossible', 'driverLeft',
  'rollawaySecured', 'unauthorizedUsePrevented', 'childUnder7Present', 'adultPresent', 'designatedRestArea', 'outsideRoad'] as const;
const warningBooleans = ['hazardAvailable', 'accident', 'dazzled', 'towedMechanical', 'childrenBoardingWithSign',
  'otherDanger', 'trianglePlaced', 'trianglePromptly', 'timelyWarningEnsured', 'timelyVisibleToOthers'] as const;
const stopNumbers = ['durationBeforeStart', 'rowFromEdge', 'permissibleMaxMass', 'clearanceMeters', 'visibilityForward', 'visibilityBackward'] as const;
const enums = { reason: ['passengers', 'cargo', 'rest', 'other-voluntary', 'traffic', 'forced'],
  side: ['left', 'right'], registeredClass: ['passenger-car', 'motorcycle', 'moped', 'other'] };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function clean(v: unknown, bools: readonly string[], nums: readonly string[], strings: readonly string[] = ['source']): Record<string, unknown> {
  const raw = object(v), out: Record<string, unknown> = {};
  for (const key of bools) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  for (const key of nums) if (nonnegative(raw[key])) out[key] = raw[key];
  for (const key of strings) if (typeof raw[key] === 'string') out[key] = raw[key];
  return out;
}
export function normalizeStopContext(v: unknown): StopContext {
  const raw = object(v), out = clean(v, stopBooleans, stopNumbers);
  for (const [key, values] of Object.entries(enums)) if (values.includes(raw[key] as string)) out[key] = raw[key];
  if (out.rowFromEdge !== undefined && (!Number.isInteger(out.rowFromEdge) || Number(out.rowFromEdge) < 1)) delete out.rowFromEdge;
  if (Array.isArray(raw.signApplicability)) out.signApplicability = raw.signApplicability.filter(pair => pair && typeof pair.signId === 'string' && typeof pair.applies === 'boolean').map(pair => ({ signId: pair.signId, applies: pair.applies }));
  return out;
}
export function normalizeWarningContext(v: unknown): WarningContext {
  const out = clean(v, warningBooleans, ['triangleDistance']);
  const triangle = object(object(v).triangle);
  if (Number.isFinite(triangle.x) && Number.isFinite(triangle.y) && typeof triangle.source === 'string' && triangle.source.trim()) out.triangle = { x: triangle.x, y: triangle.y, source: triangle.source };
  return out;
}
export function normalizeDoorContext(v: unknown): DoorContext {
  const raw = object(v), out = clean(v, ['opened', 'createsObstruction'], [], ['source', 'otherId']);
  if (raw.operator === 'driver' || raw.operator === 'passenger') out.operator = raw.operator;
  return out;
}
export function normalizeStopSign(v: unknown): StopSignContext {
  const raw = object(v), out = clean(v, [], ['fromS', 'toS'], ['roadId']);
  if (Array.isArray(raw.weekdays) && raw.weekdays.length && raw.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) out.weekdays = [...new Set(raw.weekdays)];
  if (['working', 'nonworking', 'weekdays'].includes(raw.scheduleDays as string)) out.scheduleDays = raw.scheduleDays;
  const hours = object(raw.hours), valid = (s: unknown) => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
  if (valid(hours.from) && valid(hours.to) && hours.from !== hours.to) out.hours = { from: hours.from, to: hours.to };
  return out;
}
export const STOP_PLACE_KINDS: StopPlace['kind'][] = ['shoulder', 'sidewalk-edge', 'parking', 'disabled-parking', 'tunnel', 'bridge',
  'under-bridge', 'dangerous-bend', 'crest', 'intersection-carriageways', 'bicycle-lane', 'bicycle-path', 'bicycle-crossing', 'pedestrian-ramp', 'safety-island'];
export function normalizeStopPlaces(v: unknown): StopPlace[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(value => {
    const p = object(value);
    if (typeof p.id !== 'string' || !STOP_PLACE_KINDS.includes(p.kind as StopPlace['kind']) || typeof p.source !== 'string' || !p.source.trim()
      || !Array.isArray(p.boundary) || p.boundary.length < 3 || !p.boundary.every(q => q && Number.isFinite(q.x) && Number.isFinite(q.y))) throw new Error('Место остановки: нужны вид, ID, источник и полигон из ≥3 измеренных точек');
    const boundary = p.boundary as Vec[];
    let twiceArea = 0;
    for (let k = 0; k < boundary.length; k++) {
      const next = (k + 1) % boundary.length;
      twiceArea += boundary[k].x * boundary[next].y - boundary[next].x * boundary[k].y;
      for (let j = k + 2; j < boundary.length; j++) {
        if (k === 0 && j === boundary.length - 1) continue;
        if (segIntersect(boundary[k], boundary[next], boundary[j], boundary[(j + 1) % boundary.length])) throw new Error('Контур места остановки не должен пересекать себя');
      }
    }
    if (Math.abs(twiceArea) < 1e-6) throw new Error('Контур места остановки должен иметь ненулевую площадь');
    return { id: p.id, kind: p.kind, source: p.source, boundary: p.boundary.map(q => ({ x: q.x, y: q.y })),
      ...(typeof p.roadId === 'string' ? { roadId: p.roadId } : {}),
      ...(Array.isArray(p.signIds) ? { signIds: p.signIds.filter(id => typeof id === 'string') } : {}) } as StopPlace;
  });
}
