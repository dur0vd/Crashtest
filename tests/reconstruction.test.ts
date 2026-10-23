import { describe, expect, it } from 'vitest';
import {
  differentialEvolution, impactForward, mulberry32, nelderMead, percentile, quantile, reconstructImpact, reconstructScene, runMonteCarlo,
  sample, syntheticVehicle, type ImpactProblem,
} from '../src/physics';
import { safeSpeed, stoppingDistance } from '../src/expert';
import { handleMonteCarloMessage, type WorkerReply } from '../src/physics/mc-worker';
import { emptyScene, type Actor } from '../src/scene';

const synthetic = { kind: 'synthetic' as const, description: 'Test fixture only' };

describe('seeded sampling and Monte Carlo', () => {
  it('generator and samplers are deterministic and respect bounds; triangular quantile is exact', () => {
    const a = mulberry32(42), b = mulberry32(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    const r = mulberry32(1);
    for (let i = 0; i < 2000; i++) {
      const x = sample({ kind: 'normal', mean: 1, sd: 0.3, min: 0.6, max: 1.2 }, r);
      expect(x).toBeGreaterThanOrEqual(0.6); expect(x).toBeLessThanOrEqual(1.2);
    }
    const tri = { kind: 'triangular' as const, min: 0, mode: 1, max: 3 };
    expect(quantile(tri, 1 / 3)).toBeCloseTo(1, 12); // F(mode) = (mode-min)/(max-min)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });
  it('fraction of avoidable runs matches the analytic probability under a uniform speed (N=1000 default)', async () => {
    const t1 = 1, t2 = 0.1, t3 = 0.35, j = 6.8, available = 40;
    const vSafe = safeSpeed(available, t1, t2, t3, j);
    const out = await runMonteCarlo({ model: 'expert.braking', seed: 7, inputs: {
      v0: { kind: 'uniform', min: 10, max: 20 }, available: { kind: 'fixed', value: available }, t1: { kind: 'fixed', value: t1 },
      t2: { kind: 'fixed', value: t2 }, t3: { kind: 'fixed', value: t3 }, j: { kind: 'fixed', value: j } } });
    expect(out.n).toBe(1000);
    const expected = (vSafe - 10) / 10;
    expect(Math.abs(out.outputs.avoidable.fraction! - expected)).toBeLessThan(0.05);
    // p5/p95 of S follow the monotone transform of the speed quantiles (sampling error only).
    expect(out.outputs.stoppingDistance.percentiles!.p5).toBeCloseTo(stoppingDistance(10.5, t1, t2, t3, j), 0);
    expect(out.outputs.stoppingDistance.percentiles!.p95).toBeCloseTo(stoppingDistance(19.5, t1, t2, t3, j), 0);
    expect(out.interpretation).toMatch(/не вероятность вины/);
  });
  it('same seed → identical result; tornado ranks inputs by effect; progress and cancellation', async () => {
    const spec = { model: 'expert.braking', seed: 11, n: 300, inputs: {
      v0: { kind: 'normal' as const, mean: 15, sd: 1, min: 12, max: 18 }, available: { kind: 'fixed' as const, value: 40 },
      t1: { kind: 'triangular' as const, min: 0.8, mode: 1, max: 1.4 }, t2: { kind: 'fixed' as const, value: 0.1 },
      t3: { kind: 'uniform' as const, min: 0.3, max: 0.32 }, j: { kind: 'uniform' as const, min: 6, max: 7.5 } } };
    const a = await runMonteCarlo(spec), b = await runMonteCarlo(spec);
    expect(a).toEqual(b);
    expect(a.tornado[a.tornado.length - 1].input).toBe('t3');
    const progress: number[] = [];
    let calls = 0;
    const c = await runMonteCarlo(spec, { onProgress: done => progress.push(done), isCancelled: () => ++calls > 120 });
    expect(c.status).toBe('cancelled'); expect(c.completed).toBe(120);
    expect(progress).toContain(100);
  });
  it('worker message handler (no DOM) reports progress and the same result', async () => {
    const replies: WorkerReply[] = [];
    const spec = { model: 'expert.braking.skid-speed', seed: 3, n: 200, inputs: { skidLength: { kind: 'uniform' as const, min: 18, max: 22 },
      j: { kind: 'uniform' as const, min: 6, max: 7 }, t3: { kind: 'fixed' as const, value: 0.35 } } };
    await handleMonteCarloMessage({ type: 'run', spec }, r => replies.push(r));
    const last = replies[replies.length - 1];
    expect(last.type).toBe('result');
    expect(replies.some(r => r.type === 'progress')).toBe(true);
    if (last.type === 'result') expect(last.result).toEqual(await runMonteCarlo(spec));
    const err: WorkerReply[] = [];
    await handleMonteCarloMessage({ type: 'run', spec: { ...spec, model: 'nope' } }, r => err.push(r));
    expect(err[0].type).toBe('error');
  });
});

describe('optimisers', () => {
  it('bounded Nelder–Mead reaches the Rosenbrock minimum; DE is seed-deterministic', () => {
    const rosen = (x: number[]) => (1 - x[0]) ** 2 + 100 * (x[1] - x[0] ** 2) ** 2;
    const b = [{ name: 'x', min: -2, max: 2 }, { name: 'y', min: -1, max: 3 }];
    const nm = nelderMead(rosen, [-1.5, 2], b, { maxEvaluations: 4000 });
    expect(nm.x[0]).toBeCloseTo(1, 3); expect(nm.x[1]).toBeCloseTo(1, 3);
    expect(differentialEvolution(rosen, b, 5)).toEqual(differentialEvolution(rosen, b, 5));
  });
});

function problem(): ImpactProblem {
  const p = syntheticVehicle(); p.brakes.abs = 'disabled';
  return {
    vehicles: [
      { id: 'a1', parameters: p, x: 0, y: 0, heading: 0, postImpact: 'locked' },
      { id: 'a2', parameters: structuredClone(p), x: 2.6, y: 2.2, heading: -Math.PI / 2, postImpact: 'locked' },
    ],
    contact: { point: { x: 2.25, y: 0.9 }, normal: { x: 0, y: 1 } }, restitution: 0.1, mu: 0.7, muSource: synthetic,
    variables: [{ name: 'speed0', min: 5, max: 25 }, { name: 'speed1', min: 3, max: 20 }], evidence: [], seed: 2024,
  };
}

describe('inverse problem on synthetic data', () => {
  it('impact model: rest poses from known speeds → speeds recovered; evidence untouched; same seed same answer', () => {
    const pr = problem();
    const truth = impactForward(pr, { speed0: 14, speed1: 9 });
    pr.evidence = truth.rest.flatMap((r, i) => [{ id: `rest-${i}`, vehicle: i as 0 | 1, x: r.state.x, y: r.state.y, heading: r.state.heading, sigmaPosition: 0.2, sigmaHeading: 0.05 }]);
    const before = structuredClone(pr.evidence);
    const out = reconstructImpact(pr);
    expect(out.variables.speed0).toBeCloseTo(14, 1);
    expect(out.variables.speed1).toBeCloseTo(9, 1);
    expect(out.cost).toBeLessThan(0.05);
    expect(out.residuals).toHaveLength(2);
    expect(pr.evidence).toEqual(before);
    expect(reconstructImpact(pr)).toEqual(out);
  }, 60000);
  it('scene model: unknown initial speed from the observed rest position after hazard braking', () => {
    const p = syntheticVehicle(); p.brakes.abs = 'ideal';
    const car: Actor = { id: 'a1', kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 50, path: [], color: '#fff', delay: 0,
      flags: { drunk: false, noLicense: false, flees: false }, dynamics: p };
    const s = emptyScene(); s.env.physics = 'dynamic'; s.env.duration = 6; s.actors = [car];
    const options = { vehicles: { a1: { hazard: { at: 0.2, reaction: 0.8, deceleration: 6.5, steering: 'hold' as const, source: synthetic } } } };
    const vTrue = 50 / 3.6, xRest = vTrue * 1.0 + vTrue * vTrue / (2 * 6.5); // analytic, ideal actuator
    const frozen = JSON.stringify(s);
    const out = reconstructScene({ scene: s, options, variables: [{ actorId: 'a1', min: 20, max: 90 }], evidence: [{ id: 'rest', actorId: 'a1', x: xRest, y: 0, sigmaPosition: 0.3 }], seed: 1, starts: 3 });
    expect(Math.abs(out.variables['a1.speed'] - 50)).toBeLessThan(1);
    expect(JSON.stringify(s)).toBe(frozen);
  }, 60000);
});
