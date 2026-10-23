import { describe, expect, it } from 'vitest';
import {
  AUGENSTEIN_2003, TEFFT_2011, crushEnergy, deltaVFromEnergy, effectiveMassFactor, energyEquivalentSpeed, modeFromPdof,
  occupantMais3Risk, pedestrianRisk, planarImpact, stiffnessFromTest, syntheticVehicle, type ImpactBody,
} from '../src/physics';
import { emptyScene, type Actor, type Scene } from '../src/scene';
import { simulate } from '../src/sim';
import { analyzeTechnical } from '../src/analysis/technical';

const synthetic = { kind: 'synthetic' as const, description: 'Test fixture only' };
// Independent deterministic generator for test cases (not the product RNG).
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const body = (m: number, I: number, x: number, y: number, vx: number, vy: number, w: number, heading = 0): ImpactBody =>
  ({ mass: m, yawInertia: I, position: { x, y }, velocity: { x: vx, y: vy }, yawRate: w, heading });
const momentum = (b: ImpactBody, v: { x: number; y: number }) => ({ x: b.mass * v.x, y: b.mass * v.y });
const angular = (b: ImpactBody, v: { x: number; y: number }, w: number) => b.mass * (b.position.x * v.y - b.position.y * v.x) + b.yawInertia * w;

describe('planar impulse model: analytic and conservation checks', () => {
  it('central collinear impact equals the textbook result for any k', () => {
    for (const k of [0, 0.12, 0.3, 1]) {
      const out = planarImpact({ a: body(1000, 1500, 0, 0, 20, 0, 0), b: body(1500, 2500, 4, 0, 0, 0, 0), point: { x: 2, y: 0 }, normal: { x: 1, y: 0 }, restitution: k });
      expect(out.a.velocity.x).toBeCloseTo((1000 * 20 - 1500 * k * 20) / 2500, 10);
      expect(out.b.velocity.x).toBeCloseTo((1000 * 20 + 1000 * k * 20) / 2500, 10);
      expect(out.a.yawRate).toBeCloseTo(0, 12);
      expect(out.energyLoss).toBeCloseTo(0.5 * (1000 * 1500 / 2500) * 400 * (1 - k * k), 6);
      expect(out.separationSpeed).toBeCloseTo(k * 20, 10);
    }
  });
  it('random oblique impacts conserve momentum and angular momentum; energy splits into normal + friction parts', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const a = body(800 + 2000 * r(), 1000 + 3000 * r(), 0, 0, 30 * r() - 5, 10 * r() - 5, r() - 0.5, r() * 6);
      const b = body(800 + 2000 * r(), 1000 + 3000 * r(), 3 + 2 * r(), 2 * r() - 1, 10 * r() - 5, 10 * r() - 5, r() - 0.5, r() * 6);
      const ang = r() * 2 - 1, mu = r() < 0.5 ? undefined : r();
      const out = planarImpact({ a, b, point: { x: 1.5 + r(), y: r() - 0.5 }, normal: { x: Math.cos(ang), y: Math.sin(ang) },
        restitution: 0.3 * r(), contactFriction: mu });
      const pa = momentum(a, a.velocity), pb = momentum(b, b.velocity), qa = momentum(a, out.a.velocity), qb = momentum(b, out.b.velocity);
      const scale = Math.max(1, Math.hypot(pa.x + pb.x, pa.y + pb.y));
      expect(Math.abs(pa.x + pb.x - qa.x - qb.x) / scale).toBeLessThan(1e-12);
      expect(Math.abs(pa.y + pb.y - qa.y - qb.y) / scale).toBeLessThan(1e-12);
      const L0 = angular(a, a.velocity, a.yawRate) + angular(b, b.velocity, b.yawRate);
      const L1 = angular(a, out.a.velocity, out.a.yawRate) + angular(b, out.b.velocity, out.b.yawRate);
      expect(Math.abs(L0 - L1) / Math.max(1, Math.abs(L0))).toBeLessThan(1e-10);
      expect(out.energyLoss).toBeCloseTo(out.energyNormal + out.energyTangential, 6);
      if (out.mode !== 'separating') {
        expect(out.energyIncrease).toBe(false);
        expect(out.energyLoss).toBeGreaterThanOrEqual(-1e-6);
      }
      if (out.mode === 'sliding') expect(Math.abs(out.tangentialImpulse)).toBeCloseTo(mu! * out.normalImpulse, 6);
      if (out.mode === 'full' && mu !== undefined) expect(Math.abs(out.tangentialImpulse)).toBeLessThanOrEqual(mu * out.normalImpulse + 1e-9);
    }
  });
  it('k=0 ends normal approach; frictionless k=1 conserves energy; sliding obeys |Pt|=muC*Pn', () => {
    const a = body(1200, 2000, 0, 0, 15, 9, 0.2), b = body(1500, 2500, 4, 1, -2, 0, 0);
    const plastic = planarImpact({ a, b, point: { x: 2, y: 0.8 }, normal: { x: 1, y: 0.2 }, restitution: 0 });
    expect(plastic.separationSpeed).toBeCloseTo(0, 10);
    const elastic = planarImpact({ a, b, point: { x: 2, y: 0.8 }, normal: { x: 1, y: 0.2 }, restitution: 1, contactFriction: 0 });
    expect(elastic.energyLoss).toBeCloseTo(0, 6);
    expect(elastic.tangentialImpulse).toBe(0);
    const sliding = planarImpact({ a, b, point: { x: 2, y: 0.8 }, normal: { x: 1, y: 0.2 }, restitution: 0.1, contactFriction: 0.05 });
    expect(sliding.mode).toBe('sliding');
    expect(Math.abs(sliding.tangentialImpulse)).toBeCloseTo(0.05 * sliding.normalImpulse, 8);
    const full = planarImpact({ a, b, point: { x: 2, y: 0.8 }, normal: { x: 1, y: 0.2 }, restitution: 0.1, contactFriction: 5 });
    expect(full.mode).toBe('full');
  });
  it('eccentric impact on a fixed wall spins the car; PDOF/clock follow the documented convention', () => {
    const car = body(1500, 2500, 0, 0, 10, 0, 0, 0);
    const wall = { mass: Infinity, yawInertia: Infinity, position: { x: 3, y: 0 }, velocity: { x: 0, y: 0 }, yawRate: 0 };
    // Frictionless contact plane: the impulse is purely normal, so PDOF is exactly frontal.
    const out = planarImpact({ a: car, b: wall, point: { x: 2.25, y: 0.8 }, normal: { x: 1, y: 0 }, restitution: 0.1, contactFriction: 0 });
    expect(out.a.velocity.x).toBeLessThan(10);
    expect(out.a.deltaYawRate).toBeGreaterThan(0); // the stopped right front corner turns the nose right (clockwise, positive)
    expect(out.a.pdofDeg).toBeCloseTo(0, 6); expect(out.a.clock).toBe(12);
    const side = planarImpact({ a: body(1500, 2500, 0, 0, 0, 0, 0, 0), b: body(1500, 2500, 0, 4, 0, -10, 0, Math.PI / 2 * 3), point: { x: 0, y: 0.9 }, normal: { x: 0, y: 1 }, restitution: 0 });
    expect(side.a.pdofDeg).toBeCloseTo(90, 6); expect(side.a.clock).toBe(3);
  });
});

