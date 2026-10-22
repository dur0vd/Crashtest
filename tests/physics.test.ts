import { describe, expect, it } from 'vitest';
import {
  bodyVelocity, DYNAMIC_FRAME_DT, dugoffTyre, elasticDemand, evaluateForces, GRAVITY,
  kineticEnergy, lateralGripSpeed, lockedTyre, normalLoads, stepDynamics, syntheticVehicle,
  understeerGradient, type DynamicControl, type DynamicRoad, type DynamicState, type DynamicVehicleParameters,
} from '../src/physics';
import { DT } from '../src/sim';

const road: DynamicRoad = { mu: 0.8, source: { kind: 'synthetic', description: 'Flat test surface, assigned mu' } };
const coast: DynamicControl = { steering: 0, drive: 0, brake: 0 };
const state = (vx = 20): DynamicState => ({ x: 0, y: 0, heading: 0, vx, vy: 0, yawRate: 0, ax: 0, ay: 0 });
function run(s: DynamicState, p: DynamicVehicleParameters, c: DynamicControl, duration: number, r = road, dt = 0.005): DynamicState {
  for (let k = 0; k < Math.round(duration / DT); k++) s = stepDynamics(s, p, c, r, { substepSeconds: dt }).state;
  return s;
}

describe('Dugoff: hand calculations, independent of actuation/integration', () => {
  const input = { kappa: 0, tanAlpha: 0, direction: 1 as const, normalLoad: 4000, muX: 1, muY: 1, longitudinalStiffness: 100000, corneringStiffness: 40000 };
  it('nonlinear brush factor differs from a clipped linear spring', () => {
    // qy=-4000 N; lambda=4000/(2*4000)=0.5; f=0.75, hence Fy=-3000 N.
    const out = dugoffTyre({ ...input, tanAlpha: 0.1 });
    expect(out.fy).toBeCloseTo(-3000, 10);
    expect(out.lambda).toBe(0.5);
    expect(out.fy).not.toBe(-4000);
  });
  it('manual combined-slip example includes the rolling-speed denominator', () => {
    // k=-0.2 => qx=-25000; tanAlpha=.1 => qy=-5000;
    // lambda=4000/(2*sqrt(25000²+5000²)).
    const lambda = 4000 / (2 * Math.sqrt(25000 ** 2 + 5000 ** 2));
    const f = lambda * (2 - lambda);
    const out = dugoffTyre({ ...input, kappa: -0.2, tanAlpha: 0.1 });
    expect(out.fx).toBeCloseTo(-25000 * f, 10);
    expect(out.fy).toBeCloseTo(-5000 * f, 10);
  });
  it('continuous at lambda=1, zero-load and zero-grip safe, lock boundary explicit', () => {
    expect(dugoffTyre({ ...input, tanAlpha: 0.05 }).fy).toBeCloseTo(-2000, 10);
    expect(dugoffTyre({ ...input, tanAlpha: 0.05 + 1e-10 }).fy).toBeCloseTo(-2000, 4);
    expect(dugoffTyre({ ...input, kappa: -0.9, normalLoad: 0 }).fx).toBe(0);
    expect(dugoffTyre({ ...input, muX: 0 }).fx).toBe(0);
    expect(() => dugoffTyre({ ...input, kappa: -1 })).toThrow();
    expect(() => dugoffTyre({ ...input, kappa: NaN })).toThrow();
  });
  it('ellipse and slip dissipation for forward/reverse, braking/traction, anisotropic grip', () => {
    for (const direction of [-1, 1] as const) for (const kappa of [-0.9999, -0.6, -0.1, 0, 0.1, 2, 100]) {
      for (const tanAlpha of [-4, -0.2, 0, 0.3, 5]) {
        const out = dugoffTyre({ ...input, direction, kappa, tanAlpha, muX: 0.4, muY: 0.8 });
        expect(Math.hypot(out.fx / 1600, out.fy / 3200)).toBeLessThanOrEqual(1 + 1e-12);
        // Contact relative velocity: Vx-Romega = -direction*kappa*|Vx|.
        expect(out.fx * (-direction * kappa) + out.fy * tanAlpha).toBeLessThanOrEqual(1e-10);
      }
    }
  });
  it('locked ellipse dissipates in every slip direction, including pure lateral motion', () => {
    for (const vx of [-30, 0, 20]) for (const vy of [-15, 0, 15]) {
      const f = lockedTyre(vx, vy, 4000, 0.4, 0.8);
      expect(f.fx * vx + f.fy * vy).toBeLessThanOrEqual(0);
      expect(Math.hypot(f.fx / 1600, f.fy / 3200)).toBeCloseTo(vx || vy ? 1 : 0, 12);
    }
  });
  it('inverse pure-slip equation gives an independently prescribed force', () => {
    for (const target of [-3900, -1500, 0, 1500, 3900]) {
      const q = elasticDemand(target, 4000), kappa = q / (100000 - q);
      expect(dugoffTyre({ ...input, kappa }).fx).toBeCloseTo(target, 8);
    }
  });
});

