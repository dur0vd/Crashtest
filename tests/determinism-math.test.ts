/** Cross-runtime determinism (stage 15.6): calculation paths must not call engine
 * Math transcendental functions, whose last bits differ between V8 versions
 * (measured on CI: Node 22 vs Chromium 156). Here they throw while every preset
 * runs through the real ports, kinematic and dynamic, plus Monte Carlo. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { createPorts, runProject } from '../src/integration/ports';
import { newProject } from '../src/project/model';
import { dm } from '../src/dmath';

const NAMES = ['sin', 'cos', 'tan', 'atan', 'atan2', 'acos', 'asin', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'hypot', 'cbrt', 'sinh', 'cosh', 'tanh'] as const;
const saved = new Map<string, unknown>();
const M = Math as unknown as Record<string, unknown>;

describe('расчёт не использует Math.* трансцендентные функции движка', () => {
  beforeEach(() => {
    for (const n of NAMES) { saved.set(n, M[n]); M[n] = () => { throw new Error(`Math.${n} в расчётном пути`); }; }
  });
  afterEach(() => { for (const n of NAMES) M[n] = saved.get(n); });

  it('все пресеты, кинематика и динамика, физика и правила; Монте-Карло', async () => {
    const ports = createPorts();
    let dynamicOk = 0;
    for (const preset of PRESETS) {
      // Building the preset itself (geometry of the inputs) must be deterministic too.
      const p = newProject(preset.build()).project;
      p.extensions.rules = { mode: 'educational' };
      const run = await runProject(p, ports);
      expect(run.physics.status, preset.title).toBe('ok');
      expect(run.rules?.status, preset.title).toBe('ok');
      p.scene.env.physics = 'dynamic';
      const dyn = await runProject(p, ports);
      if (dyn.physics.status === 'ok') dynamicOk++;
      else expect(dyn.physics.status, preset.title).toBe('unsupported');
    }
    expect(dynamicOk).toBeGreaterThan(0);
    const mc = await ports.physics.calculate('reconstruction.monte-carlo', newProject(PRESETS[0].build()).project, { model: 'expert.braking', seed: 3, n: 300,
      inputs: { v0: { kind: 'normal', mean: 14, sd: 1, min: 10, max: 18 }, available: { kind: 'fixed', value: 40 }, t1: { kind: 'uniform', min: 0.6, max: 1.2 },
        t2: { kind: 'fixed', value: 0.1 }, t3: { kind: 'fixed', value: 0.35 }, j: { kind: 'fixed', value: 6.8 } } });
    expect(mc.status).toBe('ok');
  }, 120000);
});

describe('dm: точность fdlibm', () => {
  // fdlibm guarantees < 1 ulp, not correct rounding (exp(1) is 1 ulp above the
  // correctly rounded e). Determinism comes from plain double arithmetic.
  const ulp = (x: number) => Number.EPSILON * Math.abs(x);
  const ref: [string, number, number][] = [
    ['sin(1)', dm.sin(1), 0.8414709848078965], ['cos(1)', dm.cos(1), 0.5403023058681398], ['exp(1)', dm.exp(1), Math.E],
    ['log(10)', dm.log(10), Math.LN10], ['atan2(1,1)', dm.atan2(1, 1), Math.PI / 4], ['hypot(3,4)', dm.hypot(3, 4), 5],
  ];
  it.each(ref)('%s в пределах 1 ulp от корректно округлённого значения', (_n, got, want) => {
    expect(Math.abs(got - want)).toBeLessThanOrEqual(ulp(want));
  });
});
