import { describe, expect, it } from 'vitest';
import {
  REGULATORY_SERVICE_BRAKE, T1_TABLE, assessAvoidability, brakeTiming, hazardMoments, lineOfSight, reactionTime, safeSpeed,
  segmentHitsObb, steadyDeceleration, stoppingDistance, visibilityTimeline, yellowServiceStop, type ExpertValue,
} from '../src/expert';
import { emptyScene, type Actor } from '../src/scene';
import { simulate } from '../src/sim';

const ev = (value: number, min = value, max = value): ExpertValue => ({ value, min, max, origin: 'override', source: 'test', notes: [] });

describe('stopping distance with t1–t3: hand example to the centimetre', () => {
  it('V=60 km/h, t1=1.0 s, t2=0.1 s, t3=0.35 s, j=6.8 m/s²', () => {
    // By hand: v=60/3.6=16.6667 m/s; T=1.0+0.1+0.175=1.275 s; v·T=21.250 m;
    // v²/(2j)=277.778/13.6=20.425 m; S=41.675 m (41.67–41.68).
    expect(Math.round(stoppingDistance(60 / 3.6, 1.0, 0.1, 0.35, 6.8) * 100) / 100).toBe(41.67);
    // Practice form with 26 in the denominator: 21.250 + 3600/(26·6.8)=21.250+20.362=41.612 m.
    expect(Math.round(stoppingDistance(60 / 3.6, 1.0, 0.1, 0.35, 6.8, 'denominator-26') * 100) / 100).toBe(41.61);
  });
  it('safe speed inverts the stopping distance exactly', () => {
    for (const S of [10, 35, 80]) {
      const v = safeSpeed(S, 0.8, 0.1, 0.4, 6.5);
      expect(stoppingDistance(v, 0.8, 0.1, 0.4, 6.5)).toBeCloseTo(S, 9);
    }
  });
});

describe('avoidability over parameter ranges with an explicit boundary t1', () => {
  const base = { v0: 15, t2: ev(0.1), t3: ev(0.35), j: ev(6.8, 6.0, 7.5) };
  it('could / could-not / depends and the boundary t1 reproduces the available distance', () => {
    const S = (t1: number, j: number) => stoppingDistance(15, t1, 0.1, 0.35, j);
    expect(assessAvoidability({ ...base, available: S(1.4, 6.0) + 0.5, t1: ev(1, 0.6, 1.4) }).result.verdict).toBe('could');
    expect(assessAvoidability({ ...base, available: S(0.6, 7.5) - 0.5, t1: ev(1, 0.6, 1.4) }).result.verdict).toBe('could-not');
    const mid = assessAvoidability({ ...base, available: S(1.0, 6.8), t1: ev(1, 0.6, 1.4) });
    expect(mid.result.verdict).toBe('depends');
    expect(mid.result.boundaryT1).toBeCloseTo(1.0, 9);
    expect(mid.formula).toMatch(/0,5·t3/);
    expect(mid.result.substitution).toMatch(/= 19,125 \+ 16,544 = 35,669 м$/); // 15·1,275 and 225/13,6 by hand
  });
  it('without confirmed tables t1/t2/t3 are insufficient unless entered with a source; overrides are recorded', () => {
    expect(T1_TABLE.every(r => r.value === null && /TODO\(legal-check\)/.test(r.status))).toBe(true);
    expect(reactionTime('sudden-hazard')).toHaveProperty('insufficient');
    const t1 = reactionTime('sudden-hazard', { value: 1.2, min: 0.8, max: 1.4, source: 'эксперт, протокол №1' });
    expect(t1).toMatchObject({ value: 1.2, origin: 'override' });
    expect(brakeTiming('t3')).toHaveProperty('insufficient');
    expect(() => reactionTime('sudden-hazard', { value: 1, source: '' })).toThrow(/источник/);
  });
  it('j: expert value wins; otherwise derived from measured mu with the regulatory lower bound of a serviceable vehicle', () => {
    expect(REGULATORY_SERVICE_BRAKE.find(r => r.category === 'M1')).toMatchObject({ steadyDecelMin: 4.9, actuationTimeMax: 0.6, stoppingDistanceMax: 16.6 });
    expect(REGULATORY_SERVICE_BRAKE.find(r => r.category === 'N2/N3')).toMatchObject({ steadyDecelMin: 4.4, actuationTimeMax: 0.8 });
    const dry = steadyDeceleration({ mu: 0.8, category: 'M1' });
    expect(dry).toMatchObject({ min: 4.9, origin: 'derived' });
    expect((dry as ExpertValue).max).toBeCloseTo(0.8 * 9.81, 12);
    const ice = steadyDeceleration({ mu: 0.1, category: 'M1' }) as ExpertValue;
    expect(ice.min).toBeCloseTo(0.981, 12); expect(ice.max).toBeCloseTo(0.981, 12);
    expect(steadyDeceleration({})).toHaveProperty('insufficient');
  });
  it('yellow: service braking with t1–t3 against the stop-line distance', () => {
    const rec = yellowServiceStop({ v0: 13.9, distanceToStopLine: 40, t1: ev(1, 0.8, 1.2), t2: ev(0.1), t3: ev(0.35), jService: ev(3, 2.5, 3.5) });
    const S = stoppingDistance(13.9, 1, 0.1, 0.35, 3);
    expect((rec.result as { serviceStoppingDistance: number }).serviceStoppingDistance).toBeCloseTo(S, 9);
    const room = 40 - 13.9 * 1.275;
    expect((rec.result as { requiredDeceleration: number }).requiredDeceleration).toBeCloseTo(13.9 ** 2 / (2 * room), 9);
    expect(rec.assumptions.join(' ')).toMatch(/модуль правил/);
  });
});

