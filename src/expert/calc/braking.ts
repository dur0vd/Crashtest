import type { CalculationRecord, JsonObject } from '../../parallel/contracts';
import { type CalcSpec, type Calculator, fmt, guard, optionalNumber, rangeOf, readRange, sourcesOf } from './common';
import { assessAvoidability, stoppingDistance } from '../stopping';

/**
 * Speed at the start of braking from the skid-mark length with deceleration rise:
 * v0 = 0.5·j·t3 + sqrt(v_end² + 2·j·S). During t3 the deceleration rises
 * linearly (speed drops by j·t3/2) before the wheels lock and marks begin.
 * km/h form: V = 1.8·t3·j + sqrt(25.92·j·S) for v_end = 0. Derived here; the
 * methodology citation is TODO(source-check).
 */
export const brakingInputs: CalcSpec[] = [
  { key: 'skidLength', label: 'Длина следа юза S', unit: 'm', kind: 'range', required: true, minimum: 0 },
  { key: 'j', label: 'Установившееся замедление j', unit: 'm/s²', kind: 'range', required: true, minimum: 0.01 },
  { key: 't3', label: 'Время нарастания t3', unit: 's', kind: 'range', required: true, minimum: 0 },
  { key: 'endSpeed', label: 'Скорость в конце следа (удар), 0 — остановка', unit: 'm/s', kind: 'number', required: false, minimum: 0 },
  { key: 't1', label: 't1 для остановочного пути (необязательно)', unit: 's', kind: 'range', required: false },
  { key: 't2', label: 't2 для остановочного пути (необязательно)', unit: 's', kind: 'range', required: false },
  { key: 'available', label: 'Расстояние до места конфликта (необязательно)', unit: 'm', kind: 'number', required: false },
];

export const brakingCalculator: Calculator = {
  id: 'expert.braking', title: 'Скорость по тормозному следу с учётом t3 и остановочный путь', inputs: brakingInputs,
  run: (p: JsonObject) => guard(brakingInputs, p, () => {
    const S = readRange(p, 'skidLength', 0, 1000), j = readRange(p, 'j', 0.01, 20), t3 = readRange(p, 't3', 0, 5);
    const vEnd = optionalNumber(p, 'endSpeed', 0, 100) ?? 0;
    const f = (s: number, jj: number, tt: number) => 0.5 * jj * tt + Math.sqrt(vEnd * vEnd + 2 * jj * s);
    const v = f(S.value, j.value, t3.value), range = rangeOf(f, S, j, t3)!;
    const records: CalculationRecord[] = [{
      id: 'expert.braking.skid-speed', method: 'expert.braking',
      inputs: { skidLength: { ...S }, j: { ...j }, t3: { ...t3 }, endSpeed: vEnd } as unknown as JsonObject,
      formula: 'v0 = 0,5·j·t3 + √(vк² + 2·j·S); в км/ч при vк=0: V = 1,8·t3·j + √(25,92·j·S)',
      result: { speed: v, speedKmh: v * 3.6, range: [range.min, range.max], rangeKmh: [range.min * 3.6, range.max * 3.6],
        substitution: `v0 = 0,5·${fmt(j.value)}·${fmt(t3.value)} + √(${fmt(vEnd)}² + 2·${fmt(j.value)}·${fmt(S.value)}) = ${fmt(0.5 * j.value * t3.value)} + ${fmt(Math.sqrt(vEnd * vEnd + 2 * j.value * S.value))} = ${fmt(v)} м/с` },
      units: { speed: 'm/s', speedKmh: 'km/h', skidLength: 'm', j: 'm/s²', t3: 's' },
      sources: [...sourcesOf(S, j, t3), 'Вывод: линейное нарастание замедления за t3 до блокировки; ссылка на методику — TODO(source-check)'],
      assumptions: ['След юза начинается после нарастания замедления (за t3) и соответствует установившемуся замедлению j на всей длине.',
        'Уклон и различие сцепления по длине следа должны быть учтены в j пользователем.', 'Диапазон — по крайним значениям входов, не вероятность.'],
    }];
    if (p.t1 !== undefined && p.t2 !== undefined) {
      const t1 = readRange(p, 't1', 0, 10), t2 = readRange(p, 't2', 0, 5);
      const ev = (r: typeof t1, name: string) => ({ value: r.value, min: r.min, max: r.max, origin: 'override' as const, source: r.source ?? `${name}: источник не указан`, notes: [] });
      const Sstop = stoppingDistance(v, t1.value, t2.value, t3.value, j.value);
      records.push({ id: 'expert.braking.stopping-distance', method: 'expert.braking',
        inputs: { v0: v, t1: { ...t1 }, t2: { ...t2 }, t3: { ...t3 }, j: { ...j } } as unknown as JsonObject,
        formula: 'S = v·(t1 + t2 + 0,5·t3) + v²/(2·j)',
        result: { stoppingDistance: Sstop, substitution: `S = ${fmt(v)}·(${fmt(t1.value)} + ${fmt(t2.value)} + 0,5·${fmt(t3.value)}) + ${fmt(v)}²/(2·${fmt(j.value)}) = ${fmt(Sstop)} м` } as unknown as JsonObject,
        units: { stoppingDistance: 'm' }, sources: sourcesOf(t1, t2, t3, j), assumptions: ['Скорость v — результат расчёта по следу выше.'] });
      const available = optionalNumber(p, 'available', 0, 10000);
      if (available !== undefined) records.push(assessAvoidability({ v0: v, available, t1: ev(t1, 't1'), t2: ev(t2, 't2'), t3: ev(t3, 't3'), j: ev(j, 'j') }));
    }
    return records;
  }),
};
