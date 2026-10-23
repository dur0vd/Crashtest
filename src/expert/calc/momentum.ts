import type { JsonObject, JsonValue } from '../../parallel/contracts';
import { type CalcSpec, type Calculator, MissingInput, fmt, guard } from './common';

const G = 9.81;

interface VehicleInput {
  mass: number;
  /** Direction of the pre-impact velocity, rad (project heading convention). */
  approachAngle: number;
  /** Post-impact velocity: speed or slide distance with friction, and its direction. */
  postSpeed?: number;
  postSlide?: { distance: number; mu: number };
  postAngle: number;
}

/**
 * Planar linear momentum: m1·v1·d1 + m2·v2·d2 = m1·u1 + m2·u2, with known
 * pre-impact directions di and post-impact velocities ui (from post-impact
 * slide: u = sqrt(2μgs)). Solved by Cramer's rule; collinear directions are
 * ill-conditioned and reported. Sensitivity by numerical partial derivatives.
 */
export const momentumInputs: CalcSpec[] = [
  { key: 'vehicles', label: 'Два ТС: [{mass, approachAngle, postSpeed | postSlide{distance, mu}, postAngle}]', kind: 'vector', required: true },
  { key: 'angleUncertainty', label: 'Погрешность направлений', unit: 'rad', kind: 'number', required: false },
  { key: 'speedUncertainty', label: 'Относительная погрешность скоростей после удара', kind: 'number', required: false },
];

function readVehicles(p: JsonObject): [VehicleInput, VehicleInput] {
  const raw = p.vehicles;
  if (!Array.isArray(raw) || raw.length !== 2) throw new MissingInput(['vehicles']);
  return raw.map((r: JsonValue, i) => {
    const o = r as JsonObject;
    for (const k of ['mass', 'approachAngle', 'postAngle']) if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) throw new MissingInput([`vehicles[${i}].${k}`]);
    const slide = o.postSlide as JsonObject | undefined;
    if (typeof o.postSpeed !== 'number' && !(slide && typeof slide.distance === 'number' && typeof slide.mu === 'number')) throw new MissingInput([`vehicles[${i}].postSpeed|postSlide`]);
    if ((o.mass as number) <= 0) throw new Error(`vehicles[${i}].mass > 0`);
    return { mass: o.mass as number, approachAngle: o.approachAngle as number, postAngle: o.postAngle as number,
      ...(typeof o.postSpeed === 'number' ? { postSpeed: o.postSpeed } : { postSlide: { distance: slide!.distance as number, mu: slide!.mu as number } }) };
  }) as [VehicleInput, VehicleInput];
}

export function solveMomentum(v: [VehicleInput, VehicleInput]) {
  const u = v.map(x => x.postSpeed ?? Math.sqrt(2 * x.postSlide!.mu * G * x.postSlide!.distance));
  const P = { x: v[0].mass * u[0] * Math.cos(v[0].postAngle) + v[1].mass * u[1] * Math.cos(v[1].postAngle),
    y: v[0].mass * u[0] * Math.sin(v[0].postAngle) + v[1].mass * u[1] * Math.sin(v[1].postAngle) };
  const d1 = { x: Math.cos(v[0].approachAngle), y: Math.sin(v[0].approachAngle) }, d2 = { x: Math.cos(v[1].approachAngle), y: Math.sin(v[1].approachAngle) };
  const det = d1.x * d2.y - d1.y * d2.x;
  const v1 = (P.x * d2.y - P.y * d2.x) / (det * v[0].mass);
  const v2 = (d1.x * P.y - d1.y * P.x) / (det * v[1].mass);
  return { v1, v2, u, P, det };
}

