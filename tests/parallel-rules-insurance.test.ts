import { describe, expect, it } from 'vitest';
import { assessEqualShares, assessEuroprotocol } from '../src/rules/insurance';
import { createRulesPort } from '../src/rules/port';
import { rulesFixture } from './parallel-rules-fixtures';
import type { JsonObject } from '../src/parallel/contracts';
const base: JsonObject = { vehicleCount: 2, vehiclesInteracted: true, harm: 'vehicles-only', bothOwnersInsured: true,
  insuranceSystem: 'domestic-osago', disagreement: false, noticeCompleted: true, dataRecordedAndTransferred: false, experimentalRegime: false };
function project(facts: JsonObject = {}, date = '2026-10-22') {
  const f = rulesFixture(); f.project.scene.env.accidentDate = date;
  f.project.extensions.rules.insurance = { ...base, ...facts }; return f.project;
}
describe('11.1 — independent statutory decision table, not a claim simulator', () => {
  it.each([
    ['2025-07-04', false, false, 100000], ['2025-07-04', false, true, 400000], ['2025-07-04', true, true, 100000],
    ['2025-07-05', false, false, 100000], ['2025-07-05', false, true, 400000], ['2025-07-05', true, true, 200000],
    ['2026-10-22', true, true, 200000],
  ] as const)('%s disagreement=%s data=%s -> %s RUB', (date, disagreement, dataRecordedAndTransferred, cap) => {
    const result = assessEuroprotocol(project({ disagreement, dataRecordedAndTransferred }, date));
    expect(result.status).toBe('met'); expect(result.limitRub).toBe(cap); expect(result.trace.officialService).toBe(false);
  });
  it.each([1, 2, 3])('exactly two vehicles including trailer combinations, n=%s', vehicleCount => {
    expect(assessEuroprotocol(project({ vehicleCount })).status).toBe(vehicleCount === 2 ? 'met' : 'not-met');
  });
  it.each(['health', 'other-property', 'mixed'])('harm=%s excludes ordinary europrotocol', harm => {
    expect(assessEuroprotocol(project({ harm })).status).toBe('not-met');
  });
  it.each(['vehicleCount', 'vehiclesInteracted', 'harm', 'bothOwnersInsured', 'noticeCompleted', 'experimentalRegime'])('unknown %s is not false or a met condition', key => {
    expect(assessEuroprotocol(project({ [key]: null })).status).toBe('unknown');
  });
  it('disagreement requires actual statutory recording/transmission, ordinary photos are insufficient', () => {
    const result = assessEuroprotocol(project({ disagreement: true, dataRecordedAndTransferred: false, photosPresent: true }));
    expect(result.status).toBe('not-met'); expect(result.limitRub).toBeNull();
  });
  it.each([99999, 100000, 100001])('damage amount %s compared with ordinary 100k cap', estimatedDamageRub => {
    const result = assessEuroprotocol(project({ estimatedDamageRub }));
    expect(result.estimatedDamageWithinLimit).toBe(estimatedDamageRub <= 100000);
    expect(result.status).toBe('met'); // excessive estimate is not statutory invalidation of the notice
  });
  it('unknown transmission retains conditional limits rather than assuming no transmission', () => {
    const result = assessEuroprotocol(project({ dataRecordedAndTransferred: null }));
    expect(result.status).toBe('met'); expect(result.limitRub).toBeNull(); expect(result.conditionalLimitRangeRub).toEqual([100000, 400000]);
  });
  it('known transmission with unknown disagreement permits only a conditional cap', () => {
    const result = assessEuroprotocol(project({ disagreement: null, dataRecordedAndTransferred: true }));
    expect(result.status).toBe('met'); expect(result.conditionalLimitRangeRub).toEqual([200000, 400000]);
  });
  it.each([{ experimentalRegime: true }, { insuranceSystem: 'foreign-system' }] as JsonObject[])('special scope %j remains unsupported', facts => {
    expect(assessEuroprotocol(project(facts)).status).toBe('unknown');
  });
  it('dates before verified coverage do not inherit modern limits', () => {
    const result = assessEuroprotocol(project({}, '2019-09-30')); expect(result.status).toBe('unknown'); expect(result.limitRub).toBeNull();
  });
});
describe('12(22) — equal insurance shares do not mean a percentage of fault', () => {
  it('unknown simulator responsibility cannot produce an equal-share direction', () => {
    const result = assessEqualShares(project({ multipleResponsibleEstablished: true, courtFaultSharesEstablished: false }));
    expect(result.status).toBe('unknown'); expect(result.trace.inferredFromSimulation).toBe(false); expect(result.trace.faultPercentage).toBeNull();
  });
  it.each([true, false, null])('court-established shares=%s', courtFaultSharesEstablished => {
    const result = assessEqualShares(project({ multipleResponsibleEstablished: true, responsibilitySource: 'Independent police/court document', courtFaultSharesEstablished }));
    expect(result.status).toBe(courtFaultSharesEstablished === false ? 'applicable' : courtFaultSharesEstablished === true ? 'not-applicable' : 'unknown');
    expect(JSON.stringify(result)).not.toMatch(/50\s*%|100\s*%/);
  });
  it('machine guidance is included in RulesPort and the selected law is source-backed', async () => {
    const f = rulesFixture(); f.project = project({ disagreement: true, dataRecordedAndTransferred: true });
    const result = await createRulesPort().evaluate(f.project, f.timeline);
    expect(result.status).toBe('ok'); if (result.status !== 'ok') return;
    const item = result.value.legal.duties.find(d => d.trace.kind === 'insurance.europrotocol')!;
    expect(item.trace.assessment).toMatchObject({ status: 'met', limitRub: 200000 });
    expect(result.value.laws.find(l => l.id === 'osago:11.1')?.source?.url).toMatch(/consultant.ru/);
    expect(createRulesPort().describe(f.project).flatMap(d => d.inputs).some(i => i.path === '/extensions/rules/insurance/disagreement')).toBe(true);
  });
});
