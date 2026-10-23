import { type Distribution, mulberry32, percentile, quantile, sample, validateDistribution } from './rng';
import { stoppingDistance } from '../expert/stopping';
import { searleLaunchSpeed, woodImpactSpeed } from './pedestrian';

export type ModelOutput = Record<string, number | boolean | null>;

export interface MonteCarloModel {
  id: string;
  title: string;
  inputs: string[];
  outputs: string[];
  /** Numeric output used for the tornado chart when not specified. */
  tornadoOutput: string;
  run(x: Record<string, number>): ModelOutput;
}

const G = 9.81;

/** Built-in pure models; the worker receives only their id and JSON specs. */
export const MC_MODELS: Record<string, MonteCarloModel> = {
  'expert.braking': {
    id: 'expert.braking', title: 'Остановочный путь и техническая возможность',
    inputs: ['v0', 'available', 't1', 't2', 't3', 'j'], outputs: ['stoppingDistance', 'margin', 'avoidable'], tornadoOutput: 'margin',
    run: x => { const S = stoppingDistance(x.v0, x.t1, x.t2, x.t3, x.j); return { stoppingDistance: S, margin: x.available - S, avoidable: S <= x.available }; },
  },
  'expert.braking.skid-speed': {
    id: 'expert.braking.skid-speed', title: 'Скорость по следу юза с t3',
    inputs: ['skidLength', 'j', 't3'], outputs: ['speed'], tornadoOutput: 'speed',
    run: x => ({ speed: 0.5 * x.j * x.t3 + Math.sqrt(2 * x.j * x.skidLength) }),
  },
  'expert.critical-speed': {
    id: 'expert.critical-speed', title: 'Критическая скорость на дуге',
    inputs: ['radius', 'mu', 'superelevation'], outputs: ['speed'], tornadoOutput: 'speed',
    run: x => ({ speed: 1 - x.mu * x.superelevation > 0 ? Math.sqrt(G * x.radius * (x.mu + x.superelevation) / (1 - x.mu * x.superelevation)) : null }),
  },
  'expert.throw.searle': {
    id: 'expert.throw.searle', title: 'Скорость вылета тела по Searle',
    inputs: ['distance', 'friction', 'launchHeight', 'launchAngle'], outputs: ['speed'], tornadoOutput: 'speed',
    run: x => ({ speed: searleLaunchSpeed(x.distance, x.launchAngle, x.friction, x.launchHeight) }),
  },
  'expert.throw.wood': {
    id: 'expert.throw.wood', title: 'Скорость наезда по Wood',
    inputs: ['distance', 'friction', 'launchHeight', 'vehicleMass', 'pedestrianMass'], outputs: ['speed'], tornadoOutput: 'speed',
    run: x => ({ speed: woodImpactSpeed(x.distance, x.friction, x.launchHeight, x.vehicleMass, x.pedestrianMass) }),
  },
};

export interface MonteCarloSpec {
  model: string;
  inputs: Record<string, Distribution>;
  n?: number;
  seed: number;
  percentiles?: number[];
  tornadoOutput?: string;
}

export interface OutputSummary {
  kind: 'numeric' | 'boolean';
  valid: number;
  invalid: number;
  mean?: number;
  sd?: number;
  min?: number;
  max?: number;
  percentiles?: Record<string, number>;
  fraction?: number;
  count?: number;
}

export interface MonteCarloResult {
  status: 'ok' | 'cancelled';
  model: string;
  n: number;
  completed: number;
  seed: number;
  outputs: Record<string, OutputSummary>;
  tornado: { input: string; low: number; high: number; outputLow: number | null; outputHigh: number | null; swing: number }[];
  tornadoOutput: string;
  generator: string;
  interpretation: string;
}

export interface McControl {
  onProgress?: (completed: number, total: number) => void;
  isCancelled?: () => boolean;
  /** Yield to the event loop every k samples (worker message processing). */
  yieldEvery?: number;
}

