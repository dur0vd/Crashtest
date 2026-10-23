import { finite } from './parameters';
import { GRAVITY } from './dynamics';
import { dm } from '../dmath';

/**
 * Walking-speed reference values. Only verified entries are bundled; anything
 * else (children, running, Russian expert-practice tables) must be entered by
 * the user with a source, e.g. a measured on-scene experiment.
 * Knoblauch R.L., Pietrucha M.T., Nitzburg M. Field studies of pedestrian walking
 * speed and start-up time. Transportation Research Record 1538 (1996) 27–38
 * (abstract, TRID 469376): 15th-percentile walking speed 1.25 m/s (ages 14–64)
 * and 0.97 m/s (65+); design values 1.22 and 0.91 m/s.
 */
export const KNOBLAUCH_1996 = {
  citation: 'Knoblauch R.L., Pietrucha M.T., Nitzburg M. Field studies of pedestrian walking speed and start-up time. Transportation Research Record 1538, 1996, pp. 27–38 (аннотация TRID 469376).',
  url: 'https://trid.trb.org/View/469376',
  population: 'Пешеходы на 16 регулируемых переходах в 4 городах США; возраст оценён визуально',
  values: [
    { ageGroup: '14-64' as const, statistic: '15th-percentile' as const, speed: 1.25 },
    { ageGroup: '65+' as const, statistic: '15th-percentile' as const, speed: 0.97 },
    { ageGroup: '14-64' as const, statistic: 'design' as const, speed: 1.22 },
    { ageGroup: '65+' as const, statistic: 'design' as const, speed: 0.91 },
  ],
  limitations: [
    '15-й процентиль и проектные значения для переходов, не средний темп и не бег.',
    'Дети до 14 лет, бег и быстрый шаг в этом источнике не приведены — вводятся пользователем с источником.',
    'Таблицы отечественной экспертной практики не подтверждены по первоисточнику: TODO(source-check).',
  ],
};

export type PaceQuery = { age: number; gait: 'walk' | 'fast-walk' | 'run'; statistic: '15th-percentile' | 'design' };

/** Returns a bundled value only when the source covers the request; never extrapolates. */
export function pedestrianPace(q: PaceQuery): { speed: number; source: string; limitations: string[] } | { unsupported: string } {
  finite(q.age, 'age', 0, 120);
  if (q.gait !== 'walk') return { unsupported: 'Быстрый шаг и бег в подключённом источнике не приведены; задайте измеренный темп с источником.' };
  if (q.age < 14) return { unsupported: 'Темп детей до 14 лет в подключённом источнике не приведён; задайте измеренный темп с источником.' };
  const group = q.age >= 65 ? '65+' : '14-64';
  const v = KNOBLAUCH_1996.values.find(e => e.ageGroup === group && e.statistic === q.statistic)!;
  return { speed: v.speed, source: KNOBLAUCH_1996.citation, limitations: KNOBLAUCH_1996.limitations };
}

/**
 * Point-mass throw (Searle model). Launch at speed v and angle theta from height h:
 * flight without drag, a landing impulse that removes mu*|vz| of the horizontal
 * speed (if less than that speed), then sliding at mu*g. Derived here:
 *   s = v²(cosθ + μ sinθ)²/(2μg) + μh   when v cosθ > μ·sqrt(v²sin²θ + 2gh);
 * otherwise the body stops at landing and s = v cosθ·t_flight.
 * For h=0 this is v = sqrt(2μgs)/(cosθ+μ sinθ) as derived by Becker, Reade and
 * Scurlock (arXiv:1512.00790, 2015, eq. 33, "Searle equation"), with the sliding
 * boundary tanθ = 1/μ (59° for μ=0.6, their eq. 47 text). Searle's originals
 * (SAE 831622, 1983; SAE 930659, 1993) were not read: TODO(source-check).
 */
export interface ThrowPhases {
  launchSpeed: number;
  launchAngle: number;
  launchHeight: number;
  friction: number;
  flightTime: number;
  flightDistance: number;
  landingSpeedVertical: number;
  horizontalAfterLanding: number;
  slideDistance: number;
  slideTime: number;
  total: number;
  slides: boolean;
}

