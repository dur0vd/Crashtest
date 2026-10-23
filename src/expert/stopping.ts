import type { CalculationRecord, JsonObject } from '../parallel/contracts';
import type { ExpertValue } from './params';

/**
 * S = v·(t1 + t2 + 0.5·t3) + v²/(2·j)  (SI). The km/h practice form
 * S = V/3.6·(t1+t2+0.5t3) + V²/(26·j) rounds 2·3.6² = 25.92 to 26; it is offered
 * only as an explicit option to reproduce hand calculations — TODO(source-check)
 * for the methodology that prescribes it.
 */
export type Rounding = 'exact' | 'denominator-26';

export function stoppingDistance(v: number, t1: number, t2: number, t3: number, j: number, rounding: Rounding = 'exact'): number {
  for (const [k, x] of Object.entries({ v, t1, t2, t3 })) if (!Number.isFinite(x) || x < 0) throw new Error(`Остановочный путь: неверный ${k}`);
  if (!Number.isFinite(j) || j <= 0) throw new Error('Остановочный путь: j должно быть > 0');
  const T = t1 + t2 + 0.5 * t3;
  return v * T + (rounding === 'exact' ? v * v / (2 * j) : (3.6 * v) ** 2 / (26 * j));
}

/** Highest speed that stops within S: v = j·(−T + sqrt(T² + 2S/j)) (exact form). */
export function safeSpeed(S: number, t1: number, t2: number, t3: number, j: number): number {
  if (!(S >= 0) || !(j > 0)) throw new Error('Безопасная скорость: неверные S или j');
  const T = t1 + t2 + 0.5 * t3;
  return j * (-T + Math.sqrt(T * T + 2 * S / j));
}

export interface AvoidabilityInput {
  /** Speed at the moment of hazard onset, m/s. */
  v0: number;
  /** Distance available from the hazard onset to the conflict point, m. */
  available: number;
  t1: ExpertValue;
  t2: ExpertValue;
  t3: ExpertValue;
  j: ExpertValue;
  rounding?: Rounding;
  /** Which hazard-onset criterion produced v0/available (chosen by the expert). */
  hazardCriterion?: string;
}

export interface AvoidabilityResult {
  verdict: 'could' | 'could-not' | 'depends';
  typical: { S: number; avoidable: boolean };
  best: { S: number; avoidable: boolean };
  worst: { S: number; avoidable: boolean };
  /** t1 at which the typical case turns; null if not reachable for t1 >= 0. */
  boundaryT1: number | null;
  safeSpeed: { typical: number; best: number; worst: number };
  substitution: string;
}

const round = (x: number, d = 3) => String(Math.round(x * 10 ** d) / 10 ** d).replace('.', ',');

