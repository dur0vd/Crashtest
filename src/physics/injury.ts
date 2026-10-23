import { finite } from './parameters';
import { dm } from '../dmath';

/**
 * Published population risk functions. Outputs are probabilities for the study
 * population, not a diagnosis; the degree of harm is established only by forensic
 * medical examination. Protective facts (belts, seats) do not modify these curves.
 */
export interface PublishedCurve {
  id: string;
  outcome: string;
  population: string;
  citation: string;
  url?: string;
  doi?: string;
  limitations: string[];
}

export type OccupantMode = 'all' | 'frontal' | 'nearside' | 'farside' | 'rear';

/**
 * Augenstein J, Perdeck E, Stratton J, Digges K, Bahouth G. Characteristics of
 * crashes that increase the risk of serious injuries. Annu Proc AAAM 2003;47:561–576
 * (PMC3217552). Tables 2–3: P(MAIS3+) = 1/(1+exp(-(b0 + b1*Δv))), Δv total in mph.
 * Published check values at 30 mph: 42.7 % (all), 38.9 % frontal, 83.8 % nearside,
 * 47.8 % farside, 19.9 % rear.
 */
export const AUGENSTEIN_2003: Record<OccupantMode, { b0: number; b1: number }> = {
  all: { b0: -4.1951, b1: 0.1301 },
  frontal: { b0: -4.1373, b1: 0.1228 },
  nearside: { b0: -4.0664, b1: 0.1903 },
  farside: { b0: -4.4873, b1: 0.1466 },
  rear: { b0: -5.665, b1: 0.1424 },
};

export const AUGENSTEIN_2003_META: PublishedCurve = {
  id: 'augenstein-2003-mais3',
  outcome: 'MAIS 3+ (Abbreviated Injury Scale, максимальная по телу ≥3)',
  population: 'NASS/CDS 1995–1999 (и CIREN) США, участники 12 лет и старше на любом месте; общий Δv в милях/ч',
  citation: 'Augenstein J., Perdeck E., Stratton J., Digges K., Bahouth G. Characteristics of crashes that increase the risk of serious injuries. Annu Proc AAAM. 2003;47:561–576, табл. 2–3.',
  url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3217552',
  limitations: [
    'Однопараметрическая модель только от Δv: ремни, подушки, возраст и пол не учтены этими коэффициентами.',
    'Режимы удара в статье не определены через PDOF; соответствие PDOF→режим ниже — явное допущение.',
    'Популяция и парк ТС США 1990-х годов; перенос на другие условия не проверен; диапазон Δv данных в статье не приведён.',
  ],
};

const MPH = 0.44704;
const logistic = (x: number) => 1 / (1 + dm.exp(-x));

/** PDOF (deg, 0 = from the front, clockwise positive) to a crash mode; side needs the occupant side. */
export function modeFromPdof(pdofDeg: number, occupantSide?: 'left' | 'right'): { modes: OccupantMode[]; assumption: string } {
  finite(pdofDeg, 'pdofDeg', -180, 180);
  const a = Math.abs(pdofDeg);
  const assumption = 'Допущение: фронтальный |PDOF| ≤ 45°, задний ≥ 135°, иначе боковой; ближняя/дальняя сторона по месту участника.';
  if (a <= 45) return { modes: ['frontal'], assumption };
  if (a >= 135) return { modes: ['rear'], assumption };
  const struck = pdofDeg > 0 ? 'right' : 'left';
  if (!occupantSide) return { modes: ['nearside', 'farside'], assumption: `${assumption} Сторона места не задана — приведены оба варианта.` };
  return { modes: [occupantSide === struck ? 'nearside' : 'farside'], assumption };
}

export interface RiskValue {
  curveId: string;
  mode?: OccupantMode;
  probability: number | null;
  /** When outside the published anchor range: the bound that is known. */
  bound?: { below?: number; above?: number };
  input: Record<string, number | string>;
  formula: string;
}

export function occupantMais3Risk(deltaVms: number, mode: OccupantMode): RiskValue {
  finite(deltaVms, 'deltaV', 0, 100);
  const c = AUGENSTEIN_2003[mode];
  const mph = deltaVms / MPH;
  return { curveId: AUGENSTEIN_2003_META.id, mode, probability: logistic(c.b0 + c.b1 * mph),
    input: { deltaVMs: deltaVms, deltaVMph: mph }, formula: `P = 1/(1+exp(−(${c.b0} + ${c.b1}·Δv[mph])))` };
}