export function validateSpec(spec: MonteCarloSpec): MonteCarloModel {
  const model = MC_MODELS[spec.model];
  if (!model) throw new Error(`Монте-Карло: модель ${spec.model} не поддерживается`);
  const missing = model.inputs.filter(k => !spec.inputs?.[k]);
  if (missing.length) throw new Error(`Монте-Карло: нет распределений для ${missing.join(', ')}`);
  for (const [k, d] of Object.entries(spec.inputs)) validateDistribution(k, d);
  const n = spec.n ?? 1000;
  if (!Number.isInteger(n) || n < 10 || n > 1_000_000) throw new Error('Монте-Карло: N — целое 10…1 000 000');
  if (!Number.isInteger(spec.seed)) throw new Error('Монте-Карло: seed — целое число');
  return model;
}

/**
 * Seeded Monte Carlo over bounded input distributions. Percentiles and the
 * fraction of runs with a boolean output are frequencies under the CHOSEN input
 * distributions — not a probability of fault and not an empirical confidence interval.
 */
export async function runMonteCarlo(spec: MonteCarloSpec, control: McControl = {}): Promise<MonteCarloResult> {
  const model = validateSpec(spec);
  const n = spec.n ?? 1000, rnd = mulberry32(spec.seed), keys = Object.keys(spec.inputs).sort();
  const values: Record<string, number[]> = Object.fromEntries(model.outputs.map(o => [o, [] as number[]]));
  const kinds: Record<string, 'numeric' | 'boolean'> = {};
  const invalid: Record<string, number> = Object.fromEntries(model.outputs.map(o => [o, 0]));
  let completed = 0;
  for (let i = 0; i < n; i++) {
    if (control.isCancelled?.()) break;
    const x: Record<string, number> = {};
    for (const k of keys) x[k] = sample(spec.inputs[k], rnd);
    let out: ModelOutput;
    try { out = model.run(x); } catch { out = {}; }
    for (const o of model.outputs) {
      const v = out[o];
      if (typeof v === 'boolean') { kinds[o] = 'boolean'; values[o].push(v ? 1 : 0); }
      else if (typeof v === 'number' && Number.isFinite(v)) { kinds[o] ??= 'numeric'; values[o].push(v); }
      else invalid[o]++;
    }
    completed++;
    if (completed % 50 === 0 || completed === n) control.onProgress?.(completed, n);
    if (control.yieldEvery && completed % control.yieldEvery === 0) await new Promise(r => setTimeout(r, 0));
  }
  const pcts = spec.percentiles ?? [5, 50, 95];
  const outputs: Record<string, OutputSummary> = {};
  for (const o of model.outputs) {
    const xs = values[o];
    if (kinds[o] === 'boolean') {
      const count = xs.reduce((s, v) => s + v, 0);
      outputs[o] = { kind: 'boolean', valid: xs.length, invalid: invalid[o], count, fraction: xs.length ? count / xs.length : NaN };
    } else {
      const sorted = [...xs].sort((a, b) => a - b), mean = xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
      outputs[o] = { kind: 'numeric', valid: xs.length, invalid: invalid[o], mean, sd: Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, xs.length - 1)),
        min: sorted[0], max: sorted[sorted.length - 1], percentiles: Object.fromEntries(pcts.map(p => [`p${p}`, percentile(sorted, p)])) };
    }
  }
  // Tornado: one input at its 5th/95th distribution quantile, others at their medians.
  const tOut = spec.tornadoOutput ?? model.tornadoOutput;
  const med: Record<string, number> = Object.fromEntries(keys.map(k => [k, quantile(spec.inputs[k], 0.5)]));
  const evalAt = (x: Record<string, number>) => { try { const v = model.run(x)[tOut]; return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null; } catch { return null; } };
  const tornado = keys.filter(k => spec.inputs[k].kind !== 'fixed').map(k => {
    const low = quantile(spec.inputs[k], 0.05), high = quantile(spec.inputs[k], 0.95);
    const a = evalAt({ ...med, [k]: low }), b = evalAt({ ...med, [k]: high });
    return { input: k, low, high, outputLow: a, outputHigh: b, swing: a !== null && b !== null ? Math.abs(b - a) : 0 };
  }).sort((p, q) => q.swing - p.swing);
  return { status: completed < n ? 'cancelled' : 'ok', model: model.id, n, completed, seed: spec.seed, outputs, tornado, tornadoOutput: tOut,
    generator: 'mulberry32 (seeded), percentiles type 7',
    interpretation: 'Частоты и перцентили — при выбранных распределениях входов; это не вероятность вины и не эмпирический доверительный интервал.' };
}
