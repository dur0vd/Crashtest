import type { JsonObject } from '../../parallel/contracts';
import { type CalcSpec, type Calculator, fmt, guard, optionalNumber, readRange } from './common';
import { type FrontShape, throwSpeedRange } from '../../physics/pedestrian';

export const throwInputs: CalcSpec[] = [
  { key: 'model', label: 'Модель отброса', kind: 'enum', choices: ['searle', 'wood'], required: true },
  { key: 'distance', label: 'Расстояние от места наезда до тела D', unit: 'm', kind: 'range', required: true, minimum: 0 },
  { key: 'friction', label: 'Коэффициент трения тела о покрытие μ', kind: 'range', required: true, minimum: 0.01 },
  { key: 'launchHeight', label: 'Высота центра масс при вылете h', unit: 'm', kind: 'range', required: true, minimum: 0 },
  { key: 'front', label: 'Форма передка', kind: 'enum', choices: ['low-sedan', 'suv-high', 'flat-truck-bus'], required: true },
  { key: 'vehicleMass', label: 'Масса ТС (Wood)', unit: 'kg', kind: 'number', required: false },
  { key: 'pedestrianMass', label: 'Масса пешехода (Wood)', unit: 'kg', kind: 'number', required: false },
];

export const throwCalculator: Calculator = {
  id: 'expert.throw', title: 'Скорость наезда по отбросу пешехода (Searle / Wood)', inputs: throwInputs,
  run: (p: JsonObject) => guard(throwInputs, p, () => {
    const model = p.model, front = p.front;
    if (model !== 'searle' && model !== 'wood') throw new Error('model: searle или wood');
    if (!['low-sedan', 'suv-high', 'flat-truck-bus'].includes(String(front))) throw new Error('front: low-sedan, suv-high или flat-truck-bus');
    const D = readRange(p, 'distance', 0, 500), mu = readRange(p, 'friction', 0.01, 3), h = readRange(p, 'launchHeight', 0, 5);
    const vehicleMass = optionalNumber(p, 'vehicleMass', 1, 1e6), pedestrianMass = optionalNumber(p, 'pedestrianMass', 1, 500);
    const r = throwSpeedRange({ model, front: front as FrontShape, distance: D, friction: mu, launchHeight: h, vehicleMass, pedestrianMass });
    if ('insufficient' in r) throw new Error(r.insufficient);
    return [{
      id: `expert.throw.${model}`, method: 'expert.throw',
      inputs: { model, front: String(front), distance: { ...D }, friction: { ...mu }, launchHeight: { ...h }, ...(vehicleMass ? { vehicleMass } : {}), ...(pedestrianMass ? { pedestrianMass } : {}) } as unknown as JsonObject,
      formula: r.formula,
      result: { min: r.min, max: r.max, minKmh: r.min * 3.6, maxKmh: r.max * 3.6, nominal: r.nominal, nominalKmh: r.nominal === null ? null : r.nominal * 3.6,
        substitution: `Диапазон ${fmt(r.min * 3.6, 1)}…${fmt(r.max * 3.6, 1)} км/ч по ${r.cases.length} сочетаниям крайних значений D, μ, h`,
        cases: r.cases } as unknown as JsonObject,
      units: { speed: 'm/s', distance: 'm', height: 'm' },
      sources: model === 'wood'
        ? ['Wood (1988) по воспроизведению Soica 2018, IOP Conf. Ser. MSE 444 072017, ур. (2), CC BY 3.0; первоисточник — TODO(source-check)', ...[D.source, mu.source, h.source].filter((x): x is string => !!x)]
        : ['Searle: вывод в docs/PHYSICS.md §09; форма при h=0 — Becker, Reade, Scurlock, arXiv:1512.00790, ур. 33; SAE 831622/930659 — TODO(source-check)', ...[D.source, mu.source, h.source].filter((x): x is string => !!x)],
      assumptions: [r.assumption, 'Расстояние D — от места наезда до конечного положения тела; место наезда устанавливается по следам (этап 11).',
        'Диапазон — по крайним значениям входов и угла вылета, не вероятность.'],
    }];
  }),
};
