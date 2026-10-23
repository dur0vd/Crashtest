import { describe, expect, it } from 'vitest';
import { emptyScene, normalizeScene, type Actor, type Scene } from '../src/scene';
import { PhysicsUnsupportedError, simulate, projectOnPath, type Timeline } from '../src/sim';
import { buildPath } from '../src/geom';
import {
  GRAVITY, purePursuitSteer, stanleySteer, BrakeActuator, stepDynamics, syntheticVehicle, pointInZone, resolveSurface, validateZone,
  type DynamicVehicleParameters, type PhysicsZone,
} from '../src/physics';
import { PRESETS } from '../src/presets';

const synthetic = { kind: 'synthetic' as const, description: 'Test fixture only' };
function vehicle(id: string, opts: Partial<Actor> = {}, abs: 'ideal' | 'disabled' = 'ideal'): Actor {
  const dynamics = syntheticVehicle();
  dynamics.brakes.abs = abs;
  return { id, kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 72, path: [], color: '#fff', delay: 0,
    flags: { drunk: false, noLicense: false, flees: false }, dynamics, ...opts };
}
function scene(actors: Actor[], duration = 10, surface: Scene['env']['surface'] = 'dry'): Scene {
  const s = emptyScene();
  s.env.physics = 'dynamic'; s.env.duration = duration; s.env.surface = surface;
  s.actors = actors;
  return s;
}
const restFrame = (tl: Timeline, id: string): number => {
  const tr = tl.tracks.get(id)!;
  for (let k = 1; k < tl.n; k++) if (tr.v[k] === 0 && tr.v[k - 1] > 0) return k;
  return -1;
};

describe('controller geometry against independent analytic cases', () => {
  it('pure pursuit reproduces atan(L/R) for a target on the circle tangent at the rear axle', () => {
    for (const R of [8, 25, 120]) for (const phi of [0.2, 0.6, 1.2]) {
      // circle centre on the right (+y), tangent to the body axis at the rear axle
      const target = { x: R * Math.sin(phi), y: R - R * Math.cos(phi) };
      expect(purePursuitSteer({ x: 0, y: 0 }, 0, target, 2.8, false).steering).toBeCloseTo(Math.atan(2.8 / R), 12);
      const left = { x: target.x, y: -target.y };
      expect(purePursuitSteer({ x: 0, y: 0 }, 0, left, 2.8, false).steering).toBeCloseTo(-Math.atan(2.8 / R), 12);
    }
  });
  it('reverse pure pursuit: the travel-frame circle maps to the opposite wheel angle', () => {
    // Body heading 0, travelling backwards along -x; circle tangent at the rear axle curving to +y.
    const R = 20, phi = 0.5, target = { x: -R * Math.sin(phi), y: R - R * Math.cos(phi) };
    const out = purePursuitSteer({ x: 0, y: 0 }, 0, target, 2.8, true);
    // Travel heading pi, target to its left (negative alpha) => travel curvature -1/R => tan(delta)=L/R.
    expect(out.steering).toBeCloseTo(Math.atan(2.8 / R), 12);
    // Kinematic check: u<0, r=u*tan(delta)/L turns the travel direction towards the target.
    const u = -5, r = u * Math.tan(out.steering) / 2.8;
    expect(Math.sign(r)).toBe(-1);
  });
  it('stanley: heading error plus atan(k e/(ks+v)) with the documented sign', () => {
    expect(stanleySteer(0, 0.1, 0, 10, 2, 1).steering).toBeCloseTo(0.1, 12);
    expect(stanleySteer(0, 0, 1, 10, 2, 1).steering).toBeCloseTo(-Math.atan(2 / 11), 12);
    expect(stanleySteer(0, 0, -1, 10, 2, 1).steering).toBeCloseTo(Math.atan(2 / 11), 12);
  });
  it('brake actuator: pure delay t2 and linear rise over t3 from the delayed onset', () => {
    const a = new BrakeActuator({ lag: 0.2, rise: 0.4, source: synthetic });
    a.command(1, 0.5);
    expect(a.applied(1.1)).toBe(0);
    expect(a.applied(1.2)).toBe(0);
    expect(a.applied(1.4)).toBeCloseTo(0.25, 12);
    expect(a.applied(1.6)).toBeCloseTo(0.5, 12);
    expect(a.applied(2)).toBeCloseTo(0.5, 12);
    a.command(2, 0);
    expect(a.applied(2.2)).toBe(0);
  });
  it('windowed projection never jumps to an overlapping earlier part of the route', () => {
    const path = buildPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 0.1 }], false);
    expect(projectOnPath(path, { x: 5, y: 0.05 }, 30, 40).s).toBeGreaterThan(30);
    expect(projectOnPath(path, { x: 5, y: 0.05 }, 0, 10).s).toBeCloseTo(5, 1);
  });
});