export function searleThrow(v: number, theta: number, mu: number, h = 0, g = GRAVITY): ThrowPhases {
  finite(v, 'v', 0, 100);
  finite(theta, 'theta', -Math.PI / 2, Math.PI / 2);
  finite(mu, 'mu', Number.MIN_VALUE, 3);
  finite(h, 'h', 0, 5);
  const vx = v * dm.cos(theta), vz0 = v * dm.sin(theta);
  const vz = Math.sqrt(vz0 * vz0 + 2 * g * h);
  const tf = (vz0 + vz) / g;
  const flight = vx * tf;
  const after = vx - mu * vz;
  const slides = after > 0;
  const slide = slides ? after * after / (2 * mu * g) : 0;
  return { launchSpeed: v, launchAngle: theta, launchHeight: h, friction: mu, flightTime: tf, flightDistance: flight,
    landingSpeedVertical: vz, horizontalAfterLanding: Math.max(0, after), slideDistance: slide, slideTime: slides ? after / (mu * g) : 0,
    total: flight + slide, slides };
}

/** Launch speed for a given total distance and angle (sliding branch), Searle form with height. */
export function searleLaunchSpeed(distance: number, theta: number, mu: number, h = 0, g = GRAVITY): number | null {
  finite(distance, 'distance', 0, 500);
  const reduced = distance - mu * h;
  if (reduced <= 0) return null;
  const v = Math.sqrt(2 * mu * g * reduced) / (dm.cos(theta) + mu * dm.sin(theta));
  // Valid only if the sliding condition holds for this solution.
  return searleThrow(v, theta, mu, h, g).slides ? v : null;
}

/**
 * Searle bounds over launch angle: minimum at tanθ=μ, v_min = sqrt(2μg(s−μh)/(1+μ²));
 * v = sqrt(2μg(s−μh)) at θ=0 and θ=2·atan μ (bound of the sliding branch used here).
 */
export function searleSpeedRange(distance: number, mu: number, h = 0, g = GRAVITY): { min: number; max: number; minAngle: number; maxAngleRange: [number, number] } | null {
  finite(mu, 'mu', Number.MIN_VALUE, 3);
  const reduced = distance - mu * h;
  if (reduced <= 0) return null;
  const base = Math.sqrt(2 * mu * g * reduced);
  return { min: base / Math.sqrt(1 + mu * mu), max: base, minAngle: dm.atan(mu), maxAngleRange: [0, 2 * dm.atan(mu)] };
}

/**
 * Wood (1988) single-segment formula as reproduced by Soica (2018), IOP Conf. Ser.
 * Mater. Sci. Eng. 444 072017, eq. (2), CC BY 3.0, citing Stevenson (2006):
 *   V = (m_v + m_p)/m_v · sqrt(2μg(D − μh)).
 * It equals a horizontal (θ=0) Searle launch of the pedestrian at the common
 * velocity of a plastic impact. Primary text (Proc IMechE D 202:101–110) not read:
 * TODO(source-check). Soica's eq. (4) prints "D + μh" for Searle with height, which
 * contradicts the derivation above (D − μh); the derivation is used here.
 */
export function woodImpactSpeed(distance: number, mu: number, h: number, vehicleMass: number, pedestrianMass: number, g = GRAVITY): number | null {
  finite(distance, 'distance', 0, 500);
  finite(mu, 'mu', Number.MIN_VALUE, 3);
  finite(h, 'h', 0, 5);
  finite(vehicleMass, 'vehicleMass', Number.MIN_VALUE);
  finite(pedestrianMass, 'pedestrianMass', Number.MIN_VALUE);
  const reduced = distance - mu * h;
  if (reduced <= 0) return null;
  return (vehicleMass + pedestrianMass) / vehicleMass * Math.sqrt(2 * mu * g * reduced);
}

export function woodThrowDistance(impactSpeed: number, mu: number, h: number, vehicleMass: number, pedestrianMass: number, g = GRAVITY): number {
  finite(impactSpeed, 'impactSpeed', 0, 100);
  const vp = impactSpeed * vehicleMass / (vehicleMass + pedestrianMass);
  return vp * vp / (2 * mu * g) + mu * h;
}

