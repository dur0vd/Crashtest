import { describe, expect, it } from 'vitest';
import { createRulesPort } from '../src/rules/port';
import { rulesFixture } from './parallel-rules-fixtures';
import { analyze } from '../src/analysis';
import { lawRef } from '../src/law';
import { mobilityPlacePermission, type MobilityPlace } from '../src/mobility';
import { signApplies, uncertainMobilityPlate } from '../src/restrictions';
import { corpus } from '../src/corpus';
import { signFile } from '../src/signs';
import { NO_CARGO } from '../src/scene';
import type { JsonObject } from '../src/parallel/contracts';
const port = createRulesPort();
async function supplement(facts: JsonObject, adjust?: (f: ReturnType<typeof rulesFixture>) => void) {
  const fixture = rulesFixture({}, { type: 'bicycle', age: 20 });
  fixture.project.extensions.rules.mobility = { actors: { a: facts } };
  adjust?.(fixture);
  const result = await port.evaluate(fixture.project, fixture.timeline);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}
const finding = async (facts: JsonObject, key: string, adjust?: (f: ReturnType<typeof rulesFixture>) => void) =>
  (await supplement(facts, adjust)).findings.find(f => f.trace.mobilityRequirement === key)!;

describe('06.5 — source-backed corrections', () => {
  it.each([13, 14, 15])('completed age %s, cycle lane permission', age => {
    const { actor } = rulesFixture({}, { type: 'bicycle', age });
    const place: MobilityPlace = { surface: 'cycle-lane', cycleZone: false, pedestrianZone: false, rightEdge: false, laneDirectionAllowed: true };
    expect(mobilityPlacePermission(actor, place).allowed).toBe(age >= 14);
  });
  it('a surveyed cycle zone permits the full same-direction carriageway, not only its right edge', () => {
    const { actor } = rulesFixture({}, { type: 'sim', age: 14 });
    expect(mobilityPlacePermission(actor, { surface: 'carriageway', cycleZone: true, pedestrianZone: false, rightEdge: false, laneDirectionAllowed: true }).allowed).toBe(true);
  });
  it.each(['sim', 'bicycle', 'moped'] as const)('8.4.16 except SIM and 8.4.7.2 only SIM: %s', cls => {
    const sign = { id: 's', x: 0, y: 0, angle: 0, kind: '3.2', plates: ['8.4.16'] };
    expect(signApplies(sign, cls)).toBe(cls !== 'sim');
    expect(signApplies({ ...sign, plates: ['8.4.7.2'] }, cls)).toBe(cls === 'sim');
    expect(uncertainMobilityPlate(sign, cls, '2023-02-28')).toBe(true);
    expect(uncertainMobilityPlate(sign, cls, '2023-03-01')).toBe(false);
  });
  it('the numbered device plates select inspected existing artwork, not the legacy truck image', () => {
    expect(signFile('8.4.7.1')).toBe('signs/8.4.7_8.webp');
    expect(signFile('8.4.7.2')).toBe('signs/8.4.7_9.webp');
    expect(corpus.signs.groups.flatMap(g => g.signs).find(s => s.id === '3.35')!.text).not.toContain('3.16');
  });
  it.each(['2023-02-28', '2023-03-01', '2029-03-01'])('3.35 and 24.9 edition boundary %s', date => {
    const supported = date === '2023-03-01';
    expect(!!lawRef('sign:3.35', date).revision).toBe(supported);
    expect(!!lawRef('pdd:24.9', date).revision).toBe(supported);
  });
});
describe('observed missing paragraphs of section 24', () => {
  it.each([[false, false, 'выполнено'], [true, false, 'не выполнено'], [true, true, 'выполнено'], [true, null, 'не определить']] as const)
    ('handlebar=%s hand=%s -> %s', async (hasHandlebar, handOnHandlebar, expected) => {
      expect((await finding({ hasHandlebar, handOnHandlebar }, 'handlebar')).compliance).toBe(expected);
    });
  it.each([0.5, 0.5001])('load projection %s m: strict statutory boundary', async projection => {
    expect((await finding({}, 'load-projection', ({ actor }) => { actor.cargo = { ...NO_CARGO, front: projection }; })).severity).toBe(projection <= 0.5 ? 'info' : 'violation');
  });
  it.each([true, false, null])('passenger design is %s', async value => {
    const r = await finding({ passengerDesignPermitted: value }, 'passenger-design', ({ actor }) => { actor.passengers = [{ id: 'p', age: 10 }]; });
    expect(r.compliance).toBe(value === true ? 'выполнено' : value === false ? 'не выполнено' : 'не определить');
    expect(r.causal).toBe(false);
  });
  it.each(['none', 'towed', 'tows-device', 'tows-trailer'])('towing mode %s', async towing => {
    expect((await finding({ towing, trailerDesignedForDevice: true }, 'towing')).severity).toBe(['none', 'tows-trailer'].includes(towing) ? 'info' : 'violation');
  });
  it.each([0.75, 0.7501])('two-row column width %s m', async width => {
    expect((await finding({ columnRows: 2, columnBicycleWidthM: width, columnGroupsSeparated: true, columnGroupPeople: 20, columnGapM: 80 }, 'column-rows', ({ actor }) => { actor.mobilityContext = { column: true }; })).severity).toBe(width <= 0.75 ? 'info' : 'violation');
  });
  it.each([79.999, 80, 100, 100.001])('column gap %s m', async gap => {
    expect((await finding({ columnGapM: gap }, 'column-gap', ({ actor }) => { actor.mobilityContext = { column: true }; })).severity).toBe(gap >= 80 && gap <= 100 ? 'info' : 'violation');
  });
  it.each([true, false, null])('outside crossing yielding %s', async yielded => {
    const r = await finding({ crossesOutsideIntersection: true, outsideYieldRespected: yielded }, 'outside-yield');
    expect(r.compliance).toBe(yielded === true ? 'выполнено' : yielded === false ? 'не выполнено' : 'не определить');
  });
  it('reflectors are mandatory outside settlements and merely recommended inside', async () => {
    const outside = await finding({ reflectorsPresent: false, reflectorsVisible: false }, 'reflectors', ({ project }) => {
      project.extensions.rules.lighting = { timeOfDay: 'night', actors: { a: { inSettlement: false } } };
    });
    expect(outside.severity).toBe('violation');
    const inside = await supplement({ reflectorsPresent: false }, ({ project }) => { project.extensions.rules.lighting = { timeOfDay: 'night', actors: { a: { inSettlement: true } } }; });
    expect(inside.findings.some(f => f.trace.mobilityRequirement === 'reflectors' && f.severity === 'violation')).toBe(false);
  });
  it('a moped is never assigned 12.29 or 12.30 by mobility consequences', async () => {
    const r = await supplement({ towing: 'tows-device' }, ({ actor }) => {
      actor.type = 'moped'; actor.mobilityContext = { causedVehicleObstruction: true, negligentHarm: 'medium', consequenceRuleRef: 'pdd:24.9', source: 'Independently established consequence' };
    });
    expect(r.findings.flatMap(f => f.refs).some(ref => /^koap:12\.(29|30)/.test(ref))).toBe(false);
    expect(r.findings.flatMap(f => f.refs)).toContain('koap:12.21#1');
  });
  it.each(['light', 'medium'] as const)('a confirmed %s consequence selects 12.30 instead of 12.29 for that act', async negligentHarm => {
    const r = await supplement({ hasHandlebar: true, handOnHandlebar: false }, ({ actor }) => {
      actor.mobilityContext = { negligentHarm, consequenceRuleRef: 'pdd:24.8', source: 'Independent confirmed harm and causal mechanism' };
    });
    const refs = r.findings.find(f => f.trace.mobilityRequirement === 'handlebar')!.refs;
    expect(refs).toContain('koap:12.30.2');
    expect(refs.some(ref => ref.startsWith('koap:12.29'))).toBe(false);
  });
  it('legacy reporting preserves its sections and source warning at unsupported dates', () => {
    const { project, timeline } = rulesFixture({}, { type: 'bicycle', age: 20 });
    project.scene.env.accidentDate = '1900-01-01';
    const r = analyze(project.scene, timeline);
    expect(r.findings.filter(f => f.refs.some(ref => ref.startsWith('pdd:24.'))).every(f => f.compliance === 'не определить')).toBe(true);
  });
});
