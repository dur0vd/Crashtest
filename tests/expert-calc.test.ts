import { describe, expect, it } from 'vitest';
import { CALCULATORS, solveMomentum } from '../src/expert/calc';
import { searleSpeedRange, stiffnessFromTest } from '../src/physics';

const run = (id: string, p: object) => CALCULATORS[id].run(p as never);
const res = (r: ReturnType<typeof run>, i = 0) => {
  if (r.status !== 'ok') throw new Error(JSON.stringify(r.issues));
  return r.records[i].result as Record<string, unknown>;
};

describe('six expert calculators: hand examples, ranges and required inputs', () => {
  it('all method ids are registered with descriptors', () => {
    for (const id of ['expert.braking', 'expert.skid', 'expert.lateral', 'expert.critical-speed', 'expert.throw', 'expert.momentum', 'expert.ees']) {
      expect(CALCULATORS[id].inputs.length).toBeGreaterThan(0);
    }
  });
  it('skid-mark speed with t3: S=20 m, j=6.8, t3=0.35 → 63.66 km/h (both SI and km/h forms by hand)', () => {
    // v = 0.5·6.8·0.35 + √(2·6.8·20) = 1.190 + 16.492 = 17.682 m/s;
    // km/h: 1.8·0.35·6.8 + √(25.92·6.8·20) = 4.284 + 59.373 = 63.657 km/h.
    const r = res(run('expert.braking', { skidLength: { value: 20, min: 19.5, max: 20.5, source: 'рулетка' }, j: 6.8, t3: 0.35 }));
    expect(Math.round((r.speedKmh as number) * 100) / 100).toBe(63.66);
    expect(r.range).toEqual([expect.any(Number), expect.any(Number)]);
    expect((r.range as number[])[0]).toBeLessThan(r.speed as number);
    expect(r.substitution).toMatch(/= 17,682 м\/с$/);
    const missing = run('expert.braking', { j: 6.8 });
    expect(missing.status).toBe('insufficient-data');
    if (missing.status !== 'ok') expect(missing.issues.map(i => i.path).sort()).toEqual(['skidLength', 't3']);
  });
  it('braking calculator chains stopping distance and avoidability when t1/t2/available are given', () => {
    const r = run('expert.braking', { skidLength: 20, j: 6.8, t3: 0.35, t1: { value: 1, min: 0.8, max: 1.2, source: 'эксперт' }, t2: 0.1, available: 60 });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.records.map(x => x.id)).toEqual(['expert.braking.skid-speed', 'expert.braking.stopping-distance', 'expert.braking.avoidability']);
    }
  });
  it('side slip over segments: √(2g(0.7·10 + 0.5·5)) = 13.653 m/s', () => {
    const r = res(run('expert.skid', { segments: [{ length: 10, mu: 0.7 }, { length: 5, mu: { value: 0.5, min: 0.45, max: 0.55 } }] }));
    expect(r.speed as number).toBeCloseTo(Math.sqrt(2 * 9.81 * 9.5), 9);
    expect(res(run('expert.lateral', { segments: [{ length: 10, mu: 0.7 }] })).speed as number).toBeCloseTo(Math.sqrt(2 * 9.81 * 7), 9);
  });
  it('critical speed: chord 30 m, ordinate 2 m → R = 57.25 m; v = √(μgR) flat and banked form', () => {
    const r = res(run('expert.critical-speed', { chord: 30, middleOrdinate: 2, mu: 0.7 }));
    expect(r.radius).toBeCloseTo(57.25, 12);
    expect(r.speed as number).toBeCloseTo(Math.sqrt(0.7 * 9.81 * 57.25), 9);
    const b = res(run('expert.critical-speed', { radius: 57.25, mu: 0.7, superelevation: 0.05, cgOffset: 0.75 }));
    expect(b.speed as number).toBeCloseTo(Math.sqrt(9.81 * 56.5 * 0.75 / (1 - 0.035)), 9);
  });
  it('throw: Searle range and flat-front value equal the pedestrian module', () => {
    const r = res(run('expert.throw', { model: 'searle', front: 'flat-truck-bus', distance: 18, friction: 0.66, launchHeight: 1 }));
    expect(r.nominal as number).toBeCloseTo(searleSpeedRange(18, 0.66, 1)!.max, 12);
    expect(run('expert.throw', { model: 'wood', front: 'low-sedan', distance: 18, friction: 0.66, launchHeight: 1 }).status).toBe('error');
  });
  it('2D momentum recovers synthetic pre-impact speeds and rejects collinear approach directions', () => {
    const m1 = 1500, m2 = 1200, v1 = 15, v2 = 10;
    const P = { x: m1 * v1, y: m2 * v2 }, u = Math.hypot(P.x, P.y) / (m1 + m2), ang = Math.atan2(P.y, P.x);
    const r = res(run('expert.momentum', { vehicles: [
      { mass: m1, approachAngle: 0, postSpeed: u, postAngle: ang }, { mass: m2, approachAngle: Math.PI / 2, postSpeed: u, postAngle: ang }],
      angleUncertainty: 0.02, speedUncertainty: 0.05 }));
    expect(r.v1 as number).toBeCloseTo(v1, 9); expect(r.v2 as number).toBeCloseTo(v2, 9);
    expect((r.energyBefore as number) >= (r.energyAfter as number)).toBe(true);
    expect(((r.bounds as { v1: number[] }).v1[1])).toBeGreaterThan(v1);
    const col = run('expert.momentum', { vehicles: [{ mass: 1, approachAngle: 0, postSpeed: 1, postAngle: 0 }, { mass: 1, approachAngle: 0.01, postSpeed: 1, postAngle: 0 }] });
    expect(col.status).toBe('error');
    expect(solveMomentum([{ mass: 1000, approachAngle: 0, postSlide: { distance: 10, mu: 0.5 }, postAngle: 0.3 }, { mass: 1000, approachAngle: 1.2, postSpeed: 3, postAngle: 0.8 }]).u[0]).toBeCloseTo(Math.sqrt(2 * 0.5 * 9.81 * 10), 12);
  });
  it('EES from crush (Campbell test) and Δv for two vehicles', () => {
    const test = { mass: 1400, speed: 15.6, noDamageSpeed: 2.2, averageCrush: 0.55, width: 1.6, source: 'synthetic' };
    const s = stiffnessFromTest(test);
    const r = run('expert.ees', { vehicles: [
      { mass: 1400, crush: [0.55, 0.55, 0.55, 0.55, 0.55, 0.55], width: 1.6, A: s.A, B: s.B, stiffnessSource: 'synthetic' },
      { mass: 1600, energy: 50000, energySource: 'synthetic' }], restitution: 0.1 });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect((r.records[0].result as { ees: number }).ees).toBeCloseTo(15.6, 9);
      expect(r.records[2].id).toBe('expert.ees.delta-v');
    }
    expect(run('expert.ees', { vehicles: [{ mass: 1400, crush: [0.5, 0.5], width: 1.6, A: 1, B: 1 }] }).status).toBe('insufficient-data');
  });
});
