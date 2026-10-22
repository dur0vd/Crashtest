import { describe, expect, it } from 'vitest';
import { rulesFixture } from './parallel-rules-fixtures';
import { createRulesPort } from '../src/rules/port';
import { lawRef } from '../src/law';
import type { JsonObject } from '../src/parallel/contracts';
const port = createRulesPort();
async function run(facts: JsonObject, adjust?: (f: ReturnType<typeof rulesFixture>) => void) {
  const f = rulesFixture({}, { type: 'truck', passengers: [{ id: 'p', age: 20, place: 'body' }], passengerContext: { vehicleClass: 'truck', beltsProvided: false } });
  f.project.extensions.rules.passengers = { actors: { a: facts } };
  adjust?.(f);
  const result = await port.evaluate(f.project, f.timeline);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}
const requirement = async (facts: JsonObject, key: string, adjust?: (f: ReturnType<typeof rulesFixture>) => void) =>
  (await run(facts, adjust)).findings.find(f => f.trace.passengerRequirement === key)!;
const platform = { truckBodyKind: 'board-platform', bodyEquippedForPeople: true, militaryDriver: false,
  licenseCOrC1: true, truckLicenseYears: 3, passengersBriefed: true, safetyCheckedBeforeStart: true, bodySeatingPlaces: 20 };