describe('CRASH3-type crush energy and inverse Δv', () => {
  it('Campbell identity: stiffness from a test reproduces the test kinetic energy', () => {
    const test = { mass: 1400, speed: 15.6, noDamageSpeed: 2.2, averageCrush: 0.55, width: 1.6, source: 'synthetic test' };
    const s = stiffnessFromTest(test);
    const e = crushEnergy({ width: 1.6, crush: Array(6).fill(0.55), source: 'synthetic' }, s);
    expect(e.energy).toBeCloseTo(0.5 * 1400 * 15.6 ** 2, 6);
    expect(energyEquivalentSpeed(e.energy, 1400)).toBeCloseTo(15.6, 10);
  });
  it('six-point integration equals the classical expanded CRASH3 expression', () => {
    const r = rng(3);
    for (let i = 0; i < 50; i++) {
      const C = Array.from({ length: 6 }, () => 0.6 * r()), A = 20000 + 60000 * r(), B = 200000 + 900000 * r(), w = 1 + r();
      const out = crushEnergy({ width: w, crush: C, source: 'synthetic' }, { A, B, source: synthetic });
      const [c1, c2, c3, c4, c5, c6] = C;
      const classical = w / 5 * (A / 2 * (c1 + 2 * c2 + 2 * c3 + 2 * c4 + 2 * c5 + c6)
        + B / 6 * (c1 ** 2 + 2 * c2 ** 2 + 2 * c3 ** 2 + 2 * c4 ** 2 + 2 * c5 ** 2 + c6 ** 2 + c1 * c2 + c2 * c3 + c3 * c4 + c4 * c5 + c5 * c6)
        + 5 * A * A / (2 * B));
      expect(out.energy).toBeCloseTo(classical, 6);
    }
  });
  it('inverse Δv from energy matches the central impulse model (k=0 and k=0.2) and the k=0 closed form', () => {
    for (const k of [0, 0.2]) {
      const impact = planarImpact({ a: body(1200, 2000, 0, 0, 18, 0, 0), b: body(1800, 3000, 4, 0, 0, 0, 0), point: { x: 2, y: 0 }, normal: { x: 1, y: 0 }, restitution: k });
      const inv = deltaVFromEnergy({ m1: 1200, m2: 1800, energy: impact.energyLoss, restitution: k });
      expect(inv.deltaV1).toBeCloseTo(impact.a.deltaVMagnitude, 8);
      expect(inv.deltaV2).toBeCloseTo(impact.b.deltaVMagnitude, 8);
    }
    const out = deltaVFromEnergy({ m1: 1000, m2: 2000, energy: 60000, restitution: 0 });
    expect(out.deltaV1).toBeCloseTo(Math.sqrt(2 * 60000 * 2000 / (1000 * 3000)), 12);
    expect(effectiveMassFactor(1500, 2500, 0)).toBe(1);
    expect(effectiveMassFactor(1500, 2500, 1)).toBeCloseTo((2500 / 1500) / (2500 / 1500 + 1), 12);
  });
});

