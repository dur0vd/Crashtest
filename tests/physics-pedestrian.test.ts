import { describe, expect, it } from 'vitest';
import {
  GRAVITY, KNOBLAUCH_1996, pedestrianPace, searleLaunchSpeed, searleSpeedRange, searleThrow, slideDistance, syntheticVehicle,
  throwSpeedRange, woodImpactSpeed, woodThrowDistance,
} from '../src/physics';
import { emptyScene, type Actor } from '../src/scene';
import { simulate } from '../src/sim';

const synthetic = { kind: 'synthetic' as const, description: 'Test fixture only' };
const g = GRAVITY;

describe('pedestrian pace: only sourced values', () => {
  it('Knoblauch et al. 1996 15th-percentile and design values by age group', () => {
    expect(pedestrianPace({ age: 30, gait: 'walk', statistic: '15th-percentile' })).toMatchObject({ speed: 1.25 });
    expect(pedestrianPace({ age: 70, gait: 'walk', statistic: '15th-percentile' })).toMatchObject({ speed: 0.97 });
    expect(pedestrianPace({ age: 40, gait: 'walk', statistic: 'design' })).toMatchObject({ speed: 1.22 });
    expect(pedestrianPace({ age: 80, gait: 'walk', statistic: 'design' })).toMatchObject({ speed: 0.91 });
    expect(pedestrianPace({ age: 8, gait: 'walk', statistic: 'design' })).toHaveProperty('unsupported');
    expect(pedestrianPace({ age: 30, gait: 'run', statistic: 'design' })).toHaveProperty('unsupported');
    expect(KNOBLAUCH_1996.limitations.join(' ')).toMatch(/TODO\(source-check\)/);
  });
});

describe('throw models against published forms and independent integration', () => {
  it('Searle (h=0) equals Becker et al. 2015 eq. 33 and the 59° sliding boundary for mu=0.6', () => {
    const mu = 0.6;
    for (const [v, th] of [[10, 0], [13.4112, 0.35], [8, 0.9]]) {
      const D = searleThrow(v, th, mu).total;
      expect(Math.sqrt(2 * g * mu * D) / (Math.cos(th) + mu * Math.sin(th))).toBeCloseTo(v, 9);
      expect(searleLaunchSpeed(D, th, mu)).toBeCloseTo(v, 9);
    }
    const boundary = Math.atan(1 / mu) * 180 / Math.PI;
    expect(boundary).toBeCloseTo(59.04, 2); // the published boundary angle is quoted as 59 degrees
    expect(searleThrow(13.4112, (boundary - 0.5) * Math.PI / 180, mu).slides).toBe(true);
    expect(searleThrow(13.4112, (boundary + 0.5) * Math.PI / 180, mu).slides).toBe(false);
  });
  it('closed form with launch height equals an independent small-step integration of flight, landing and slide', () => {
    for (const [v, th, mu, h] of [[12, 0.2, 0.66, 1.0], [8, 0, 0.5, 0.9], [15, 0.4, 0.8, 1.2]]) {
      // projectile
      let x = 0, z = h, vx = v * Math.cos(th), vz = v * Math.sin(th);
      const dt = 1e-6;
      while (z > 0) { x += vx * dt; vz -= g * dt; z += vz * dt; }
      // landing impulse, then slide
      vx = Math.max(0, vx - mu * Math.abs(vz));
      x += vx * vx / (2 * mu * g);
      expect(Math.abs(searleThrow(v, th, mu, h).total - x)).toBeLessThan(2e-3);
      expect(searleThrow(v, th, mu, h).total).toBeCloseTo((v * (Math.cos(th) + mu * Math.sin(th))) ** 2 / (2 * mu * g) + mu * h, 9);
    }
  });
  it('Searle speed bounds: minimum at tan(theta)=mu equals sqrt(2 mu g (D - mu h)/(1+mu²))', () => {
    const mu = 0.7, h = 1, D = 20, r = searleSpeedRange(D, mu, h)!;
    expect(r.min).toBeCloseTo(Math.sqrt(2 * mu * g * (D - mu * h) / (1 + mu * mu)), 12);
    expect(searleLaunchSpeed(D, Math.atan(mu), mu, h)).toBeCloseTo(r.min, 9);
    let solved = 0;
    for (let th = 0; th <= r.maxAngleRange[1]; th += 0.05) {
      const v = searleLaunchSpeed(D, th, mu, h);
      if (v === null) continue; // with h>0 the steepest launches may not slide after landing
      solved++;
      expect(v).toBeGreaterThanOrEqual(r.min - 1e-9);
      expect(v).toBeLessThanOrEqual(r.max + 1e-9);
    }
    expect(solved).toBeGreaterThan(10);
  });
  it('Wood (as reproduced by Soica 2018, eq. 2) and its forward form are consistent with a plastic horizontal launch', () => {
    const mv = 1300, mp = 75, mu = 0.66, h = 1.0, V = 14;
    const D = woodThrowDistance(V, mu, h, mv, mp);
    expect(woodImpactSpeed(D, mu, h, mv, mp)).toBeCloseTo(V, 10);
    expect(woodImpactSpeed(D, mu, h, mv, mp)).toBeCloseTo((mv + mp) / mv * Math.sqrt(2 * mu * g * (D - mu * h)), 12);
    const vp = V * mv / (mv + mp);
    // Plastic common speed, theta=0 Searle launch with the sliding condition: identical distance.
    expect(searleThrow(vp, 0, mu, 0).total + mu * h).toBeCloseTo(D, 9);
    expect(woodImpactSpeed(0.5, mu, h, mv, mp)).toBeNull();
  });
  it('inverse problem on synthetic data recovers the impact speed and brackets it under parameter ranges', () => {
    const mu = 0.66, h = 1.0, vTrue = 12;
    const D = searleThrow(vTrue, 0, mu, h).total;
    const exact = throwSpeedRange({ model: 'searle', front: 'flat-truck-bus', distance: { value: D }, friction: { value: mu }, launchHeight: { value: h } });
    expect('min' in exact && exact.nominal).toBeCloseTo(vTrue, 9);
    const ranged = throwSpeedRange({ model: 'searle', front: 'low-sedan', distance: { value: D, min: D - 0.5, max: D + 0.5 },
      friction: { value: mu, min: 0.45, max: 0.79 }, launchHeight: { value: h, min: 0.9, max: 1.1 } });
    if (!('min' in ranged)) throw new Error('unexpected');
    expect(ranged.min).toBeLessThan(vTrue); expect(ranged.max).toBeGreaterThan(vTrue);
    expect(ranged.nominal).toBeNull(); // launch angle unknown for a low front: only a range
    const wood = throwSpeedRange({ model: 'wood', front: 'low-sedan', distance: { value: woodThrowDistance(15, mu, h, 1400, 75) }, friction: { value: mu }, launchHeight: { value: h }, vehicleMass: 1400, pedestrianMass: 75 });
    expect('min' in wood && wood.nominal).toBeCloseTo(15, 9);
    expect(throwSpeedRange({ model: 'wood', front: 'low-sedan', distance: { value: 10 }, friction: { value: mu }, launchHeight: { value: h } })).toHaveProperty('insufficient');
  });
});