describe('four-wheel Newton–Euler kernel', () => {
  it('matches the outer DT and rejects variable/remainder substeps and ambiguous controls', () => {
    expect(DYNAMIC_FRAME_DT).toBe(DT);
    const p = syntheticVehicle();
    expect(() => stepDynamics(state(), p, coast, road, { substepSeconds: 0.006 })).toThrow();
    expect(() => stepDynamics(state(), p, coast, road, { substepSeconds: 0.003 })).toThrow();
    expect(() => stepDynamics(state(), p, { ...coast, brake: 1 }, road)).toThrow(/ABS/);
    expect(() => stepDynamics(state(), p, { ...coast, drive: 1, brake: 1 }, road)).toThrow();
  });
  it('inertial momentum and kinetic energy survive 10 seconds without external forces, including spin', () => {
    const p = syntheticVehicle(), start = { ...state(), vy: -4, yawRate: 0.7, heading: 0.4 };
    const end = run(start, p, coast, 10, { ...road, mu: 0 });
    expect(end.vx).toBe(start.vx); expect(end.vy).toBe(start.vy); expect(end.yawRate).toBe(start.yawRate);
    expect(kineticEnergy(end, p)).toBe(kineticEnergy(start, p));
    expect(end.x).toBeCloseTo(200, 8); expect(end.y).toBeCloseTo(-40, 8);
    expect(end.heading).toBeCloseTo(7.4, 8);
  });
  it('longitudinal/lateral load transfer agrees with force and moment balances', () => {
    const p = syntheticVehicle();
    const { loads: z } = normalLoads(p, -4, 3);
    const { mass: m, cgHeight: h, lf, lr, trackFront: t } = p.body;
    expect(z.reduce((a, b) => a + b)).toBeCloseTo(m * 9.81, 10);
    expect(z[0] + z[1]).toBeCloseTo(m * (9.81 * lr + 4 * h) / (lf + lr), 10);
    expect((z[0] - z[1] + z[2] - z[3]) * t / 2).toBeCloseTo(m * 3 * h, 10);
    expect(z[0]).toBeGreaterThan(z[1]); // right turn loads the outer left tyres
    const lifted = normalLoads(p, 100, 100);
    expect(lifted.wheelLift).toBe(true);
    expect(lifted.loads.every(z => z >= 0)).toBe(true);
    expect(lifted.loads.reduce((a, b) => a + b)).toBeCloseTo(m * 9.81, 10);
  });

  it.each(['disabled', 'ideal'] as const)('braking distance/time within one percent vs v*t+v²/(2*mu*g), ABS=%s', abs => {
    const p = syntheticVehicle(); p.brakes.abs = abs;
    for (const mu of [0.1, 0.4, 0.8]) for (const initialSpeed of [-20, 5, 20, 35]) {
      const r = { ...road, mu }, delay = 0.75;
      let s = run(state(initialSpeed), p, coast, delay, r);
      let elapsed = delay;
      while (Math.abs(s.vx) > 1e-7 && elapsed < 50) {
        const prev = s;
        const result = stepDynamics(s, p, { ...coast, brake: 1 }, r, { trace: Math.abs(s.vx) < 1 });
        s = result.state;
        expect(Math.abs(s.vx)).toBeLessThanOrEqual(Math.abs(prev.vx) + 1e-10);
        expect(s.vx * initialSpeed).toBeGreaterThanOrEqual(-1e-10);
        const stopIndex = result.trace?.substeps.findIndex(step => Math.abs(step.state.vx) < 1e-7) ?? -1;
        elapsed += stopIndex < 0 ? DT : (stopIndex + 1) * 0.005;
      }
      const v = Math.abs(initialSpeed), expectedS = v * delay + v * v / (2 * mu * 9.81);
      const expectedT = delay + v / (mu * 9.81);
      expect(Math.abs(Math.abs(s.x) / expectedS - 1)).toBeLessThan(0.01);
      expect(Math.abs(elapsed / expectedT - 1)).toBeLessThan(0.01);
      const stopped = run(s, p, { ...coast, brake: 1 }, 1, r);
      expect(stopped.x).toBeCloseTo(s.x, 7);
      expect(Math.abs(stopped.vx)).toBeLessThan(1e-7);
    }
  });

  it('deterministic, independent copies; passive energy decreases under side slip/yaw down to rest', () => {
    const p = syntheticVehicle(); p.brakes.abs = 'disabled';
    const start = { ...state(0.02), vy: 0.03, yawRate: -0.04 };
    const a = run(start, p, { ...coast, brake: 1 }, 2);
    const b = run(start, p, { ...coast, brake: 1 }, 2);
    expect(a).toEqual(b);
    let s = start;
    for (let i = 0; i < 100; i++) {
      const result = stepDynamics(s, p, { ...coast, brake: 1 }, road, { trace: true });
      for (const t of result.trace!.substeps) {
        expect(t.energyAfter).toBeLessThanOrEqual(t.energyBefore + 1e-10);
        for (const w of t.forces.wheels) {
          expect(w.ellipseUse, JSON.stringify(w)).toBeLessThanOrEqual(1 + 1e-12);
          expect(w.power, JSON.stringify(w)).toBeLessThanOrEqual(1e-10);
        }
      }
      s = result.state;
    }
    expect(kineticEnergy(s, p)).toBeLessThan(1e-6);
  });
  it('resolves a stop inside a substep without excess distance at millimetres per second', () => {
    const p = syntheticVehicle(); p.brakes.abs = 'disabled';
    for (const speed of [-0.1, -0.001, 0.001, 0.02, 0.1]) {
      const out = stepDynamics(state(speed), p, { ...coast, brake: 1 }, road, { trace: true });
      expect(out.state.vx).toBe(0);
      expect(out.state.x).toBeCloseTo(Math.sign(speed) * speed ** 2 / (2 * road.mu * 9.81), 12);
      const moving = out.trace!.substeps.filter(t => t.energyBefore > 0);
      expect(moving.reduce((sum, t) => sum + t.motionSeconds, 0)).toBeCloseTo(Math.abs(speed) / (road.mu * 9.81), 12);
    }
  });
  it('drive starts forwards/reverse, coasts without creep, brake distribution and axle drive are explicit', () => {
    const p = syntheticVehicle(); p.brakes.abs = 'ideal';
    expect(run(state(0), p, coast, 1).vx).toBe(0);
    expect(run(state(0), p, { ...coast, drive: 0.4 }, 1).vx).toBeGreaterThan(1);
    expect(run(state(0), p, { ...coast, drive: -0.4 }, 1).vx).toBeLessThan(-1);
    const f = evaluateForces(state(), p, { ...coast, drive: 0.1 }, road);
    expect(f.wheels.slice(0, 2).every(w => w.longitudinalDemand === 0)).toBe(true);
    expect(f.wheels.slice(2).every(w => w.longitudinalDemand === 400)).toBe(true);
    const br = evaluateForces(state(), p, { ...coast, brake: 0.01 }, road);
    expect(br.wheels[0].fx / br.wheels[2].fx).toBeCloseTo(1.5, 10);
  });
  it('limits aggregate lateral force at the independent sqrt(mu*g*R) bound', () => {
    const p = syntheticVehicle(), R = 50;
    const critical = lateralGripSpeed(road.mu, R);
    expect(critical).toBeCloseTo(Math.sqrt(0.8 * 9.81 * 50), 12);
    const f = evaluateForces({ ...state(20), vy: 2000 }, p, coast, road);
    const available = Math.abs(f.fy), demandBelow = p.body.mass * (critical * 0.99) ** 2 / R;
    const demandAbove = p.body.mass * (critical * 1.01) ** 2 / R;
    expect(available).toBeGreaterThan(demandBelow);
    expect(available).toBeLessThan(demandAbove);
    expect(available).toBeLessThanOrEqual(p.body.mass * road.mu * GRAVITY);
  });
  it.each([['understeer', 30000, 60000, 1], ['oversteer', 60000, 30000, -1], ['neutral', 40000, 40000, 0]] as const)(
    'steady small-angle turn follows the independently derived bicycle gradient: %s', (_name, cf, cr, sign) => {
      const p = syntheticVehicle(); p.body.cgHeight = 0;
      p.tyres.corneringStiffnessFront = cf; p.tyres.corneringStiffnessRear = cr;
      const steering = 0.01, start = state(10), end = run(start, p, { ...coast, steering }, 5);
      const { u } = bodyVelocity(end), L = p.body.lf + p.body.lr;
      // δ = L/R + m/L*(lr/Cf_axle-lf/Cr_axle)*u²/R, Cf_axle=2*cf.
      const K = p.body.mass / L * (p.body.lr / (2 * cf) - p.body.lf / (2 * cr));
      expect(Math.sign(understeerGradient(p))).toBe(sign);
      const expectedYaw = u * steering / (L + K * u * u);
      expect(Math.abs(end.yawRate / expectedYaw - 1)).toBeLessThan(0.02);
      const later = run(end, p, { ...coast, steering }, 0.1);
      expect(Math.abs(later.yawRate - end.yawRate)).toBeLessThan(1e-4);
      const fine = run(start, p, { ...coast, steering }, 5, road, 0.0025);
      expect(Math.abs(end.yawRate - fine.yawRate)).toBeLessThan(0.0002);
      expect(Math.hypot(end.x - fine.x, end.y - fine.y)).toBeLessThan(0.02);
    });
});