export function assessAvoidability(i: AvoidabilityInput): CalculationRecord & { result: AvoidabilityResult & JsonObject } {
  if (!Number.isFinite(i.v0) || i.v0 < 0 || !Number.isFinite(i.available) || i.available < 0) throw new Error('Техвозможность: неверные v0/available');
  const r = i.rounding ?? 'exact';
  const S = (t1: number, t2: number, t3: number, j: number) => stoppingDistance(i.v0, t1, t2, t3, j, r);
  const typical = S(i.t1.value, i.t2.value, i.t3.value, i.j.value);
  const best = S(i.t1.min, i.t2.min, i.t3.min, i.j.max);
  const worst = S(i.t1.max, i.t2.max, i.t3.max, i.j.min);
  const eps = 1e-9;
  const verdict = worst <= i.available + eps ? 'could' : best > i.available + eps ? 'could-not' : 'depends';
  const brakePart = S(0, i.t2.value, i.t3.value, i.j.value);
  const boundaryT1 = i.v0 > 0 && i.available >= brakePart ? (i.available - brakePart) / i.v0 : null;
  const T = i.t1.value + i.t2.value + 0.5 * i.t3.value;
  const substitution = `S = ${round(i.v0)}·(${round(i.t1.value)} + ${round(i.t2.value)} + 0,5·${round(i.t3.value)}) + ${round(i.v0)}²/(${r === 'exact' ? '2' : '26/3,6²'}·${round(i.j.value)}) = ${round(i.v0 * T)} + ${round(typical - i.v0 * T)} = ${round(typical)} м`;
  const result: AvoidabilityResult = {
    verdict,
    typical: { S: typical, avoidable: typical <= i.available + eps },
    best: { S: best, avoidable: best <= i.available + eps },
    worst: { S: worst, avoidable: worst <= i.available + eps },
    boundaryT1,
    safeSpeed: {
      typical: safeSpeed(i.available, i.t1.value, i.t2.value, i.t3.value, i.j.value),
      best: safeSpeed(i.available, i.t1.min, i.t2.min, i.t3.min, i.j.max),
      worst: safeSpeed(i.available, i.t1.max, i.t2.max, i.t3.max, i.j.min),
    },
    substitution,
  };
  const deviations = [i.t1, i.t2, i.t3, i.j].flatMap(v => v.deviation ? [v.deviation] : []);
  return {
    id: 'expert.braking.avoidability', method: 'expert.braking',
    inputs: { v0: i.v0, available: i.available, t1: { ...i.t1 }, t2: { ...i.t2 }, t3: { ...i.t3 }, j: { ...i.j }, rounding: r,
      ...(i.hazardCriterion ? { hazardCriterion: i.hazardCriterion } : {}) } as unknown as JsonObject,
    formula: 'S = v·(t1 + t2 + 0,5·t3) + v²/(2·j); граница t1* = (Sд − v(t2+0,5t3) − v²/(2j))/v; vбез = j(−T + √(T² + 2Sд/j))',
    result: result as AvoidabilityResult & JsonObject,
    units: { v0: 'm/s', available: 'm', t: 's', j: 'm/s²', S: 'm', safeSpeed: 'm/s' },
    sources: [...new Set([i.t1.source, i.t2.source, i.t3.source, i.j.source])],
    assumptions: [
      'Замедление нарастает линейно за t3 (формула с 0,5·t3 завышает путь на j·t3²/24 относительно точного интегрирования).',
      'Лучший случай — минимум времён и максимум j, худший — наоборот; это анализ диапазона, а не вероятность или доверительный интервал.',
      'Момент возникновения опасности выбирает эксперт; правовую оценку выполняет модуль правил.',
      ...deviations,
      ...[i.t1, i.t2, i.t3, i.j].flatMap(v => v.notes),
    ],
  };
}

/**
 * Yellow signal (rule 6.14 is applied by the rules module): service braking with
 * t1–t3 and a service deceleration supplied with its source. Returns the distance
 * needed, the margin to the stop line and the deceleration that would be required.
 */
export function yellowServiceStop(i: { v0: number; distanceToStopLine: number; t1: ExpertValue; t2: ExpertValue; t3: ExpertValue; jService: ExpertValue; rounding?: Rounding }): CalculationRecord {
  const r = i.rounding ?? 'exact';
  const S = stoppingDistance(i.v0, i.t1.value, i.t2.value, i.t3.value, i.jService.value, r);
  const Smin = stoppingDistance(i.v0, i.t1.min, i.t2.min, i.t3.min, i.jService.max, r);
  const Smax = stoppingDistance(i.v0, i.t1.max, i.t2.max, i.t3.max, i.jService.min, r);
  const reaction = i.v0 * (i.t1.value + i.t2.value + 0.5 * i.t3.value);
  const room = i.distanceToStopLine - reaction;
  const requiredDecel = room > 0 ? i.v0 * i.v0 / (2 * room) : null;
  const canStop = Smax <= i.distanceToStopLine ? 'yes' : Smin > i.distanceToStopLine ? 'no' : 'depends';
  return {
    id: 'expert.yellow-service-stop', method: 'expert.braking',
    inputs: { v0: i.v0, distanceToStopLine: i.distanceToStopLine, t1: { ...i.t1 }, t2: { ...i.t2 }, t3: { ...i.t3 }, jService: { ...i.jService }, rounding: r } as unknown as JsonObject,
    formula: 'Sслуж = v·(t1+t2+0,5t3) + v²/(2·jслуж); jтреб = v²/(2(D − v(t1+t2+0,5t3)))',
    result: { serviceStoppingDistance: S, range: [Smin, Smax], margin: i.distanceToStopLine - S, canStopWithServiceBraking: canStop, requiredDeceleration: requiredDecel },
    units: { v0: 'm/s', distance: 'm', deceleration: 'm/s²' },
    sources: [...new Set([i.t1.source, i.t2.source, i.t3.source, i.jService.source])],
    assumptions: [
      'Расчёт служебного торможения — технический вход для п. 6.14; применение нормы (в т.ч. «без экстренного торможения») выполняет модуль правил.',
      'Служебное замедление — входной параметр эксперта с источником, а не константа модели.',
    ],
  };
}