describe('dynamic scene mode: route intent through the force model', () => {
  it('hazard braking reproduces S=v(t1+t2+0.5t3)+v²/(2j) within 1 % (exact ramp form within 0.1 %)', () => {
    for (const [v, j, t1, t2, t3] of [[20, 6, 1.0, 0.2, 0.4], [15, 4, 0.8, 0.1, 0.35], [25, 6.5, 1.2, 0.3, 0.6]]) {
      const s = scene([vehicle('a1', { speed: v * 3.6 })], 12);
      const tl = simulate(s, { vehicles: { a1: {
        braking: { t2: { value: t2, source: 'test' }, t3: { value: t3, source: 'test' } },
        hazard: { at: 0.5, reaction: t1, deceleration: j, steering: 'track', source: synthetic },
      } }, substepSeconds: 0.001 });
      const tr = tl.tracks.get('a1')!;
      const k0 = Math.round(0.5 / tl.dt), kRest = restFrame(tl, 'a1');
      expect(kRest).toBeGreaterThan(k0);
      const travelled = tr.x[tl.n - 1] - tr.x[k0];
      const approx = v * (t1 + t2 + 0.5 * t3) + v * v / (2 * j);
      const exact = approx - j * t3 * t3 / 24;
      expect(Math.abs(travelled / approx - 1)).toBeLessThan(0.01);
      expect(Math.abs(travelled / exact - 1)).toBeLessThan(0.001);
      expect(Math.abs(tr.y[tl.n - 1])).toBeLessThan(1e-3);
      expect(tl.physics!.brakeTiming!.a1.lag).toBe(t2);
    }
  });
  it('without t2/t3 the actuator is explicitly ideal and reported as an assumption', () => {
    const tl = simulate(scene([vehicle('a1')], 3), { vehicles: { a1: { hazard: { at: 0, reaction: 1, deceleration: 5, steering: 'hold', source: synthetic } } } });
    expect(tl.physics!.brakeTiming!.a1).toMatchObject({ lag: 0, rise: 0 });
    expect(tl.physics!.assumptions.join(' ')).toMatch(/идеальный привод/);
  });
  it('friction-limited curve: tyres saturate and the car leaves the drawn route instead of riding rails', () => {
    // Circle of radius 40 m drawn as waypoints; vcrit=sqrt(mu g R).
    const R = 40, mu = 0.4, vcrit = Math.sqrt(mu * GRAVITY * R);
    const route = (v: number) => Array.from({ length: 24 }, (_, i) => {
      const a = (i + 1) * Math.PI / 16;
      return { x: R * Math.sin(a), y: R - R * Math.cos(a), v: v * 3.6 };
    });
    const maxDev = (v: number) => {
      const tl = simulate(scene([vehicle('a1', { speed: v * 3.6, path: route(v) })], 6, 'wet'));
      const tr = tl.tracks.get('a1')!;
      let dev = 0;
      for (let k = 0; k < tl.n; k++) dev = Math.max(dev, Math.abs(Math.hypot(tr.x[k], tr.y[k] - R) - R));
      return dev;
    };
    expect(maxDev(0.8 * vcrit)).toBeLessThan(1.0);
    expect(maxDev(1.2 * vcrit)).toBeGreaterThan(3.0);
  });
  it('pure pursuit and Stanley both track a gentle curve at moderate speed', () => {
    for (const method of ['pure-pursuit', 'stanley'] as const) {
      const path = [{ x: 30, y: 0, v: 36 }, { x: 60, y: 6, v: 36 }, { x: 90, y: 20, v: 36 }, { x: 120, y: 40, v: 36 }];
      const tl = simulate(scene([vehicle('a1', { speed: 36, path })], 18), { vehicles: { a1: { controller: { method } } } });
      const tr = tl.tracks.get('a1')!;
      expect(tl.physics!.controllers!.a1.method).toBe(method);
      expect(tr.waypointTimes!.every(t => t > 0)).toBe(true);
      expect(Math.hypot(tr.x[tl.n - 1] - 120, tr.y[tl.n - 1] - 40)).toBeGreaterThan(0); // continues past the end
    }
  });
  it('stop waypoint, hold and reverse are reached physically with recorded actual times', () => {
    const path = [{ x: 30, y: 0, v: 0, hold: 1 }, { x: 15, y: 0, v: -10 }, { x: 5, y: 0, v: 0 }];
    const tl = simulate(scene([vehicle('a1', { speed: 36, path })], 20));
    const tr = tl.tracks.get('a1')!;
    const [t1, t2, t3] = tr.waypointTimes!;
    expect(t1).toBeGreaterThan(0); expect(t2).toBeGreaterThan(t1 + 1); expect(t3).toBeGreaterThan(t2);
    const k1 = Math.round(t1 / tl.dt);
    expect(Math.abs(tr.x[k1] - 30)).toBeLessThan(0.6);
    expect(tr.v[k1]).toBe(0);
    expect([...tr.reversing!].some(Boolean)).toBe(true);
    expect(Math.abs(tr.x[tl.n - 1] - 5)).toBeLessThan(0.6);
    expect(tr.v[tl.n - 1]).toBe(0);
  });
  it('deterministic: identical inputs give identical tracks and samples', () => {
    const make = () => scene([vehicle('a1', { path: [{ x: 50, y: 10, v: 40 }, { x: 100, y: 0, v: 0 }] })], 8);
    const a = simulate(make()), b = simulate(make());
    const ta = a.tracks.get('a1')!, tb = b.tracks.get('a1')!;
    expect([...ta.x]).toEqual([...tb.x]); expect([...ta.h]).toEqual([...tb.h]);
    expect([...ta.dynamics!.wheelFy]).toEqual([...tb.dynamics!.wheelFy]);
  });
  it('substep 5 ms vs 1 ms: stopping point converges within 5 cm', () => {
    const run = (dt: number) => {
      const tl = simulate(scene([vehicle('a1', { speed: 54, path: [{ x: 60, y: 0, v: 0 }] })], 8), { substepSeconds: dt });
      return tl.tracks.get('a1')!.x[tl.n - 1];
    };
    expect(Math.abs(run(0.005) - run(0.001))).toBeLessThan(0.05);
  });
});

