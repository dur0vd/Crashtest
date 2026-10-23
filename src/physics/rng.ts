/**
 * Deterministic 32-bit generator mulberry32 (Tommy Ettinger, public-domain
 * algorithm). Not cryptographic; used only for reproducible sampling by seed.
 */
import { dm } from '../dmath';
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bounded input distributions; every distribution is truncated to [min, max]. */
export type Distribution =
  | { kind: 'fixed'; value: number }
  | { kind: 'uniform'; min: number; max: number }
  | { kind: 'normal'; mean: number; sd: number; min: number; max: number }
  | { kind: 'triangular'; min: number; mode: number; max: number };

export function validateDistribution(name: string, d: Distribution): void {
  const fin = (x: number) => Number.isFinite(x);
  switch (d?.kind) {
    case 'fixed': if (!fin(d.value)) throw new Error(`${name}: неверное значение`); return;
    case 'uniform': if (!fin(d.min) || !fin(d.max) || d.min > d.max) throw new Error(`${name}: равномерное — min ≤ max`); return;
    case 'normal':
      if (![d.mean, d.sd, d.min, d.max].every(fin) || d.sd <= 0 || d.min > d.max) throw new Error(`${name}: нормальное — sd > 0, min ≤ max`);
      if (d.mean < d.min || d.mean > d.max) throw new Error(`${name}: среднее вне границ усечения`);
      return;
    case 'triangular':
      if (![d.min, d.mode, d.max].every(fin) || !(d.min <= d.mode && d.mode <= d.max) || d.min === d.max) throw new Error(`${name}: треугольное — min ≤ mode ≤ max, min < max`);
      return;
    default: throw new Error(`${name}: неизвестное распределение`);
  }
}

/**
 * Exact samplers: inverse CDF for uniform/triangular; Box–Muller with rejection
 * outside [min, max] for the truncated normal (bounds include the mean, so the
 * acceptance probability is at least the mass between the bounds).
 */
export function sample(d: Distribution, rnd: () => number): number {
  switch (d.kind) {
    case 'fixed': return d.value;
    case 'uniform': return d.min + (d.max - d.min) * rnd();
    case 'triangular': {
      const u = rnd(), c = (d.mode - d.min) / (d.max - d.min);
      return u < c ? d.min + Math.sqrt(u * (d.max - d.min) * (d.mode - d.min)) : d.max - Math.sqrt((1 - u) * (d.max - d.min) * (d.max - d.mode));
    }
    case 'normal': {
      for (let i = 0; i < 100000; i++) {
        const u1 = 1 - rnd(), u2 = rnd();
        const x = d.mean + d.sd * Math.sqrt(-2 * dm.log(u1)) * dm.cos(2 * Math.PI * u2);
        if (x >= d.min && x <= d.max) return x;
      }
      throw new Error('Нормальное распределение: границы усечения отсекают почти всю массу');
    }
  }
}

/** Quantile of the distribution itself (used for tornado ends), q in [0,1]. */
export function quantile(d: Distribution, q: number, rnd?: () => number): number {
  switch (d.kind) {
    case 'fixed': return d.value;
    case 'uniform': return d.min + (d.max - d.min) * q;
    case 'triangular': {
      const c = (d.mode - d.min) / (d.max - d.min);
      return q < c ? d.min + Math.sqrt(q * (d.max - d.min) * (d.mode - d.min)) : d.max - Math.sqrt((1 - q) * (d.max - d.min) * (d.max - d.mode));
    }
    case 'normal': {
      // Empirical quantile from a fixed seeded sample: avoids approximating the inverse normal CDF.
      const r = rnd ?? mulberry32(0x9E3779B9);
      const xs = Array.from({ length: 20001 }, () => sample(d, r)).sort((a, b) => a - b);
      return percentile(xs, q * 100);
    }
  }
}

/** Percentile with linear interpolation between order statistics (Hyndman–Fan type 7). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p / 100, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
