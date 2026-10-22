import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { emptyScene, normalizeScene, type Actor, type Passenger, type PassengerContext } from '../src/scene';
import { passengerFacts } from '../src/passengers';
import { PASSENGER_PRESETS } from '../src/presets';
import { simulate, type Timeline, type Track } from '../src/sim';

const goodRestraint = { restraintUsed: true, restraintFits: true, restraintInstalledCorrectly: true };
// Independent authored observation: 1 second of motion at 1 m/s. No path
// follower or collision-severity model supplies the expected legal answer.
function fixture(p: Partial<Passenger> = {}, c: Partial<PassengerContext> = {}, type: Actor['type'] = 'car') {
  const scene = emptyScene(); scene.env.accidentDate = '2026-10-22T12:00';
  const actor: Actor = { id: 'v', kind: 'vehicle', type, x: 0, y: 0, speed: 3.6, heading: 0, delay: 0, color: '#456789',
    path: [{ x: 20, y: 0, v: 3.6 }], flags: { drunk: false, noLicense: false, flees: false },
    passengerContext: { vehicleClass: 'passenger-car', beltsProvided: true, driverBeltUsed: true, ...c },
    passengers: [{ id: 'p', place: 'rear', ...p }] };
  scene.actors = [actor];
  const n = 41;
  const track: Track = { id: 'v', x: Float32Array.from({ length: n }, (_, k) => k / 40), y: new Float32Array(n),
    h: new Float32Array(n), v: new Float32Array(n).fill(1), present: new Uint8Array(n).fill(1), free: new Uint8Array(n), waypointTimes: [20] };
  const tl: Timeline = { ...simulate(scene), n, tracks: new Map([['v', track]]), collisions: [] };
  return { scene, actor, tl, track };
}
function report(p: Partial<Passenger>, c: Partial<PassengerContext> = {}, type: Actor['type'] = 'car') {
  const f = fixture(p, c, type); return analyze(f.scene, f.tl);
}
const sanctions = (r: ReturnType<typeof analyze>) => r.verdicts.flatMap(v => v.legal.flatMap(l => l.refs)).filter(r => r.startsWith('koap:12.6') || r.startsWith('koap:12.23'));
const childFindings = (r: ReturnType<typeof analyze>) => r.findings.filter(f => f.trace.passengerId === 'p');

describe('22.9 — independent age/place decision table', () => {
  it.each([
    [0, 'rear', false, 'koap:12.23#3'], [6, 'rear', true, 'koap:12.23#3'],
    [7, 'rear', true, null], [11, 'rear', true, null], [12, 'rear', true, null],
    [7, 'front', true, 'koap:12.23#3'], [11, 'front', true, 'koap:12.23#3'],
    [12, 'front', false, 'koap:12.6'], [16, 'rear', false, 'koap:12.6'],
  ] as const)('age=%s place=%s belt=%s -> %s', (age, place, beltUsed, expected) => {
    const r = report({ age, place, beltUsed, restraintUsed: false });
    expect(sanctions(r)).toEqual(expected ? [expected] : []);
    expect(childFindings(r).every(f => !f.causal)).toBe(true);
  });
  it.each([0, 6, 7, 11])('correct restraint at age %s', age => {
    const r = report({ age, place: 'front', beltUsed: false, ...goodRestraint });
    expect(sanctions(r)).toEqual([]);
    expect(childFindings(r).some(f => f.compliance === 'выполнено')).toBe(true);
  });
  it.each([7, 11])('truck cab age %s permits belt at any cabin seat', age => {
    expect(sanctions(report({ age, place: 'cab', beltUsed: true, restraintUsed: false }, { vehicleClass: 'truck' }, 'truck'))).toEqual([]);
  });
  it('truck cab under seven requires restraint', () => {
    expect(sanctions(report({ age: 6, place: 'cab', beltUsed: true, restraintUsed: false }, { vehicleClass: 'truck' }, 'truck'))).toEqual(['koap:12.23#3']);
  });
  it('belt does not excuse a known incorrectly used child restraint', () => {
    expect(sanctions(report({ age: 7, beltUsed: true, ...goodRestraint, restraintInstalledCorrectly: false }))).toEqual(['koap:12.23#3']);
  });
  it.each(['restraintFits', 'restraintInstalledCorrectly'] as const)('known false %s violates even with restraint', key => {
    expect(sanctions(report({ age: 6, ...goodRestraint, [key]: false }))).toEqual(['koap:12.23#3']);
  });
});

