import type { ParameterSource } from './types';
import { finite, validateSource } from './parameters';
import { dm } from '../dmath';

/**
 * CRASH3-type crush energy. Per unit width the absorbed energy for residual
 * crush C is e(C) = A*C + B*C²/2 + G with G = A²/(2B) (force per width
 * F/w = A + B*C, starting at the no-damage threshold). With crush measured at
 * N equally spaced points over width w and linear interpolation between them:
 *   E = w/(N-1) * sum_i [ A(Ci+Ci+1)/2 + B(Ci²+Ci*Ci+1+Ci+1²)/6 + G ].
 * For N=6 this equals the familiar
 *   E = w/5 [ A/2(C1+2C2+2C3+2C4+2C5+C6) + B/6(C1²+2C2²+…+C6²+C1C2+…+C5C6) + 5G ].
 * The form is derived here by integration; page-level comparison with the
 * CRASH3 User's Guide and Technical Manual (NHTSA NCSA) is TODO(source-check).
 * No class stiffness table is bundled: Strother et al. (SAE 900101, 1990) report
 * large Δv errors for category coefficients. A and B must come with a source.
 */
export interface StiffnessCoefficients {
  /** N/m (force per unit width at zero residual crush). */
  A: number;
  /** N/m² (force per unit width per metre of crush). */
  B: number;
  source: ParameterSource;
}

export interface CrushProfile {
  /** Damage width, m. */
  width: number;
  /** Residual crush at 2, 4 or 6 equally spaced points across the width, m. */
  crush: number[];
  /** Optional direction of force relative to the damaged surface normal, deg; applies (1+tan²α). */
  forceAngleDeg?: number;
  source: string;
}

export interface CrushEnergyResult {
  method: 'crash3-crush-energy-v1';
  energy: number;
  /** Energy before the optional (1+tan²α) correction, J. */
  energyUncorrected: number;
  G: number;
  correctionFactor: number;
  segments: { from: number; to: number; energy: number }[];
  formula: string;
  units: Record<string, string>;
  sources: string[];
  assumptions: string[];
}

export function validateStiffness(s: StiffnessCoefficients): void {
  finite(s.A, 'A', Number.MIN_VALUE);
  finite(s.B, 'B', Number.MIN_VALUE);
  validateSource(s.source);
}

export function crushEnergy(profile: CrushProfile, stiffness: StiffnessCoefficients): CrushEnergyResult {
  validateStiffness(stiffness);
  finite(profile.width, 'width', Number.MIN_VALUE);
  if (!Array.isArray(profile.crush) || ![2, 4, 6].includes(profile.crush.length)) throw new Error('CRASH3: нужно 2, 4 или 6 значений деформации C');
  profile.crush.forEach((c, i) => finite(c, `C${i + 1}`, 0, 5));
  if (typeof profile.source !== 'string' || !profile.source.trim()) throw new Error('CRASH3: нужен источник замеров деформации');
  const { A, B } = stiffness, G = A * A / (2 * B), C = profile.crush, n = C.length;
  const segWidth = profile.width / (n - 1);
  const segments = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const e = segWidth * (A * (C[i] + C[i + 1]) / 2 + B * (C[i] ** 2 + C[i] * C[i + 1] + C[i + 1] ** 2) / 6 + G);
    segments.push({ from: i * segWidth, to: (i + 1) * segWidth, energy: e });
    total += e;
  }
  let factor = 1;
  const assumptions = [
    'Линейная интерполяция деформации между точками, равный шаг по ширине.',
    'Порог без остаточной деформации заложен в G=A²/(2B); A и B относятся к данной зоне кузова и источнику.',
    'Энергия деформации — не измерение Δv; переход к Δv требует допущений о массах, восстановлении и плече импульса.',
  ];
  if (profile.forceAngleDeg !== undefined) {
    finite(profile.forceAngleDeg, 'forceAngleDeg', -89, 89);
    factor = 1 + dm.tan(profile.forceAngleDeg * Math.PI / 180) ** 2;
    assumptions.push('Поправка (1+tan²α) на косое направление силы относительно нормали поверхности повреждения; пределы применимости по источнику — TODO(source-check).');
  }
  return {
    method: 'crash3-crush-energy-v1', energy: total * factor, energyUncorrected: total, G, correctionFactor: factor, segments,
    formula: 'E = (1+tan²α)·w/(N−1)·Σ[A(Ci+Ci+1)/2 + B(Ci²+CiCi+1+Ci+1²)/6 + A²/(2B)]',
    units: { energy: 'J', A: 'N/m', B: 'N/m²', G: 'N', width: 'm', crush: 'm' },
    sources: [stiffness.source.description, profile.source, 'CRASH3 User\'s Guide and Technical Manual (NHTSA NCSA): форма выведена интегрированием, TODO(source-check)'],
    assumptions,
  };
}

