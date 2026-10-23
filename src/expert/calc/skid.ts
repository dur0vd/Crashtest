import type { JsonObject, JsonValue } from '../../parallel/contracts';
import { type CalcSpec, type Calculator, MissingInput, fmt, guard, optionalNumber, rangeOf, type RangeInput } from './common';

const G = 9.81;

/**
 * Side-slip (lateral) mark: a body sliding to rest dissipates its kinetic energy
 * against friction on each segment: v0 = sqrt(v_end² + 2g·Σ(μi + gi)·Si),
 * gi = grade along the slide (positive uphill). Rotation energy is neglected.
 */
export const skidInputs: CalcSpec[] = [
  { key: 'segments', label: 'Участки следа [{length, mu, grade?}]', kind: 'vector', required: true },
  { key: 'endSpeed', label: 'Скорость в конце следа', unit: 'm/s', kind: 'number', required: false, minimum: 0 },
];

function readSegments(p: JsonObject): { length: RangeInput; mu: RangeInput; grade: number }[] {
  const raw = p.segments;
  if (!Array.isArray(raw) || !raw.length) throw new MissingInput(['segments']);
  return raw.map((s: JsonValue, i) => {
    const o = s as JsonObject;
    const rr = (k: string, lo: number, hi: number): RangeInput => {
      const v = o[k];
      if (typeof v === 'number') return { value: v, min: v, max: v };
      const ob = v as JsonObject | undefined;
      if (!ob || typeof ob.value !== 'number') throw new MissingInput([`segments[${i}].${k}`]);
      const r = { value: ob.value, min: typeof ob.min === 'number' ? ob.min : ob.value, max: typeof ob.max === 'number' ? ob.max : ob.value, ...(typeof ob.source === 'string' ? { source: ob.source } : {}) };
      if ([r.value, r.min, r.max].some(x => x < lo || x > hi) || r.min > r.value || r.value > r.max) throw new Error(`segments[${i}].${k}: неверное значение`);
      return r;
    };
    const grade = typeof o.grade === 'number' ? o.grade : 0;
    if (!Number.isFinite(grade) || Math.abs(grade) > 1) throw new Error(`segments[${i}].grade: неверный уклон`);
    return { length: rr('length', 0, 1000), mu: rr('mu', 0.01, 3), grade };
  });
}

export const skidCalculator: Calculator = {
  id: 'expert.skid', title: 'Скорость по следу бокового скольжения / волочения', inputs: skidInputs,
  run: (p: JsonObject) => guard(skidInputs, p, () => {
    const segs = readSegments(p), vEnd = optionalNumber(p, 'endSpeed', 0, 100) ?? 0;
    const ranges = segs.flatMap(s => [s.length, s.mu]);
    const f = (...xs: number[]) => {
      let e = vEnd * vEnd;
      for (let i = 0; i < segs.length; i++) e += 2 * G * (xs[2 * i + 1] + segs[i].grade) * xs[2 * i];
      return e >= 0 ? Math.sqrt(e) : null;
    };
    const v = f(...ranges.map(r => r.value));
    if (v === null) throw new Error('Подкоренное выражение отрицательно: проверьте уклоны');
    const range = rangeOf(f, ...ranges)!;
    return [{
      id: 'expert.skid.speed', method: 'expert.skid', inputs: { segments: segs, endSpeed: vEnd } as unknown as JsonObject,
      formula: 'v0 = √(vк² + 2g·Σ(μi + ii)·Si)',
      result: { speed: v, speedKmh: v * 3.6, range: [range.min, range.max],
        substitution: `v0 = √(${fmt(vEnd)}² + 2·9,81·(${segs.map(s => `(${fmt(s.mu.value)}${s.grade ? ` + ${fmt(s.grade)}` : ''})·${fmt(s.length.value)}`).join(' + ')})) = ${fmt(v)} м/с` },
      units: { speed: 'm/s', length: 'm', mu: '1', grade: '1' },
      sources: [...new Set(segs.flatMap(s => [s.length.source, s.mu.source].filter((x): x is string => !!x)))],
      assumptions: ['Энергия вращения и удары о неровности не учтены; μ — коэффициент для данного вида скольжения (боком/волоком) с источником.',
        'Диапазон — по крайним значениям входов, не вероятность.'],
    }];
  }),
};