describe('measured zones and grades', () => {
  const zone = (id: string, x0: number, x1: number, extra: Partial<PhysicsZone>): PhysicsZone => ({
    id, boundary: [{ x: x0, y: -20 }, { x: x1, y: -20 }, { x: x1, y: 20 }, { x: x0, y: 20 }], source: { kind: 'measured', description: 'test zone' }, ...extra });
  it('closed boundary, field-wise priority and ambiguity are explicit', () => {
    const z1 = zone('z1', 0, 10, { mu: 0.8 }), z2 = zone('z2', 5, 15, { mu: 0.3, priority: 1 }), z3 = zone('z3', 5, 15, { mu: 0.5 });
    expect(pointInZone({ x: 10, y: 0 }, z1.boundary)).toBe(true);
    const fallback = { mu: 0.7, source: synthetic };
    expect(resolveSurface({ x: 7, y: 0 }, [z1, z2], fallback).mu).toBe(0.3);
    expect(() => resolveSurface({ x: 7, y: 0 }, [z1, z3], fallback)).toThrow(/неоднозначное/);
    const out = resolveSurface({ x: 30, y: 0 }, [z1], fallback);
    expect(out).toMatchObject({ mu: 0.7, muKnown: false, gradeKnown: false });
    expect(resolveSurface({ x: 1, y: 0 }, [zone('g', 0, 2, { gradeLongitudinal: 0.05, direction: Math.PI / 2 })], fallback).grade).toMatchObject({ x: expect.closeTo(0, 12), y: 0.05 });
    expect(() => validateZone(zone('g', 0, 2, { gradeLongitudinal: 0.05 }))).toThrow(/направления/);
  });
  it('braking across a mu boundary changes deceleration exactly at the boundary (locked wheels)', () => {
    const zones = [zone('high', -100, 20, { mu: 0.8 }), zone('low', 20, 400, { mu: 0.2 })];
    const tl = simulate(scene([vehicle('a1', { speed: 72 }, 'disabled')], 12), { zones,
      vehicles: { a1: { hazard: { at: 0, reaction: 0, deceleration: 20, steering: 'hold', source: synthetic } } }, substepSeconds: 0.001 });
    const tr = tl.tracks.get('a1')!, sm = tr.dynamics!;
    // Independent piecewise balance with per-wheel crossing (lf=lr=1.4, h=0.5):
    // all wheels high mu until CG 18.6; front on 0.2, rear on 0.8 until CG 21.4, where
    // m*a=muF*Fzf+muR*Fzr, Fzf=m(g*lr+a*h)/L => a=g(muF*lr+muR*lf)/(L-(muF-muR)h); then 0.2g.
    const g = GRAVITY, a2 = g * (0.2 * 1.4 + 0.8 * 1.4) / (2.8 - (0.2 - 0.8) * 0.5);
    const v2a = 400 - 2 * 0.8 * g * 18.6, v2b = v2a - 2 * a2 * 2.8;
    const expectedStop = 21.4 + v2b / (2 * 0.2 * g);
    expect(Math.abs(tr.x[tl.n - 1] - expectedStop) / expectedStop).toBeLessThan(0.01);
    expect(sm.zone.includes('high') && sm.zone.includes('low')).toBe(true);
    expect(sm.muKnown.every(v => v === 1)).toBe(true);
  });
  it('slope: free rolling accelerates at g*sin(theta); locked braking downhill uses mu*cos - sin', () => {
    const p: DynamicVehicleParameters = syntheticVehicle(); p.brakes.abs = 'disabled';
    const grade = 0.1, sin = grade / Math.sqrt(1 + grade * grade), cos = 1 / Math.sqrt(1 + grade * grade);
    // Uphill along +x: z = 0.1 x. Coasting downhill from rest along -x.
    const road = { mu: 0.6, source: synthetic, grade: { x: grade, y: 0, source: synthetic } };
    let s = { x: 0, y: 0, heading: 0, vx: 0, vy: 0, yawRate: 0, ax: 0, ay: 0 };
    for (let k = 0; k < 80; k++) s = stepDynamics(s, p, { steering: 0, drive: 0, brake: 0 }, road).state;
    expect(s.vx / 2).toBeCloseTo(-GRAVITY * sin, 6);
    // Locked braking while moving downhill at 15 m/s.
    let b = { x: 0, y: 0, heading: Math.PI, vx: -15, vy: 0, yawRate: 0, ax: 0, ay: 0 };
    for (let k = 0; k < 400; k++) b = stepDynamics(b, p, { steering: 0, drive: 0, brake: 1 }, road, { substepSeconds: 0.001 }).state;
    expect(b.vx).toBe(0);
    const expected = 225 / (2 * GRAVITY * (0.6 * cos - sin));
    expect(Math.abs(-b.x / expected - 1)).toBeLessThan(0.01);
  });
  it('static hold on a slope with the brake applied; insufficient friction slides', () => {
    const p = syntheticVehicle(); p.brakes.abs = 'ideal';
    const rest = { x: 0, y: 0, heading: 0, vx: 0, vy: 0, yawRate: 0, ax: 0, ay: 0 };
    const held = stepDynamics(rest, p, { steering: 0, drive: 0, brake: 1 }, { mu: 0.7, source: synthetic, grade: { x: 0.15, y: 0, source: synthetic } }, { trace: true });
    expect(held.state.x).toBe(0); expect(held.trace!.substeps.every(s => s.staticHold)).toBe(true);
    const slides = stepDynamics(rest, p, { steering: 0, drive: 0, brake: 1 }, { mu: 0.05, source: synthetic, grade: { x: 0.15, y: 0, source: synthetic } });
    expect(slides.state.vx).toBeLessThan(0);
  });
  it('roughness is stored and reported, never converted into a friction multiplier', () => {
    const zones = [zone('rough', -50, 200, { roughness: { kind: 'iri', value: 6, source: { kind: 'measured', description: 'test IRI' } } })];
    const tl = simulate(scene([vehicle('a1')], 2), { zones });
    expect(tl.physics!.assumptions.join(' ')).toMatch(/Неровность/);
    expect(tl.tracks.get('a1')!.dynamics!.mu.every(m => Math.abs(m - 0.7) < 1e-6)).toBe(true);
  });
});