function car(speed: number): Actor {
  const dynamics = syntheticVehicle(); dynamics.brakes.abs = 'ideal';
  return { id: 'a1', kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed, path: [], color: '#fff', delay: 0,
    flags: { drunk: false, noLicense: false, flees: false }, dynamics };
}

describe('scene: pedestrian phases and two-wheeler fall with a separate rider (dynamic mode)', () => {
  it('pedestrian rest distance from the impact equals the closed-form flight + slide for its post-impact speed', () => {
    const s = emptyScene(); s.env.physics = 'dynamic'; s.env.duration = 6;
    const ped: Actor = { id: 'p1', kind: 'pedestrian', type: 'adult', x: 15, y: 0, heading: Math.PI / 2, speed: 0, path: [], color: '#fff', delay: 0,
      flags: { drunk: false, noLicense: false, flees: false } };
    s.actors = [car(36), ped];
    const theta = 0.15, h = 1.0, mu = 0.66;
    const tl = simulate(s, { vehicles: { a1: { hazard: { at: 0.5, reaction: 0.6, deceleration: 7, steering: 'hold', source: synthetic } } },
      vulnerable: { p1: { throw: { launchAngle: theta, launchHeight: h, friction: mu, source: synthetic } } } });
    const col = tl.collisions.find(c => c.b === 'p1')!;
    const vh = Math.hypot(col.impact!.deltaVB.x, col.impact!.deltaVB.y); // pedestrian was at rest
    const expected = searleThrow(vh / Math.cos(theta), theta, mu, h).total;
    const tr = tl.tracks.get('p1')!;
    const travelled = Math.hypot(tr.x[tl.n - 1] - col.point.x, tr.y[tl.n - 1] - col.point.y);
    expect(Math.abs(travelled - expected)).toBeLessThan(0.35);
    expect(tr.v[tl.n - 1]).toBe(0);
  });
  it('motorcycle falls and slides; rider separates conserving momentum and slides to rest by its own friction', () => {
    const s = emptyScene(); s.env.physics = 'dynamic'; s.env.duration = 8;
    const moto: Actor = { id: 'm1', kind: 'vehicle', type: 'motorcycle', x: 14, y: -12, heading: Math.PI / 2, speed: 36, path: [{ x: 14, y: 40, v: 36 }],
      color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } };
    s.actors = [car(36), moto];
    const tw = { vehicleFriction: 0.5, riderFriction: 0.7, riderMass: 80, riderLaunchHeight: 1.0, riderSeparation: 'pre-impact-velocity' as const, source: synthetic };
    const tl = simulate(s, { vehicles: { a1: { postImpact: { wheels: 'locked', source: synthetic } } }, vulnerable: { m1: { twoWheeler: tw } } });
    const col = tl.collisions.find(c => c.b === 'm1' || c.a === 'm1')!;
    expect(col).toBeDefined();
    const rider = tl.physics!.riders!.m1;
    expect([...rider.present].some(Boolean)).toBe(true);
    expect(rider.rest!.atRest).toBe(true);
    expect(tl.tracks.get('m1')!.v[tl.n - 1]).toBe(0);
    // Rider: horizontal launch at the pre-impact motorcycle speed (10 m/s) from 1 m, then slide at 0.7 g.
    const k0 = [...rider.present].indexOf(1);
    const start = { x: rider.x[k0], y: rider.y[k0] };
    const expectedRider = searleThrow(10, 0, 0.7, 1.0).total;
    const riderTravel = Math.hypot(rider.x[tl.n - 1] - start.x, rider.y[tl.n - 1] - start.y);
    expect(Math.abs(riderTravel - expectedRider)).toBeLessThan(0.4); // first sample is up to one frame after separation
    expect(slideDistance(10, 0.5)).toBeCloseTo(100 / (2 * 0.5 * g), 12);
  });
  it('vulnerable inputs are validated against the actor model', () => {
    const s = emptyScene(); s.env.physics = 'dynamic'; s.actors = [car(36)];
    expect(() => simulate(s, { vulnerable: { a1: { throw: { launchAngle: 0, launchHeight: 1, friction: 0.6, source: synthetic } } } })).toThrow(/только к пешеходу/);
  });
});