describe('22.1–22.5 independently specified tables', () => {
  it.each([2.999, 3, 3.001])('C/C1 holding years %s', async years => {
    const f = await requirement({ ...platform, truckLicenseYears: years }, 'truck-license');
    expect(f.compliance).toBe(years >= 3 ? 'выполнено' : 'не выполнено');
  });
  it.each([[8, false, false, true], [9, false, false, false], [16, false, true, true], [17, false, true, false], [17, true, false, true]] as const)
    ('count %s D=%s D1=%s -> %s', async (count, licenseD, licenseD1, expected) => {
      const f = await requirement({ ...platform, licenseD, licenseD1 }, 'truck-license', ({ actor }) => {
        actor.passengers = Array.from({ length: count }, (_, n) => ({ id: `p${n}`, age: 20, place: n === 0 ? 'cab' : 'body' }));
      });
      expect(f.compliance).toBe(expected ? 'выполнено' : 'не выполнено');
    });
  it('unknown military admission or license never becomes false', async () => {
    expect((await requirement({ ...platform, militaryDriver: true }, 'truck-license')).compliance).toBe('не определить');
    expect((await requirement({ ...platform, licenseCOrC1: null }, 'truck-license')).compliance).toBe('не определить');
  });
  it.each([17, 18])('children on equipped truck platform, age=%s', async age => {
    const f = await requirement(platform, 'body-child', ({ actor }) => { actor.passengers![0].age = age; });
    expect(f.compliance).toBe(age < 18 ? 'не выполнено' : 'выполнено');
    expect(f.refs.includes('koap:12.23#3')).toBe(age < 18);
  });
  it.each([[true, true, 'выполнено'], [false, true, 'не выполнено'], [true, false, 'не выполнено'], [null, true, 'не определить']] as const)
    ('unequipped body: cargo escort=%s seat below sides=%s -> %s', async (accompaniesCargo, seatBelowSides, state) => {
      expect((await requirement({ ...platform, bodyEquippedForPeople: false, people: { p: { accompaniesCargo, goingForCargo: false, seatBelowSides } } }, 'body-equipment')).compliance).toBe(state);
    });
  it('failure to brief passengers is independent of adequate seats', async () => {
    const r = await run({ ...platform, passengersBriefed: false });
    expect(r.findings.find(f => f.trace.passengerRequirement === 'body-seats')?.compliance).toBe('выполнено');
    expect(r.findings.find(f => f.trace.passengerRequirement === 'briefing')?.refs).toContain('koap:12.23#1');
  });
});
describe('passenger subjects, boarding and composition', () => {
  it.each([15, 16, 30])('unsafe carriageway boarding: passenger age %s', async age => {
    const r = await run({ people: { p: { boardingOccurred: true, boardingSide: 'carriageway', sidewalkBoardingImpossible: false, boardingSafe: true, boardingUnobstructed: true } } }, ({ actor }) => {
      actor.type = 'car'; actor.passengerContext = { vehicleClass: 'passenger-car', beltsProvided: false, boardingWhileMoving: false };
      actor.passengers = [{ id: 'p', age, place: 'rear' }];
    });
    const personal = r.legal.duties.find(d => d.trace.passengerRequirement === 'boarding-side')!;
    expect(personal.refs.includes('koap:12.29.1')).toBe(age >= 16);
    expect(r.legal.verdicts.flatMap(v => v.legal.flatMap(l => l.refs))).not.toContain('koap:12.29.1');
    expect(personal.trace.subject).toEqual({ kind: 'passenger', passengerId: 'p', age });
  });
  it.each([true, false, null])('roadside boarding exception requires established safety=%s', async safety => {
    const f = await requirement({ people: { p: { boardingOccurred: true, boardingSide: 'carriageway', sidewalkBoardingImpossible: true, boardingSafe: safety, boardingUnobstructed: true } } }, 'boarding-side', ({ actor }) => { actor.passengerContext!.boardingWhileMoving = false; });
    expect(f.compliance).toBe(safety === true ? 'выполнено' : safety === false ? 'не выполнено' : 'не определить');
  });
  it('zero-speed track does not establish moving carriage, boarding remains independently assessable', async () => {
    const r = await run({ ...platform, passengersBriefed: false, people: { p: { boardingOccurred: true, boardingSide: 'sidewalk' } } }, ({ track, actor }) => {
      track.v.fill(0); track.x.fill(0); actor.passengerContext!.boardingWhileMoving = false;
    });
    expect(r.findings.some(f => f.trace.passengerRequirement === 'briefing')).toBe(false);
    expect(r.findings.find(f => f.trace.passengerRequirement === 'boarding-side')?.compliance).toBe('выполнено');
  });
});
describe('organized groups: verified 680 edition only', () => {
  const bus: JsonObject = { organizedOperatorInScope: true, childrenSigns: true, busSeatingPlaces: 20, busBeaconCorrect: true,
    busDriverDWorkYearsLast2: 1, busDriverBriefed: true, busDriverNoDisqualifyingPenalty: true,
    scheduledHours: 4, chartered: false, routeDocumentPresent: true };
  const busAdjust = (f: ReturnType<typeof rulesFixture>) => {
    f.actor.type = 'bus'; f.actor.passengerContext = { vehicleClass: 'other', beltsProvided: true, driverBeltUsed: true, organizedChildren: true };
    f.actor.passengers = [{ id: 'p', age: 6, place: 'rear', beltUsed: true }]; f.project.scene.env.accidentDate = '2026-10-22T12:00';
  };
  it.each(['2026-08-31', '2026-09-01', '2032-09-01'])('edition %s', date => {
    expect(!!lawRef('bus:680.8', date).revision).toBe(date === '2026-09-01');
  });
  it.each([4, 4.001])('under seven, scheduled %s h', async hours => {
    const r = await run({ ...bus, scheduledHours: hours }, busAdjust);
    expect(r.findings.some(f => f.trace.passengerRequirement === 'group-under7' && f.severity === 'violation')).toBe(hours > 4);
    expect(r.findings.flatMap(f => f.refs)).not.toContain('koap:12.23#6'); // no invented driver liability under part 6
  });
  it.each([22, 23, 0, 5, 6])('local hour %s, established night conditions absent', async hour => {
    const r = await run({ ...bus, nightExceptionEstablished: false, nightSpecialTerritory: false, nightDistanceKm: 10 }, f => {
      busAdjust(f); f.project.scene.env.accidentDate = `2026-10-22T${String(hour).padStart(2, '0')}:00`;
    });
    expect(r.findings.some(f => f.refs.includes('koap:12.23#5'))).toBe(hour >= 23 || hour < 6);
  });
  it('old edition cannot inherit the new group requirements', async () => {
    const r = await run({ ...bus, busBeaconCorrect: false }, f => { busAdjust(f); f.project.scene.env.accidentDate = '2026-08-31T12:00'; });
    expect(r.findings.flatMap(f => f.refs).some(ref => ref.startsWith('bus:680.'))).toBe(false);
    expect(r.findings.find(f => f.trace.passengerRequirement === 'group-rules-scope')?.compliance).toBe('не определить');
  });
  it('a missing route document selects special part 4 rather than general part 1 for that act', async () => {
    const r = await run({ ...bus, routeDocumentPresent: false }, busAdjust);
    const f = r.findings.find(f => f.trace.passengerRequirement === 'group-driver-documents')!;
    expect(f.refs).toContain('koap:12.23#4'); expect(f.refs).not.toContain('koap:12.23#1');
  });
  it.each([[1, true, false], [2, true, false], [3, false, true]] as const)('bus count %s: notice=%s escort application=%s', async (busCount, notice, escort) => {
    const r = await run({ ...bus, busCount, noticeSubmitted: false, escortApplicationSubmitted: false }, busAdjust);
    expect(r.findings.some(f => f.trace.passengerRequirement === 'group-notice')).toBe(notice);
    expect(r.findings.some(f => f.trace.passengerRequirement === 'group-escort-application')).toBe(escort);
    expect(r.legal.verdicts.flatMap(v => v.legal.flatMap(l => l.refs))).not.toContain('koap:12.23#6');
  });
  it.each([['city', 23.999, false], ['city', 24, true], ['long-distance', 47.999, false], ['long-distance', 48, true]] as const)
    ('%s notification lead %s h -> %s', async (busRouteClass, notificationLeadHours, expected) => {
      const f = await requirement({ ...bus, busCount: 1, busRouteClass, notificationLeadHours, noticeSpecialTerritory: false }, 'group-notice-time', busAdjust);
      expect(f.compliance).toBe(expected ? 'выполнено' : 'не выполнено');
    });
  it.each([[2, 13, false], [3, 12, false], [3, 12.001, true]] as const)('medical worker threshold buses=%s h=%s: %s', async (busCount, actualDurationHours, applies) => {
    const r = await run({ ...bus, busCount, actualDurationHours, medicalWorkerPresent: false }, busAdjust);
    expect(r.findings.some(f => f.trace.passengerRequirement === 'group-medic' && f.severity === 'violation')).toBe(applies);
  });
});