describe('explicit unsupported classes and per-actor models', () => {
  it('car without parameters, unknown ABS and carts are listed; never silently kinematic', () => {
    const plain = vehicle('a1'); delete plain.dynamics;
    const unknownAbs = vehicle('a2'); unknownAbs.dynamics!.brakes.abs = 'unknown';
    try {
      simulate(scene([plain, unknownAbs]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PhysicsUnsupportedError);
      expect((error as PhysicsUnsupportedError).issues.map(i => [i.actorId, i.code])).toEqual([['a1', 'missing-parameters'], ['a2', 'abs-unknown']]);
    }
  });
  it('pedestrians keep their own model with an explicit method label', () => {
    const ped: Actor = { id: 'p1', kind: 'pedestrian', type: 'adult', x: 40, y: -5, heading: Math.PI / 2, speed: 5, path: [{ x: 40, y: 5, v: 5 }],
      color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } };
    const tl = simulate(scene([vehicle('a1', { speed: 36 }), ped], 6));
    expect(tl.physics!.methods).toEqual({ a1: 'dynamic-four-wheel', p1: 'pedestrian-kinematic' });
    expect(tl.physics!.assumptions.join(' ')).toMatch(/p1: собственная модель pedestrian-kinematic/);
  });
  it('env.physics survives normalisation; invalid values are dropped', () => {
    const s = scene([]);
    expect(normalizeScene(JSON.parse(JSON.stringify(s))).env.physics).toBe('dynamic');
    expect(normalizeScene({ ...s, env: { ...s.env, physics: 'magic' } }).env.physics).toBeUndefined();
  });
});

