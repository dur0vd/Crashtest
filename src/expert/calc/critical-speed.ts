import type { JsonObject } from '../../parallel/contracts';
import { type CalcSpec, type Calculator, fmt, guard, optionalNumber, rangeOf, readRange, sourcesOf } from './common';

const G = 9.81;

/**
 * Critical speed on an arc (yaw mark): R from chord C and middle ordinate M,
 * R = C²/(8M) + M/2 (circle geometry); centre-of-mass radius Rcg = R − offset
 * when the mark is a wheel track (offset = half track, user input);
 * v = sqrt(g·R·(μ + e)/(1 − μ·e)) with superelevation e (flat: v = sqrt(μgR)).
 * Lateral force limit only: no rollover, no combined braking.
 */
export const criticalInputs: CalcSpec[] = [
  { key: 'radius', label: 'Радиус R (либо хорда и стрела)', unit: 'm', kind: 'range', required: false, minimum: 0 },
  { key: 'chord', label: 'Хорда C', unit: 'm', kind: 'range', required: false, minimum: 0 },
  { key: 'middleOrdinate', label: 'Стрела M', unit: 'm', kind: 'range', required: false, minimum: 0 },
  { key: 'mu', label: 'Коэффициент поперечного сцепления μ', kind: 'range', required: true, minimum: 0.01 },
  { key: 'superelevation', label: 'Поперечный уклон e (вираж, положительный к центру)', kind: 'number', required: false },
  { key: 'cgOffset', label: 'Смещение следа от траектории ЦМ к наружи (половина колеи)', unit: 'm', kind: 'number', required: false },
];

export const criticalSpeedCalculator: Calculator = {
  id: 'expert.critical-speed', title: 'Критическая скорость на дуге', inputs: criticalInputs,
  run: (p: JsonObject) => guard(criticalInputs, p, () => {
    const mu = readRange(p, 'mu', 0.01, 3), e = optionalNumber(p, 'superelevation', -0.5, 0.5) ?? 0, off = optionalNumber(p, 'cgOffset', 0, 3) ?? 0;
    let radius: { value: number; min: number; max: number; source?: string };
    let geometry = '';
    if (p.radius !== undefined) radius = readRange(p, 'radius', 0.1, 1e5);
    else {
      const C = readRange(p, 'chord', 0.1, 1e4), M = readRange(p, 'middleOrdinate', 0.001, 1e3);
      const Rf = (c: number, m: number) => c * c / (8 * m) + m / 2;
      const rr = rangeOf(Rf, C, M)!;
      radius = { value: Rf(C.value, M.value), min: rr.min, max: rr.max, source: [C.source, M.source].filter(Boolean).join('; ') || undefined };
      geometry = `R = ${fmt(C.value)}²/(8·${fmt(M.value)}) + ${fmt(M.value)}/2 = ${fmt(radius.value)} м; `;
    }
    if (1 - mu.max * e <= 0) throw new Error('μ·e ≥ 1: формула неприменима');
    const f = (r: number, m: number) => { const R = r - off; return R > 0 ? Math.sqrt(G * R * (m + e) / (1 - m * e)) : null; };
    const v = f(radius.value, mu.value);
    if (v === null) throw new Error('Радиус ЦМ не положителен');
    const range = rangeOf(f, radius, mu)!;
    return [{
      id: 'expert.critical-speed', method: 'expert.critical-speed',
      inputs: { radius: { ...radius }, mu: { ...mu }, superelevation: e, cgOffset: off } as unknown as JsonObject,
      formula: 'R = C²/(8M) + M/2; Rцм = R − смещение; v = √(g·Rцм·(μ + e)/(1 − μ·e))',
      result: { speed: v, speedKmh: v * 3.6, range: [range.min, range.max], radius: radius.value,
        substitution: `${geometry}v = √(9,81·${fmt(radius.value - off)}·(${fmt(mu.value)} + ${fmt(e)})/(1 − ${fmt(mu.value)}·${fmt(e)})) = ${fmt(v)} м/с` },
      units: { speed: 'm/s', radius: 'm' }, sources: sourcesOf(radius, mu),
      assumptions: ['Предел поперечной силы шин на дуге постоянного радиуса; опрокидывание, торможение и переходные процессы не учтены.',
        'Радиус по хорде и стреле — геометрия окружности; измерения следа и μ — с источниками пользователя.'],
    }];
  }),
};
