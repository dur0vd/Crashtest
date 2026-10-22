import { describe, expect, it } from 'vitest';
import { conclusionGuidance } from '../src/rules/conclusion';
import { createRulesPort } from '../src/rules/port';
import { rulesFixture } from './parallel-rules-fixtures';
import type { JsonObject } from '../src/parallel/contracts';
const required = ['dateTimePlaceRecorded', 'appointmentBasisRecorded', 'appointingAuthorityRecorded', 'expertIdentityQualificationsRecorded',
  'institutionRecorded', 'liabilityWarningRecorded', 'questionsRecorded', 'objectsMaterialsRecorded', 'attendeesRecorded', 'methodsResultsRecorded', 'conclusionsJustified', 'signaturesRecorded'];
const complete = Object.fromEntries(required.map(key => [key, true])) as JsonObject;
function fixture(facts: JsonObject = {}) {
  const f = rulesFixture(); f.project.extensions.rules.conclusion = { procedure: 'criminal-expert', preparedDate: '2026-10-22', stateInstitution: false, illustrationsUsed: false, ...complete, ...facts }; return f;
}
describe('25 73-FZ and 204 CPC — content, not certification', () => {
  it.each(required)('missing recorded requisite %s remains incomplete', field => {
    expect(conclusionGuidance(fixture({ [field]: false }).project).contentState).toBe('incomplete');
    expect(conclusionGuidance(fixture({ [field]: null }).project).contentState).toBe('unknown');
  });
  it('all required fields do not produce legal or scientific certification', () => {
    const result = conclusionGuidance(fixture().project);
    expect(result.contentState).toBe('recorded'); expect(result.legalCertification).toBe(false); expect(result.scientificCertification).toBe(false);
    expect(result.sources.some(s => s.id === 'upk:204')).toBe(true);
    expect(result.checklist.some(i => i.field === 'liabilityWarningRecorded')).toBe(true);
  });
  it.each([true, false, null])('state institution=%s controls seal applicability', stateInstitution => {
    const result = conclusionGuidance(fixture({ stateInstitution, institutionSealRecorded: false }).project);
    expect(result.contentState).toBe(stateInstitution === true ? 'incomplete' : stateInstitution === false ? 'recorded' : 'unknown');
  });
  it('used illustrations must be attached, not fabricated', () => {
    const result = conclusionGuidance(fixture({ illustrationsUsed: true, illustrationsAttached: false }).project);
    expect(result.contentState).toBe('incomplete');
  });
  it('a commissioner document does not inherit criminal-expert status', () => {
    const result = conclusionGuidance(fixture({ procedure: 'commissioner', signaturesRecorded: false }).project);
    expect(result.sources.some(s => s.id === 'upk:204')).toBe(false); expect(result.legalCertification).toBe(false);
  });
  it('the report date is distinct from accident date and no historical edition is invented', () => {
    const f = fixture({ preparedDate: '2020-01-01' });
    const result = conclusionGuidance(f.project); expect(result.preparedDate).toBe('2020-01-01');
    expect(result.limitations.some(l => l.includes('редакции процессуальных требований'))).toBe(true);
  });
  it('RulesPort exports the actual checklist and remains DOM-free/JSON-compatible', async () => {
    const f = fixture(); const result = await createRulesPort().evaluate(f.project, f.timeline);
    expect(result.status).toBe('ok'); if (result.status !== 'ok') return;
    expect(result.value.legal.duties.find(d => d.trace.kind === 'conclusion.requisites')?.trace.assessment).toMatchObject({ contentState: 'recorded', legalCertification: false });
    expect(JSON.parse(JSON.stringify(result.value)).legal).toEqual(result.value.legal);
  });
});