export const momentumCalculator: Calculator = {
  id: 'expert.momentum', title: 'Скорости до удара по закону сохранения импульса (2D)', inputs: momentumInputs,
  run: (p: JsonObject) => guard(momentumInputs, p, () => {
    const v = readVehicles(p);
    const base = solveMomentum(v);
    if (Math.abs(base.det) < Math.sin(5 * Math.PI / 180)) throw new Error('Направления до удара почти коллинеарны (|sin| < sin 5°): система плохо обусловлена, нужен иной метод (энергия/CRASH3)');
    const da = typeof p.angleUncertainty === 'number' ? p.angleUncertainty : 0, ds = typeof p.speedUncertainty === 'number' ? p.speedUncertainty : 0;
    // Linear sensitivity: worst-case sum of |∂v/∂x|·Δx over all inputs.
    const perturb = (f: (c: [VehicleInput, VehicleInput]) => void) => { const c = structuredClone(v); f(c); return solveMomentum(c); };
    const terms: { input: string; dv1: number; dv2: number }[] = [];
    if (da > 0) for (const [i, k] of [[0, 'approachAngle'], [1, 'approachAngle'], [0, 'postAngle'], [1, 'postAngle']] as const) {
      const r = perturb(c => { c[i][k] += da; });
      terms.push({ input: `vehicles[${i}].${k}`, dv1: Math.abs(r.v1 - base.v1), dv2: Math.abs(r.v2 - base.v2) });
    }
    if (ds > 0) for (const i of [0, 1] as const) {
      const r = perturb(c => { c[i].postSpeed = base.u[i] * (1 + ds); delete c[i].postSlide; });
      terms.push({ input: `vehicles[${i}].postSpeed`, dv1: Math.abs(r.v1 - base.v1), dv2: Math.abs(r.v2 - base.v2) });
    }
    const e1 = terms.reduce((s, t) => s + t.dv1, 0), e2 = terms.reduce((s, t) => s + t.dv2, 0);
    const ke = (m: number, s: number) => m * s * s / 2;
    return [{
      id: 'expert.momentum', method: 'expert.momentum', inputs: { vehicles: v, angleUncertainty: da, speedUncertainty: ds } as unknown as JsonObject,
      formula: 'm1·v1·d1 + m2·v2·d2 = m1·u1 + m2·u2 = P; v1 = (P×d2)/(m1·(d1×d2)), v2 = (d1×P)/(m2·(d1×d2)); u = √(2μgs)',
      result: { v1: base.v1, v2: base.v2, v1Kmh: base.v1 * 3.6, v2Kmh: base.v2 * 3.6, postSpeeds: base.u, momentum: base.P,
        bounds: { v1: [base.v1 - e1, base.v1 + e1], v2: [base.v2 - e2, base.v2 + e2] }, sensitivity: terms,
        energyBefore: ke(v[0].mass, base.v1) + ke(v[1].mass, base.v2), energyAfter: ke(v[0].mass, base.u[0]) + ke(v[1].mass, base.u[1]),
        diagram: { P: base.P, pre: [{ x: v[0].mass * base.v1 * Math.cos(v[0].approachAngle), y: v[0].mass * base.v1 * Math.sin(v[0].approachAngle) },
          { x: v[1].mass * base.v2 * Math.cos(v[1].approachAngle), y: v[1].mass * base.v2 * Math.sin(v[1].approachAngle) }],
          post: v.map((x, i) => ({ x: x.mass * base.u[i] * Math.cos(x.postAngle), y: x.mass * base.u[i] * Math.sin(x.postAngle) })) },
        substitution: `v1 = ${fmt(base.v1)} м/с (${fmt(base.v1 * 3.6, 1)} км/ч), v2 = ${fmt(base.v2)} м/с (${fmt(base.v2 * 3.6, 1)} км/ч)` } as unknown as JsonObject,
      units: { speed: 'm/s', mass: 'kg', momentum: 'kg m/s', angle: 'rad', energy: 'J' },
      sources: ['Закон сохранения импульса системы двух тел (внешние импульсы за время удара пренебрежимы)'],
      assumptions: ['Направления скоростей до удара известны (по следам/траекториям); импульс шин за время удара не учтён.',
        'Скорости после удара по длине послеударного перемещения: u=√(2μgs) — допущение равнозамедленного скольжения без вращения.',
        'Границы — линейная оценка чувствительности (сумма модулей), не доверительный интервал; энергия до ≥ после — проверка согласованности.'],
    }];
  }),
};