/** Front shape determines the assumption about the launch angle, not invented numbers. */
export type FrontShape = 'low-sedan' | 'suv-high' | 'flat-truck-bus';

export interface ThrowInverseInput {
  model: 'searle' | 'wood';
  /** Distance from the impact point to the rest position of the body, m (with range). */
  distance: { value: number; min?: number; max?: number };
  /** Body–road friction (sliding/tumbling) with range; must be sourced by the caller. */
  friction: { value: number; min?: number; max?: number };
  /** Launch height of the body CG, m. */
  launchHeight: { value: number; min?: number; max?: number };
  front: FrontShape;
  vehicleMass?: number;
  pedestrianMass?: number;
}

export interface ThrowInverseResult {
  /** Range of the vehicle impact speed (m/s) implied by the model and the input ranges. */
  min: number;
  max: number;
  nominal: number | null;
  assumption: string;
  formula: string;
  cases: { distance: number; friction: number; height: number; min: number; max: number }[];
}

const corners = (r: { value: number; min?: number; max?: number }) => [...new Set([r.min ?? r.value, r.value, r.max ?? r.value])];

/** Inverse problem: range of impact speed from throw distance and parameter ranges (corner evaluation). */
export function throwSpeedRange(input: ThrowInverseInput): ThrowInverseResult | { insufficient: string } {
  const flat = input.front === 'flat-truck-bus';
  if (input.model === 'wood' && (!input.vehicleMass || !input.pedestrianMass)) return { insufficient: 'Для формулы Wood нужны массы ТС и пешехода' };
  const cases: ThrowInverseResult['cases'] = [];
  for (const d of corners(input.distance)) for (const mu of corners(input.friction)) for (const h of corners(input.launchHeight)) {
    if (input.model === 'wood') {
      const v = woodImpactSpeed(d, mu, h, input.vehicleMass!, input.pedestrianMass!);
      if (v !== null) cases.push({ distance: d, friction: mu, height: h, min: v, max: v });
    } else {
      const r = searleSpeedRange(d, mu, h);
      if (!r) continue;
      // Flat front: forward projection, theta = 0 (single value); otherwise theta unknown -> Searle range.
      cases.push({ distance: d, friction: mu, height: h, min: flat ? r.max : r.min, max: r.max });
    }
  }
  if (!cases.length) return { insufficient: 'Расстояние отброса не больше μ·h: формула неприменима' };
  const nominal = input.model === 'wood'
    ? woodImpactSpeed(input.distance.value, input.friction.value, input.launchHeight.value, input.vehicleMass!, input.pedestrianMass!)
    : flat ? searleSpeedRange(input.distance.value, input.friction.value, input.launchHeight.value)?.max ?? null : null;
  return {
    min: Math.min(...cases.map(c => c.min)), max: Math.max(...cases.map(c => c.max)), nominal, cases,
    assumption: input.model === 'wood'
      ? 'Wood: пластический удар (общая скорость), горизонтальный вылет из центра масс на высоте h; скорость ТС = (mТС+mп)/mТС·скорость тела.'
      : flat ? 'Плоский передок (грузовик/автобус): отбрасывание вперёд, угол вылета принят 0°; скорость тела отождествлена со скоростью удара ТС.'
        : 'Низкий/средний передок: угол вылета не установлен — диапазон Searle по углу 0…2·atan μ; скорость тела отождествлена со скоростью удара ТС (без поправки на массы).',
    formula: input.model === 'wood' ? 'V = (mv+mp)/mv·sqrt(2μg(D−μh))' : 'v = sqrt(2μg(D−μh))/(cosθ+μ sinθ); vmin = sqrt(2μg(D−μh)/(1+μ²))',
  };
}

/** Two-wheeler or rider sliding to rest from speed v with friction mu: s = v²/(2μg). */
export function slideDistance(speed: number, mu: number, g = GRAVITY): number {
  finite(speed, 'speed', 0, 100);
  finite(mu, 'mu', Number.MIN_VALUE, 3);
  return speed * speed / (2 * mu * g);
}