describe('2D visibility', () => {
  it('segment/OBB clipping, occluding building, A-pillar sector and measured visibility distance', () => {
    const wall = { cx: 10, cy: 0, hl: 1, hw: 3, a: 0 };
    expect(segmentHitsObb({ x: 0, y: 0 }, { x: 20, y: 0 }, wall)).toBe(true);
    expect(segmentHitsObb({ x: 0, y: 5 }, { x: 20, y: 5 }, wall)).toBe(false);
    const target = { cx: 20, cy: 0, hl: 0.25, hw: 0.25, a: 0 };
    expect(lineOfSight({ eye: { x: 0, y: 0 }, heading: 0, target, occluders: [{ id: 'b1', kind: 'building', box: wall }] })).toMatchObject({ visible: false, blockedBy: ['b1'] });
    expect(lineOfSight({ eye: { x: 0, y: 0 }, heading: 0, target, occluders: [] }).visible).toBe(true);
    expect(lineOfSight({ eye: { x: 0, y: 0 }, heading: 0, target, occluders: [], visibilityDistance: 15 }).visible).toBe(false);
    expect(lineOfSight({ eye: { x: 0, y: 0 }, heading: Math.PI / 4, target, occluders: [], pillars: [{ fromDeg: -50, toDeg: -40, source: 'замер стойки' }] }).visible).toBe(false);
  });
  it('scene: a pedestrian behind a building becomes visible later than entering the road; hazard candidates are listed', () => {
    const s = emptyScene(); s.env.duration = 8;
    s.roads = [{ id: 'r1', pts: [{ x: -50, y: 0 }, { x: 150, y: 0 }], lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false }];
    s.obstacles = [{ id: 'b1', x: 45, y: -8.5, w: 10, h: 9, angle: 0, kind: 'building' }];
    const car: Actor = { id: 'a1', kind: 'vehicle', type: 'car', x: 0, y: 2, heading: 0, speed: 36, path: [{ x: 120, y: 2, v: 36 }], color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } };
    const ped: Actor = { id: 'p1', kind: 'pedestrian', type: 'adult', x: 52, y: -9, heading: Math.PI / 2, speed: 7.4, path: [{ x: 52, y: 12, v: 7.4 }], color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } };
    s.actors = [car, ped];
    const tl = simulate(s);
    const vis = visibilityTimeline(s, tl, 'a1', 'p1', { visibilityDistance: { value: 60, source: 'эксперимент на месте' } });
    expect(vis.frames.some(f => !f.visible && f.blockedBy.includes('b1'))).toBe(true);
    const hz = hazardMoments(s, tl, 'a1', 'p1', { directionChangeDeg: 30, visibility: { visibilityDistance: { value: 60, source: 'эксперимент' } } });
    const byCrit = Object.fromEntries(hz.candidates.map(c => [c.criterion, c]));
    expect(byCrit['entered-carriageway']).toBeDefined();
    expect(byCrit['became-visible']).toBeDefined();
    expect(byCrit['entered-vehicle-lane'].t).toBeGreaterThanOrEqual(byCrit['entered-carriageway'].t);
    for (const c of hz.candidates) expect(c.available).toBeGreaterThanOrEqual(0);
    const rec = assessAvoidability({ v0: byCrit['entered-carriageway'].v0, available: byCrit['entered-carriageway'].available,
      t1: ev(1, 0.8, 1.2), t2: ev(0.1), t3: ev(0.35), j: ev(6.8), hazardCriterion: 'entered-carriageway' });
    expect(['could', 'could-not', 'depends']).toContain(rec.result.verdict);
  });
});