describe('unknown facts never create an offence', () => {
  it.each([
    [{ age: undefined, beltUsed: false, restraintUsed: false }, {}],
    [{ age: 6, restraintUsed: false }, { beltsProvided: undefined }],
    [{ age: 6, restraintUsed: false }, { vehicleClass: undefined }],
    [{ age: 6, place: undefined, restraintUsed: false }, {}],
    [{ age: 6, restraintUsed: true, restraintFits: undefined, restraintInstalledCorrectly: true }, {}],
    [{ age: 6, restraintUsed: true, restraintFits: true }, {}],
    [{ age: 7, beltUsed: false, restraintUsed: undefined }, {}],
    [{ age: 20, beltUsed: undefined }, {}],
  ] as [Partial<Passenger>, Partial<PassengerContext>][])('unknown combination %j %j', (p, c) => {
    const r = report(p, c);
    expect(sanctions(r)).toEqual([]);
    expect(childFindings(r).some(f => f.compliance === 'не определить')).toBe(true);
    expect(r.verdicts[0].status).toBe('insufficient-data');
  });
  it('equipment explicitly absent does not create belt/child offence', () => {
    expect(sanctions(report({ age: 6, restraintUsed: false }, { beltsProvided: false, driverBeltUsed: false }))).toEqual([]);
  });
  it('pre-corpus date produces uncertainty, no current-edition fallback', () => {
    const f = fixture({ age: 6, restraintUsed: false }); f.scene.env.accidentDate = '2000-01-01';
    expect(sanctions(analyze(f.scene, f.tl))).toEqual([]);
  });
  it('stationary vehicle does not establish transportation', () => {
    const f = fixture({ age: 6, restraintUsed: false }); f.track.v.fill(0);
    expect(sanctions(analyze(f.scene, f.tl))).toEqual([]);
  });
  it('unobserved actor does not establish transportation', () => {
    const f = fixture({ age: 6, restraintUsed: false }); f.track.present.fill(0);
    expect(sanctions(analyze(f.scene, f.tl))).toEqual([]);
  });
});

describe('helmets and applicable transport conditions', () => {
  it.each([11, 12])('motorcycle rear boundary %s', age => {
    const r = report({ age, place: 'motorcycle-rear', helmetFastened: true }, { driverHelmetFastened: true, qualifyingLicenseYears: 2 }, 'motorcycle');
    expect(sanctions(r)).toEqual(age < 12 ? ['koap:12.23#3'] : []);
  });
  it('helmet violation is separate from child transportation', () => {
    expect(sanctions(report({ age: 12, place: 'motorcycle-rear', helmetFastened: false }, { driverHelmetFastened: true, qualifyingLicenseYears: 2 }, 'motorcycle'))).toEqual(['koap:12.6']);
  });
  it('unknown helmet/license years do not create sanctions', () => {
    expect(sanctions(report({ age: 12, place: 'motorcycle-rear' }, {}, 'motorcycle'))).toEqual([]);
  });
  it.each(['motorcycle', 'moped'] as const)('%s driver helmet and under-two-year entitlement', type => {
    const r = report({ age: 20, helmetFastened: true, place: type === 'motorcycle' ? 'motorcycle-rear' : 'other' }, { driverHelmetFastened: false, qualifyingLicenseYears: 1.99 }, type);
    expect(sanctions(r)).toEqual(['koap:12.6', 'koap:12.23#1']);
  });
  it('driver belt offence does not depend on passenger age', () => {
    expect(sanctions(report({}, { driverBeltUsed: false }))).toEqual(['koap:12.6']);
  });
  it('excess capacity is explicit, never inferred from vehicle dimensions', () => {
    expect(sanctions(report({ age: 20, beltUsed: true }, { passengerCapacity: 0 }))).toEqual(['koap:12.23#1']);
    expect(sanctions(report({ age: 20, beltUsed: true }))).toEqual([]);
  });
  it('outside passenger car differs from truck exceptions', () => {
    expect(sanctions(report({ age: 20, place: 'outside', beltUsed: true }))).toEqual(['koap:12.23#2']);
    expect(sanctions(report({ age: 20, place: 'body', beltUsed: true }, { vehicleClass: 'truck' }, 'truck'))).toEqual([]);
  });
  it('known boarding and door violations use 12.23(1)', () => {
    const r = report({ age: 20, beltUsed: true }, { boardingWhileMoving: true, doorsClosedWhileMoving: false });
    expect(sanctions(r)).toEqual(['koap:12.23#1']);
    expect(r.findings.filter(f => f.refs.includes('koap:12.23#1'))).toHaveLength(2);
  });
  it('organized group does not infer parts 4–6', () => {
    expect(sanctions(report({ age: 20, beltUsed: true }, { organizedChildren: true }))).toEqual([]);
  });
  it('driver younger than 16 receives no administrative qualification', () => {
    const f = fixture({ age: 6, restraintUsed: false }); f.actor.age = 15;
    expect(sanctions(analyze(f.scene, f.tl))).toEqual([]);
  });
});