describe('all presets in both modes: finite result or explicit unsupported class', () => {
  const fourWheel = ['car', 'suv', 'van', 'truck', 'bus', 'trolleybus'];
  it.each(PRESETS.map(p => [p.id, p] as const))('%s', (_id, preset) => {
    const base = preset.build();
    const kin = simulate(structuredClone(base));
    expect(kin.physics!.mode).toBe('kinematic');
    // (a) as authored: dynamic mode lists every four-wheel vehicle/cart without parameters.
    const authored = structuredClone(base); authored.env.physics = 'dynamic';
    const expected = base.actors.filter(a => a.kind === 'vehicle' && !a.railwayTrain && (fourWheel.includes(a.type) || a.type === 'cart')).map(a => a.id);
    if (expected.length) {
      expect(() => simulate(authored)).toThrow(PhysicsUnsupportedError);
      try { simulate(authored); } catch (error) { expect((error as PhysicsUnsupportedError).issues.map(i => i.actorId)).toEqual(expected); }
    } else {
      const tl = simulate(authored);
      for (const tr of tl.tracks.values()) for (const series of [tr.x, tr.y, tr.h, tr.v]) expect([...series].every(Number.isFinite)).toBe(true);
    }
    // (b) explicit synthetic verification parameters for passenger cars only; other classes stay unsupported.
    const withCars = structuredClone(authored);
    for (const a of withCars.actors) if (a.kind === 'vehicle' && a.type === 'car' && !a.cargo?.mass) {
      a.dynamics = syntheticVehicle(); a.dynamics.brakes.abs = 'ideal';
    }
    const remaining = withCars.actors.filter(a => a.kind === 'vehicle' && !a.railwayTrain && (fourWheel.includes(a.type) || a.type === 'cart') && !a.dynamics).map(a => a.id);
    if (remaining.length) expect(() => simulate(withCars)).toThrow(PhysicsUnsupportedError);
    else {
      const tl = simulate(withCars);
      expect(tl.physics!.mode).toBe('dynamic');
      for (const tr of tl.tracks.values()) for (const series of [tr.x, tr.y, tr.h, tr.v]) expect([...series].every(Number.isFinite)).toBe(true);
    }
  });
});