/** Energy equivalent speed, EES = sqrt(2E/m). */
export function energyEquivalentSpeed(energy: number, mass: number): number {
  finite(energy, 'energy', 0);
  finite(mass, 'mass', Number.MIN_VALUE);
  return Math.sqrt(2 * energy / mass);
}

/**
 * Campbell-type linear stiffness from one full-width barrier test:
 * V = b0 + b1*C  =>  b1 = (V-b0)/C,  A = m*b0*b1/w,  B = m*b1²/w.
 * Identity check: w*(A*C + B*C²/2 + A²/(2B)) = m*V²/2.
 */
export function stiffnessFromTest(test: { mass: number; speed: number; noDamageSpeed: number; averageCrush: number; width: number; source: string }): StiffnessCoefficients {
  finite(test.mass, 'mass', Number.MIN_VALUE);
  finite(test.width, 'width', Number.MIN_VALUE);
  finite(test.averageCrush, 'averageCrush', Number.MIN_VALUE);
  finite(test.noDamageSpeed, 'noDamageSpeed', 0);
  finite(test.speed, 'speed', test.noDamageSpeed + 1e-9);
  if (!test.source?.trim()) throw new Error('CRASH3: нужен источник испытания');
  const b1 = (test.speed - test.noDamageSpeed) / test.averageCrush;
  return {
    A: test.mass * test.noDamageSpeed * b1 / test.width,
    B: test.mass * b1 * b1 / test.width,
    source: { kind: 'reference', description: `Жёсткость по испытанию (линейная модель V=b0+b1·C, Campbell 1974, SAE 740565): ${test.source}; b0=${test.noDamageSpeed} м/с — входное допущение.` },
  };
}

/** Effective mass factor for an eccentric impulse: gamma = k²/(k²+h²), k = sqrt(Iz/m). */
export function effectiveMassFactor(mass: number, yawInertia: number, momentArm: number): number {
  finite(mass, 'mass', Number.MIN_VALUE);
  finite(yawInertia, 'yawInertia', Number.MIN_VALUE);
  finite(momentArm, 'momentArm');
  const k2 = yawInertia / mass;
  return k2 / (k2 + momentArm * momentArm);
}

/**
 * Inverse Δv from total absorbed energy with explicit assumptions: collinear
 * impulse through effective masses mi*gamma_i, Newton restitution k (<1):
 *   E = mu_e*vrel²*(1-k²)/2, mu_e = m1e*m2e/(m1e+m2e),
 *   Δv1 = (1+k)*m2e/(m1e+m2e)*vrel, Δv2 = (1+k)*m1e/(m1e+m2e)*vrel.
 * With k=0 and gamma=1: Δv1 = sqrt(2E*m2/(m1(m1+m2))).
 */
export function deltaVFromEnergy(input: { m1: number; m2: number; energy: number; restitution: number; gamma1?: number; gamma2?: number }): {
  closingSpeed: number; deltaV1: number; deltaV2: number; formula: string; assumptions: string[];
} {
  finite(input.m1, 'm1', Number.MIN_VALUE);
  finite(input.m2, 'm2', Number.MIN_VALUE);
  finite(input.energy, 'energy', 0);
  finite(input.restitution, 'restitution', 0, 0.999);
  const g1 = input.gamma1 ?? 1, g2 = input.gamma2 ?? 1;
  finite(g1, 'gamma1', Number.MIN_VALUE, 1);
  finite(g2, 'gamma2', Number.MIN_VALUE, 1);
  const m1 = input.m1 * g1, m2 = input.m2 * g2, k = input.restitution;
  const mu = m1 * m2 / (m1 + m2);
  const vrel = Math.sqrt(2 * input.energy / (mu * (1 - k * k)));
  return {
    closingSpeed: vrel, deltaV1: (1 + k) * m2 / (m1 + m2) * vrel, deltaV2: (1 + k) * m1 / (m1 + m2) * vrel,
    formula: 'vrel = sqrt(2E/(μe(1−k²))), μe = m1e·m2e/(m1e+m2e), Δv1 = (1+k)·m2e/(m1e+m2e)·vrel, mie = γi·mi',
    assumptions: [
      'Импульс по одной линии через эффективные массы; трение в плоскости контакта и вращение после удара учтены только через γ.',
      `Коэффициент восстановления k=${k} задан явно; при k→1 энергия деформации не определяет Δv.`,
      'Вся энергия E — деформация обоих ТС (CRASH3), без потерь на трение в плоскости контакта.',
    ],
  };
}