describe('published injury-risk parameterisations', () => {
  it('Augenstein et al. 2003: published 30 mph values reproduce to 0.1 %', () => {
    const at30 = 30 * 0.44704;
    const published = { all: 0.427, frontal: 0.389, nearside: 0.838, farside: 0.478, rear: 0.199 };
    for (const [mode, p] of Object.entries(published)) expect(Math.abs(occupantMais3Risk(at30, mode as keyof typeof AUGENSTEIN_2003).probability! - p)).toBeLessThan(0.0006);
    expect(modeFromPdof(10).modes).toEqual(['frontal']);
    expect(modeFromPdof(90).modes).toEqual(['nearside', 'farside']);
    expect(modeFromPdof(90, 'right').modes).toEqual(['nearside']);
    expect(modeFromPdof(-170).modes).toEqual(['rear']);
  });
  it('Tefft 2011 anchors are reproduced exactly, monotone between them, bounds outside, children unsupported', () => {
    TEFFT_2011.severe.forEach((mph, i) => expect((pedestrianRisk(mph * 0.44704, 'severe') as { probability: number }).probability).toBeCloseTo(TEFFT_2011.levels[i], 10));
    TEFFT_2011.death.forEach((mph, i) => expect((pedestrianRisk(mph * 0.44704, 'death') as { probability: number }).probability).toBeCloseTo(TEFFT_2011.levels[i], 10));
    let prev = 0;
    for (let mph = 16; mph <= 46; mph += 0.5) {
      const p = (pedestrianRisk(mph * 0.44704, 'severe') as { probability: number }).probability;
      expect(p).toBeGreaterThanOrEqual(prev); prev = p;
    }
    expect(pedestrianRisk(5, 'death')).toMatchObject({ probability: null, bound: { below: 0.1 } });
    expect(pedestrianRisk(30, 'death')).toMatchObject({ probability: null, bound: { above: 0.9 } });
    expect(pedestrianRisk(10, 'severe', 9)).toHaveProperty('unsupported');
  });
});

function car(id: string, opts: Partial<Actor> = {}, post: 'free' | 'locked' = 'locked'): [Actor, { postImpact: { wheels: 'free' | 'locked'; source: typeof synthetic } }] {
  const dynamics = syntheticVehicle(); dynamics.brakes.abs = 'ideal';
  return [{ id, kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 0, path: [], color: '#fff', delay: 0,
    flags: { drunk: false, noLicense: false, flees: false }, dynamics, ...opts }, { postImpact: { wheels: post, source: synthetic } }];
}
function dynScene(actors: Actor[], duration = 8): Scene {
  const s = emptyScene(); s.env.physics = 'dynamic'; s.env.duration = duration; s.actors = actors; return s;
}

