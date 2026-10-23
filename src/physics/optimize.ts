import { mulberry32 } from './rng';

export interface Bounds { name: string; min: number; max: number }

export interface OptimumCandidate { x: number[]; cost: number; evaluations: number; start: number[] }

const clampTo = (x: number[], b: Bounds[]) => x.map((v, i) => Math.min(b[i].max, Math.max(b[i].min, v)));

/**
 * Nelder–Mead simplex with standard coefficients (reflection 1, expansion 2,
 * contraction 0.5, shrink 0.5; Lagarias et al., SIAM J. Optim. 9(1), 1998).
 * Bounds are enforced by projecting trial points onto the box (documented
 * choice). Deterministic for a given start.
 */
export function nelderMead(f: (x: number[]) => number, start: number[], bounds: Bounds[], opts: { maxEvaluations?: number; tolerance?: number; initialStep?: number } = {}): OptimumCandidate {
  const n = start.length, maxEval = opts.maxEvaluations ?? 400 * n, tol = opts.tolerance ?? 1e-9;
  let evals = 0;
  const F = (x: number[]) => { evals++; const v = f(x); return Number.isFinite(v) ? v : Infinity; };
  const step = opts.initialStep ?? 0.1;
  let simplex = [clampTo(start, bounds)];
  for (let i = 0; i < n; i++) {
    const p = [...simplex[0]];
    const span = bounds[i].max - bounds[i].min;
    p[i] = p[i] + step * span <= bounds[i].max ? p[i] + step * span : p[i] - step * span;
    simplex.push(clampTo(p, bounds));
  }
  let values = simplex.map(F);
  while (evals < maxEval) {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map(i => simplex[i]); values = order.map(i => values[i]);
    if (Math.abs(values[n] - values[0]) <= tol * (Math.abs(values[0]) + tol)
      && simplex.every(p => p.every((v, i) => Math.abs(v - simplex[0][i]) <= 1e-9 * (bounds[i].max - bounds[i].min + 1)))) break;
    const centroid = Array.from({ length: n }, (_, i) => simplex.slice(0, n).reduce((s, p) => s + p[i], 0) / n);
    const move = (t: number) => clampTo(centroid.map((c, i) => c + t * (simplex[n][i] - c)), bounds);
    const xr = move(-1), fr = F(xr);
    if (fr < values[0]) {
      const xe = move(-2), fe = F(xe);
      if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr; values[n] = fr;
    } else {
      const outside = fr < values[n];
      const xc = move(outside ? -0.5 : 0.5), fc = F(xc);
      if (fc < (outside ? fr : values[n])) { simplex[n] = xc; values[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = clampTo(simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])), bounds);
          values[i] = F(simplex[i]);
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best], cost: values[best], evaluations: evals, start };
}

/**
 * Differential evolution rand/1/bin (Storn & Price, J. Global Optim. 11, 1997),
 * F=0.7, CR=0.9, population 15·n, seeded; bounds by projection.
 */
export function differentialEvolution(f: (x: number[]) => number, bounds: Bounds[], seed: number, opts: { generations?: number; population?: number } = {}): OptimumCandidate {
  const n = bounds.length, rnd = mulberry32(seed), np = opts.population ?? Math.max(10, 15 * n), gens = opts.generations ?? 60;
  let evals = 0;
  const F = (x: number[]) => { evals++; const v = f(x); return Number.isFinite(v) ? v : Infinity; };
  let pop = Array.from({ length: np }, () => bounds.map(b => b.min + (b.max - b.min) * rnd()));
  let cost = pop.map(F);
  for (let g = 0; g < gens; g++) {
    for (let i = 0; i < np; i++) {
      let a = i, b = i, c = i;
      while (a === i) a = Math.floor(rnd() * np);
      while (b === i || b === a) b = Math.floor(rnd() * np);
      while (c === i || c === a || c === b) c = Math.floor(rnd() * np);
      const jr = Math.floor(rnd() * n);
      const trial = clampTo(pop[i].map((v, j) => (rnd() < 0.9 || j === jr) ? pop[a][j] + 0.7 * (pop[b][j] - pop[c][j]) : v), bounds);
      const ft = F(trial);
      if (ft <= cost[i]) { pop[i] = trial; cost[i] = ft; }
    }
  }
  const best = cost.indexOf(Math.min(...cost));
  return { x: pop[best], cost: cost[best], evaluations: evals, start: pop[best] };
}

/**
 * Seeded multi-start Nelder–Mead. Distinct local optima with a cost close to the
 * best are returned as alternatives, so ambiguity is preserved, not hidden.
 */
export function multiStart(f: (x: number[]) => number, bounds: Bounds[], seed: number, opts: { starts?: number; maxEvaluations?: number; ambiguityCost?: number } = {}): { best: OptimumCandidate; alternatives: OptimumCandidate[]; runs: OptimumCandidate[] } {
  const rnd = mulberry32(seed), starts = opts.starts ?? 8;
  const runs: OptimumCandidate[] = [];
  for (let s = 0; s < starts; s++) {
    const start = bounds.map(b => b.min + (b.max - b.min) * rnd());
    runs.push(nelderMead(f, start, bounds, { maxEvaluations: opts.maxEvaluations ?? 150 * bounds.length, tolerance: 1e-10 }));
  }
  runs.sort((a, b) => a.cost - b.cost);
  const best = runs[0];
  const threshold = best.cost + (opts.ambiguityCost ?? Math.max(1, 0.1 * best.cost));
  const alternatives: OptimumCandidate[] = [];
  for (const r of runs.slice(1)) {
    if (r.cost > threshold) continue;
    const distinct = [best, ...alternatives].every(q => r.x.some((v, i) => Math.abs(v - q.x[i]) > 0.05 * (bounds[i].max - bounds[i].min)));
    if (distinct) alternatives.push(r);
  }
  return { best, alternatives, runs };
}
