import type { CalculationRecord, JsonObject } from '../../parallel/contracts';
import { type CalcSpec, type Calculator, MissingInput, fmt, guard, optionalNumber, readNumber } from './common';
import { crushEnergy, deltaVFromEnergy, energyEquivalentSpeed, stiffnessFromTest } from '../../physics/crash3';

/**
 * EES from CRASH3-type crush energy (or a given energy) and, for two vehicles,
 * closing speed and Δv with explicit restitution/effective-mass assumptions.
 */
export const eesInputs: CalcSpec[] = [
  { key: 'vehicles', label: 'ТС: [{mass, crush[2|4|6], width, A, B, stiffnessSource | test{...}, forceAngleDeg?, energy?}]', kind: 'vector', required: true },
  { key: 'restitution', label: 'Коэффициент восстановления (для Δv)', kind: 'number', required: false },
];

export const eesCalculator: Calculator = {
  id: 'expert.ees', title: 'Энергия деформации CRASH3, EES и Δv', inputs: eesInputs,
  run: (p: JsonObject) => guard(eesInputs, p, () => {
    const list = p.vehicles;
    if (!Array.isArray(list) || !list.length || list.length > 2) throw new MissingInput(['vehicles']);
    const items = list.map((raw, i) => {
      const o = raw as JsonObject;
      const mass = readNumber(o, 'mass', 1, 1e6);
      if (typeof o.energy === 'number') return { mass, energy: o.energy, record: null as null | ReturnType<typeof crushEnergy>, source: typeof o.energySource === 'string' ? o.energySource : `vehicles[${i}].energy` };
      if (!Array.isArray(o.crush) || typeof o.width !== 'number') throw new MissingInput([`vehicles[${i}].crush`, `vehicles[${i}].width`]);
      let stiffness;
      if (typeof o.A === 'number' && typeof o.B === 'number') {
        if (typeof o.stiffnessSource !== 'string' || !o.stiffnessSource.trim()) throw new MissingInput([`vehicles[${i}].stiffnessSource`]);
        stiffness = { A: o.A, B: o.B, source: { kind: 'reference' as const, description: o.stiffnessSource } };
      } else if (o.test && typeof o.test === 'object') {
        const t = o.test as JsonObject;
        stiffness = stiffnessFromTest({ mass: readNumber(t, 'mass', 1, 1e6), speed: readNumber(t, 'speed', 0, 100), noDamageSpeed: readNumber(t, 'noDamageSpeed', 0, 20),
          averageCrush: readNumber(t, 'averageCrush', 0.001, 5), width: readNumber(t, 'width', 0.1, 10), source: String(t.source ?? '') });
      } else throw new MissingInput([`vehicles[${i}].A|B|test`]);
      const rec = crushEnergy({ width: o.width, crush: o.crush as number[], source: String(o.crushSource ?? `vehicles[${i}].crush`),
        ...(typeof o.forceAngleDeg === 'number' ? { forceAngleDeg: o.forceAngleDeg } : {}) }, stiffness);
      return { mass, energy: rec.energy, record: rec, source: stiffness.source.description };
    });
    const records: CalculationRecord[] = items.map((it, i) => ({
      id: `expert.ees.vehicle${i + 1}`, method: 'expert.ees',
      inputs: { mass: it.mass, energySource: it.source, ...(it.record ? { crush: (list[i] as JsonObject).crush, width: (list[i] as JsonObject).width } : { energy: it.energy }) } as unknown as JsonObject,
      formula: it.record ? `${it.record.formula}; EES = √(2E/m)` : 'EES = √(2E/m)',
      result: { energy: it.energy, ees: energyEquivalentSpeed(it.energy, it.mass), eesKmh: energyEquivalentSpeed(it.energy, it.mass) * 3.6,
        ...(it.record ? { G: it.record.G, segments: it.record.segments, correctionFactor: it.record.correctionFactor } : {}),
        substitution: `EES = √(2·${fmt(it.energy, 0)}/${fmt(it.mass, 0)}) = ${fmt(energyEquivalentSpeed(it.energy, it.mass))} м/с` } as unknown as JsonObject,
      units: { energy: 'J', ees: 'm/s' }, sources: it.record ? it.record.sources : [it.source],
      assumptions: it.record ? it.record.assumptions : ['Энергия задана пользователем.'],
    }));
    if (items.length === 2) {
      const k = optionalNumber(p, 'restitution', 0, 0.999) ?? 0;
      const dv = deltaVFromEnergy({ m1: items[0].mass, m2: items[1].mass, energy: items[0].energy + items[1].energy, restitution: k });
      records.push({ id: 'expert.ees.delta-v', method: 'expert.ees',
        inputs: { m1: items[0].mass, m2: items[1].mass, energy: items[0].energy + items[1].energy, restitution: k } as unknown as JsonObject,
        formula: dv.formula,
        result: { closingSpeed: dv.closingSpeed, deltaV1: dv.deltaV1, deltaV2: dv.deltaV2,
          substitution: `vсбл = ${fmt(dv.closingSpeed)} м/с; Δv1 = ${fmt(dv.deltaV1)} м/с; Δv2 = ${fmt(dv.deltaV2)} м/с` } as unknown as JsonObject,
        units: { speed: 'm/s' }, sources: records.flatMap(r => r.sources), assumptions: dv.assumptions });
    }
    return records;
  }),
};