describe('scene impacts in dynamic mode', () => {
  it('oblique collision: equal and opposite impulse, rotation, energy balance, rest pose, technical risk', () => {
    const [a, pa] = car('a1', { speed: 54, path: [{ x: 200, y: 0, v: 54 }] });
    const [b, pb] = car('a2', { x: 20, y: -15, heading: Math.PI / 2, speed: 36, path: [{ x: 20, y: 100, v: 36 }] });
    const s = dynScene([a, b], 8);
    const tl = simulate(s, { vehicles: { a1: pa, a2: pb } });
    const col = tl.collisions[0];
    expect(col.impact).toBeDefined();
    const im = col.impact!;
    expect(im.target).toBe('vehicle'); expect(im.sequence).toBe(1);
    expect(1500 * im.deltaVA.x + 1500 * im.deltaVB.x).toBeCloseTo(0, 6);
    expect(1500 * im.deltaVA.y + 1500 * im.deltaVB.y).toBeCloseTo(0, 6);
    expect(Math.abs(im.deltaYawRateA) + Math.abs(im.deltaYawRateB)).toBeGreaterThan(0.1);
    expect(im.energyLoss).toBeGreaterThan(0);
    expect(im.energyLoss).toBeCloseTo(im.energyNormal + im.energyTangential, 3);
    expect(tl.physics!.rest!.a1.atRest && tl.physics!.rest!.a2.atRest).toBe(true);
    const ctx = analyzeTechnical(s, tl);
    const risk = ctx.technical.collisions[0].harm[0].trace.injuryRisk as { values: { probability: number }[] };
    expect(risk.values.every(v => v.probability > 0 && v.probability < 1)).toBe(true);
  });
  it('the same pair registers a second impact only after separating (secondary rear-end)', () => {
    // a1 free-rolls (no rolling resistance supplied) into a2, which brakes with locked wheels after the hit.
    const [a, pa] = car('a1', { speed: 36 }, 'free');
    const [b, pb] = car('a2', { x: 15 }, 'locked');
    const tl = simulate(dynScene([a, b], 12), { vehicles: { a1: pa, a2: pb }, impact: { restitution: 0.3, source: synthetic } });
    const pair = tl.collisions.filter(c => c.a === 'a1' && c.b === 'a2');
    expect(pair.length).toBeGreaterThanOrEqual(2);
    expect(pair.map(c => c.impact!.sequence).slice(0, 2)).toEqual([1, 2]);
    expect(pair[1].t).toBeGreaterThan(pair[0].t + 0.1);
  });
  it('secondary impact against an obstacle after the first collision', () => {
    const [a, pa] = car('a1', { speed: 54, path: [{ x: 100, y: 0, v: 54 }] }, 'free');
    const [b, pb] = car('a2', { x: 15, y: -1.6 }, 'locked');
    const s = dynScene([a, b], 6);
    s.obstacles = [{ id: 'o1', x: 21, y: 5, w: 2, h: 30, angle: 0, kind: 'building' }];
    const tl = simulate(s, { vehicles: { a1: pa, a2: pb } });
    expect(tl.collisions.map(c => c.impact?.target)).toContain('vehicle');
    expect(tl.collisions.some(c => c.b === 'o1' && c.impact?.target === 'obstacle')).toBe(true);
  });
  it('guardrail deflects a drifting car; curb stops wheel contacts crossing its line', () => {
    const [a, pa] = car('a1', { speed: 72, heading: 0.15 }, 'free');
    const tl = simulate(dynScene([a], 3), { vehicles: { a1: pa }, barriers: [{ id: 'g1', kind: 'guardrail', points: [{ x: -10, y: 8 }, { x: 200, y: 8 }], restitution: 0.1, contactFriction: 0.3, source: synthetic }] });
    // controlled until impact: start in path mode, then free after the contact.
    const hitG = tl.collisions.find(c => c.b === 'g1');
    expect(hitG?.impact?.target).toBe('guardrail');
    const tr = tl.tracks.get('a1')!;
    expect(Math.max(...tr.y)).toBeLessThan(8 + 0.2);
    const [c, pc] = car('a2', { heading: Math.PI / 2, speed: 18 }, 'free');
    const tl2 = simulate(dynScene([c], 3), { vehicles: { a2: pc }, barriers: [{ id: 'k1', kind: 'curb', points: [{ x: -20, y: 6 }, { x: 20, y: 6 }], restitution: 0, source: synthetic }] });
    expect(tl2.collisions.some(col => col.impact?.target === 'curb')).toBe(true);
    // front axle wheel points stay on the near side of the curb line
    const tr2 = tl2.tracks.get('a2')!;
    expect(Math.max(...tr2.y) + 1.4).toBeLessThan(6 + 0.05);
  });
  it('pedestrian: plastic full impact gives the contact-point velocity, rider/pedestrian as a particle', () => {
    const [a, pa] = car('a1', { speed: 36 });
    const ped: Actor = { id: 'p1', kind: 'pedestrian', type: 'adult', x: 12, y: 0, heading: Math.PI / 2, speed: 0, path: [], color: '#fff', delay: 0,
      flags: { drunk: false, noLicense: false, flees: false } };
    const tl = simulate(dynScene([a, ped], 4), { vehicles: { a1: pa } });
    const col = tl.collisions.find(c => c.b === 'p1')!;
    expect(col.kind).toBe('vp');
    expect(col.impact!.restitution).toBe(0);
    // Central impact: common velocity m1*v/(m1+m2) up to tyre forces within one substep.
    const k = col.frame, vp = tl.tracks.get('p1')!.v[k];
    expect(Math.abs(vp - 1500 * 10 / (1500 + 75))).toBeLessThan(0.15);
  });
});