describe('migration, presets and downstream facts', () => {
  it('legacy scenes retain unknown passengers; empty is explicit', () => {
    const f = fixture(); delete f.actor.passengers; delete f.actor.passengerContext;
    const migrated = normalizeScene(f.scene).actors[0];
    expect(migrated.passengers).toBeUndefined(); expect(migrated.passengerContext).toBeUndefined();
    f.actor.passengers = [];
    expect(normalizeScene(f.scene).actors[0].passengers).toEqual([]);
  });
  it('invalid inputs are discarded, booleans never coerced; duplicate IDs repaired', () => {
    const f = fixture();
    Object.assign(f.actor, { passengers: [null, { id: 'p', age: -1, beltUsed: 'false', restraintUsed: 0, weightKg: -2, place: 'roof' }, { id: 'p', age: 7.5 }],
      passengerContext: { beltsProvided: 'true', passengerCapacity: -1, qualifyingLicenseYears: -1 } });
    const a = normalizeScene(f.scene).actors[0];
    expect(a.passengers).toEqual([{ id: 'p' }, { id: 'p-copy' }]);
    expect(a.passengerContext).toEqual({});
  });
  it('round trip preserves all stage-09 inputs without changing harm or kinematics', () => {
    const f = fixture({ age: 6, weightKg: 22, heightCm: 115, ...goodRestraint });
    const a = normalizeScene(JSON.parse(JSON.stringify(f.scene))).actors[0];
    expect(a.passengers).toEqual(f.actor.passengers); expect(a.passengerContext).toEqual(f.actor.passengerContext);
    expect(passengerFacts(a)).toMatchObject({ injuryModel: 'not-assessed', protectionCoefficients: null });
    const before = simulate(f.scene); f.actor.passengers![0].restraintUsed = false; const after = simulate(f.scene);
    expect([...before.tracks.get('v')!.x]).toEqual([...after.tracks.get('v')!.x]);
    expect(before.collisions).toEqual(after.collisions);
    const r = analyze(f.scene, f.tl); const finding = childFindings(r)[0];
    expect(finding.trace.passengerFacts).toMatchObject({ passengers: [{ weightKg: 22, heightCm: 115 }] });
    expect(finding.trace.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'pdd:22.9', source: expect.objectContaining({ url: expect.any(String) }) })]));
  });
  it('collision with an obstacle retains facts without changing the harm estimate', () => {
    const f = fixture({ age: 6, ...goodRestraint });
    f.scene.obstacles = [{ id: 'wall', x: 1, y: 0, w: 1, h: 2, angle: 0, kind: 'barrier' }];
    f.tl.collisions = [{ idx: 0, t: 0.5, frame: 20, a: 'v', b: 'wall', kind: 'vo', point: { x: 1, y: 0 },
      n: { x: 1, y: 0 }, vA: { x: 10, y: 0 }, vB: { x: 0, y: 0 }, rel: 10, dvA: 10, dvB: 0 }];
    const before = analyze(f.scene, f.tl);
    f.actor.passengers![0].restraintUsed = false; f.actor.passengers![0].beltUsed = false;
    const after = analyze(f.scene, f.tl);
    expect(after.technical.collisions[0].harm).toEqual(before.technical.collisions[0].harm);
    expect(after.technical.collisions[0].trace.passengerFacts).toEqual([
      expect.objectContaining({ actorId: 'v', passengers: [expect.objectContaining({ age: 6, restraintUsed: false })] }),
    ]);
    expect(after.collisions[0].harm).toEqual(before.collisions[0].harm);
  });
  it.each(PASSENGER_PRESETS)('preset $id agrees with legal result', preset => {
    const scene = preset.build(), r = analyze(scene, simulate(scene));
    expect(sanctions(r)).toEqual(preset.id.endsWith('violation') ? ['koap:12.23#3'] : []);
  });
});
