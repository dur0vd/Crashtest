/**
 * Validation (stage 17): does CRASH3 crush energy, as implemented in
 * src/physics/crash3.ts, reproduce measured barrier impact speeds of real
 * vehicles it was not fitted on?
 *
 * Data: NHTSA rigid flat frontal barrier tests (tools/fetch-validation-data.mjs;
 * not committed). Method: vehicles are grouped by test mass; within a group,
 * leave-one-out — Campbell's linear model V = b0 + b1·C̄ is fitted by least
 * squares on the other vehicles (b0 constrained to ≥ 0), converted to A/B by
 * stiffnessFromTest, and the held-out vehicle's six-point profile gives
 * EES = √(2E/m) through crushEnergy. EES is compared with the measured speed.
 * Without the data file the test is skipped and the report says "not run".
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { crushEnergy, energyEquivalentSpeed, stiffnessFromTest } from '../../src/physics';

const DATA = 'tests/validation/data/nhtsa-frontal-rigid.json';
/** Acceptance targets fixed before the first run (project criterion, not a
 * literature value — TODO(source-check) for a published CRASH3 accuracy). */
export const TARGET_MEAN_ABS_REL = 0.15;
export const TARGET_P90_ABS_REL = 0.30;
const MASS_CLASSES = [[0, 1300], [1300, 1600], [1600, 1900], [1900, 2300], [2300, 10000]] as const;
const MIN_TRAINING = 5;

interface Rec { testNo: number; make: string; model: string; modelYear: number; testWeightKg: number; speedKmh: number; widthMm: number; indentationLengthMm: number | null; profileMm: number[] }
/** Six equally spaced points: trapezoidal mean crush (written here, independent of crash3.ts). */
const meanCrush = (c: number[]) => (c[0] / 2 + c[1] + c[2] + c[3] + c[4] + c[5] / 2) / 5;
const damageWidth = (r: Rec) => (r.indentationLengthMm && r.indentationLengthMm > 0 ? r.indentationLengthMm : r.widthMm) / 1000;

function fit(points: { c: number; v: number }[]): { b0: number; b1: number } {
  const n = points.length, sc = points.reduce((s, p) => s + p.c, 0), sv = points.reduce((s, p) => s + p.v, 0);
  const scc = points.reduce((s, p) => s + p.c * p.c, 0), scv = points.reduce((s, p) => s + p.c * p.v, 0);
  const b1 = (n * scv - sc * sv) / (n * scc - sc * sc), b0 = (sv - b1 * sc) / n;
  return b0 >= 0 ? { b0, b1 } : { b0: 0, b1: scv / scc };
}
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };

const run = existsSync(DATA);
describe('валидация CRASH3 по открытым испытаниям NHTSA', () => {
  it.skipIf(!run)('EES по профилю деформации против измеренной скорости удара о жёсткий барьер (leave-one-out по классам массы)', () => {
    const data = JSON.parse(readFileSync(DATA, 'utf8')) as { retrieved: string; source: string; records: Rec[] };
    const rows: { testNo: number; vehicle: string; massKg: number; measuredKmh: number; eesKmh: number; errKmh: number; rel: number; baselineRel: number; cls: string }[] = [];
    for (const [lo, hi] of MASS_CLASSES) {
      const group = data.records.filter(r => r.testWeightKg >= lo && r.testWeightKg < hi);
      if (group.length < MIN_TRAINING + 1) continue;
      for (const held of group) {
        const training = group.filter(r => r !== held).map(r => ({ c: meanCrush(r.profileMm) / 1000, v: r.speedKmh / 3.6 }));
        // Naive baseline that ignores deformation: the mean training speed.
        const baselineKmh = training.reduce((a, p) => a + p.v, 0) / training.length * 3.6;
        const { b0, b1 } = fit(training);
        const cRef = 0.3;
        const stiffness = stiffnessFromTest({ mass: held.testWeightKg, speed: b0 + b1 * cRef, noDamageSpeed: b0, averageCrush: cRef,
          width: damageWidth(held), source: `класс ${lo}–${hi} кг, LOO без испытания ${held.testNo}` });
        const e = crushEnergy({ width: damageWidth(held), crush: held.profileMm.map(c => c / 1000), source: `NHTSA test ${held.testNo}` }, stiffness);
        const ees = energyEquivalentSpeed(e.energy, held.testWeightKg) * 3.6;
        rows.push({ testNo: held.testNo, vehicle: `${held.make} ${held.model} ${held.modelYear}`, massKg: held.testWeightKg, measuredKmh: held.speedKmh,
          eesKmh: ees, errKmh: ees - held.speedKmh, rel: (ees - held.speedKmh) / held.speedKmh, baselineRel: (baselineKmh - held.speedKmh) / held.speedKmh, cls: `${lo}–${hi}` });
      }
    }
    expect(rows.length).toBeGreaterThan(50);
    const absRel = rows.map(r => Math.abs(r.rel));
    const metrics = {
      n: rows.length, meanAbsRel: absRel.reduce((a, b) => a + b, 0) / rows.length, p90AbsRel: quantile(absRel, 0.9),
      biasKmh: rows.reduce((a, r) => a + r.errKmh, 0) / rows.length,
      rmseKmh: Math.sqrt(rows.reduce((a, r) => a + r.errKmh ** 2, 0) / rows.length),
      maxAbsKmh: Math.max(...rows.map(r => Math.abs(r.errKmh))),
      baselineMeanAbsRel: rows.reduce((a, r) => a + Math.abs(r.baselineRel), 0) / rows.length,
    };
    const byClass = Object.fromEntries([...new Set(rows.map(r => r.cls))].map(c => {
      const g = rows.filter(r => r.cls === c);
      return [c, { n: g.length, meanAbsRel: g.reduce((a, r) => a + Math.abs(r.rel), 0) / g.length, biasKmh: g.reduce((a, r) => a + r.errKmh, 0) / g.length }];
    }));
    const out = process.env.VALIDATION_OUT;
    if (out) writeFileSync(out, JSON.stringify({ id: 'crash3-nhtsa-frontal', source: data.source, retrieved: data.retrieved, records: data.records.length,
      targets: { meanAbsRel: TARGET_MEAN_ABS_REL, p90AbsRel: TARGET_P90_ABS_REL }, metrics, byClass, rows }, null, 1));
    expect(metrics.meanAbsRel).toBeLessThanOrEqual(TARGET_MEAN_ABS_REL);
    expect(metrics.p90AbsRel).toBeLessThanOrEqual(TARGET_P90_ABS_REL);
    // The deformation must carry information: clearly better than ignoring it.
    expect(metrics.meanAbsRel).toBeLessThan(0.75 * metrics.baselineMeanAbsRel);
  });
});