/**
 * Tefft BC. Impact Speed and a Pedestrian's Risk of Severe Injury or Death.
 * AAA Foundation for Traffic Safety, September 2011, Table 3 (main results).
 * Pedestrians aged 15+, US PCDS 1994–1998, forward-moving cars/light trucks MY 1989–1999,
 * standardised to the 2007–2009 US struck-pedestrian age and vehicle-type distribution.
 * Severe = AIS ≥ 4 or death. The report gives risk levels at speeds, not coefficients.
 */
export const TEFFT_2011 = {
  levels: [0.10, 0.25, 0.50, 0.75, 0.90],
  severe: [16, 23, 31, 39, 46],
  death: [23, 32, 42, 50, 58],
  /** 70-year-old at v ≈ 30-year-old at v + shift (95 % CI), mph. */
  ageShift70vs30: { severe: { mph: 9.3, ci: [5.3, 13.4] }, death: { mph: 10.4, ci: [5.4, 15.4] } },
  /** Light truck at v ≈ car at v + shift (95 % CI), mph. */
  lightTruckShift: { severe: { mph: 6.3, ci: [2.1, 10.6] }, death: { mph: 4.1, ci: [-1.4, 9.5] } },
};

export const TEFFT_2011_META: PublishedCurve = {
  id: 'tefft-2011-pedestrian',
  outcome: 'Тяжёлая травма (AIS ≥ 4 или смерть) либо смерть в течение 30 дней',
  population: 'Пешеходы 15+ лет, удар передом движущегося вперёд легкового/лёгкого грузового ТС, США 1994–1998 (PCDS), стандартизация на 2007–2009',
  citation: 'Tefft B.C. Impact Speed and a Pedestrian\'s Risk of Severe Injury or Death. AAA Foundation for Traffic Safety, сентябрь 2011, табл. 3 (основные результаты).',
  url: 'https://aaafoundation.org/impact-speed-pedestrians-risk-severe-injury-death/',
  limitations: [
    'Опубликованы уровни риска при скоростях (10–90 %), а не коэффициенты модели: между точками — интерполяция по логиту (метод этого кода), вне 10–90 % — только граница.',
    'Средний риск по популяции; для конкретного возраста кривая не опубликована — приводится только эквивалентный сдвиг 70 vs 30 лет.',
    'Дети до 15 лет исключены из выборки: для них оценка не выполняется.',
  ],
};

/** Pedestrian risk at impact speed (m/s) from the Tefft 2011 anchors. */
export function pedestrianRisk(impactSpeedMs: number, outcome: 'severe' | 'death', age?: number): RiskValue | { unsupported: string } {
  finite(impactSpeedMs, 'impactSpeed', 0, 100);
  if (age !== undefined && age < 15) return { unsupported: 'Tefft 2011: пешеходы младше 15 лет не входят в выборку' };
  const speeds = TEFFT_2011[outcome], levels = TEFFT_2011.levels, mph = impactSpeedMs / MPH;
  const input = { impactSpeedMs, impactSpeedMph: mph, ...(age !== undefined ? { age } : {}) };
  const formula = 'logit(P) линейно по скорости между соседними опубликованными точкам (10/25/50/75/90 %)';
  if (mph < speeds[0]) return { curveId: TEFFT_2011_META.id, probability: null, bound: { below: levels[0] }, input, formula };
  if (mph > speeds[speeds.length - 1]) return { curveId: TEFFT_2011_META.id, probability: null, bound: { above: levels[levels.length - 1] }, input, formula };
  const logit = (p: number) => dm.log(p / (1 - p));
  let i = 0;
  while (i < speeds.length - 2 && mph > speeds[i + 1]) i++;
  const f = (mph - speeds[i]) / (speeds[i + 1] - speeds[i]);
  return { curveId: TEFFT_2011_META.id, probability: logistic(logit(levels[i]) + f * (logit(levels[i + 1]) - logit(levels[i]))), input, formula };
}
