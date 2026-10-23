import { describe, expect, it } from 'vitest';
import { privacyGuidance, validatePrivacy } from '../src/rules/privacy';
import { createRulesPort } from '../src/rules/port';
import { rulesFixture } from './parallel-rules-fixtures';
import type { JsonObject } from '../src/parallel/contracts';

function fixture(facts: JsonObject = {}) {
  const f = rulesFixture(); f.project.extensions.rules.privacy = { processingDate: '2026-10-22', personalDataPresent: true, purpose: 'commissioner-service', ...facts }; return f;
}
describe('152-FZ — grounds, functions and limits of the legal guidance', () => {
  it.each([true, false, null])('a personal/family purpose also requires respect for rights=%s', rightsRespected => {
    const result = privacyGuidance(fixture({ purpose: 'personal-family', rightsRespected }).project);
    expect(result.scope).toBe(rightsRespected === true ? 'personal-family-exception-reported' : rightsRespected === false ? '152-scope-reported' : 'unknown');
    expect(result.operatorIdentity).toBeNull();
  });
  it('service/publication purposes cannot acquire the personal exception from rightsRespected alone', () => {
    for (const purpose of ['commissioner-service', 'expert-service', 'publication', 'other']) expect(privacyGuidance(fixture({ purpose, rightsRespected: true }).project).scope).toBe('152-scope-reported');
  });
  it('no personal data and unknown personal data remain different states', () => {
    expect(privacyGuidance(fixture({ personalDataPresent: false }).project).scope).toBe('no-personal-data-reported');
    expect(privacyGuidance(fixture({ personalDataPresent: null }).project).scope).toBe('unknown');
  });
  it('using a program does not establish operator functions', () => {
    const result = privacyGuidance(fixture().project);
    expect(result.operatorFunctions).toBe('unknown'); expect(result.operatorIdentity).toBeNull();
    expect(privacyGuidance(fixture({ organizesOrCarriesOutProcessing: true, determinesProcessingPurposes: true, determinesDataAndActions: true }).project).operatorFunctions).toBe('documented-declaration');
  });
  it.each(['contract', 'legal-obligation', 'legal-interest', 'other'])('%s is a possible declared ground without automatically requiring consent', lawfulBasis => {
    const result = privacyGuidance(fixture({ lawfulBasis, basisApplicabilityConfirmed: true, basisSource: 'Конкретный договор/норма и подтверждённая цель', consentObtained: false }).project);
    expect(result.basisEvidence).toBe('documented-declaration'); expect(result.consentEvidence).toBe('not-assessed');
    expect(result.lawfulness).toBeNull(); expect(result.legalCertification).toBe(false);
  });
  it('an unsupported checkbox does not document the actual ground', () => {
    expect(privacyGuidance(fixture({ lawfulBasis: 'contract', basisApplicabilityConfirmed: true }).project).basisEvidence).toBe('unknown');
    expect(privacyGuidance(fixture({ lawfulBasis: 'contract', basisApplicabilityConfirmed: false, basisSource: 'Договор' }).project).basisEvidence).toBe('gap-reported');
  });
  it.each([
    ['2025-08-31', false, 'documented-declaration'],
    ['2025-09-01', true, 'gap-reported'],
    ['2026-10-22', true, 'gap-reported'],
    ['2027-01-01', null, 'unknown'],
  ] as const)('separate-consent amendment on %s is distinct from accident date', (processingDate, required, state) => {
    const f = fixture({ processingDate, lawfulBasis: 'consent', consentObtained: true, consentFreeSpecificInformed: true, consentSeparate: false, writtenConsentRequired: false, healthDataPresent: false, biometricsUsedForIdentification: false });
    f.project.scene.env.accidentDate = '2020-01-01'; const result = privacyGuidance(f.project);
    expect(result.separateConsentRequired).toBe(required); expect(result.consentEvidence).toBe(state);
    if (processingDate !== '2026-10-22') expect(result.limitations.some(l => l.includes('TODO(legal-check)'))).toBe(true);
  });
  it('health data require a separate category basis and written consent when consent is the ground', () => {
    const result = privacyGuidance(fixture({ lawfulBasis: 'consent', consentObtained: true, consentFreeSpecificInformed: true, consentSeparate: true,
      healthDataPresent: true, writtenConsentRequired: false, writtenConsentRecorded: false, specialCategoryBasisConfirmed: true }).project);
    expect(result.writtenConsentRequired).toBe(true); expect(result.consentEvidence).toBe('gap-reported'); expect(result.healthBasis).toBe('unknown');
    expect(result.consentRequisites.length).toBeGreaterThan(0);
  });
  it('a statutory health-data exception may have a documented basis without consent', () => {
    const result = privacyGuidance(fixture({ lawfulBasis: 'legal-obligation', healthDataPresent: true, consentObtained: false,
      specialCategoryBasisConfirmed: true, specialCategorySource: 'Установленное основание ст.10 ч.2', basisApplicabilityConfirmed: true, basisSource: 'Конкретное предписание и цель' }).project);
    expect(result.healthBasis).toBe('documented-declaration'); expect(result.consentEvidence).toBe('not-assessed');
  });
  it('biometry depends on identification use, not just the presence of a photo', () => {
    expect(privacyGuidance(fixture({ biometricsUsedForIdentification: false }).project).biometricBasis).toBe('not-applicable');
    expect(privacyGuidance(fixture({ biometricsUsedForIdentification: true }).project).biometricBasis).toBe('unknown');
  });
  it('processing consent does not itself establish a disclosure basis', () => {
    const result = privacyGuidance(fixture({ lawfulBasis: 'consent', consentObtained: true, willDisclose: true }).project);
    expect(result.disclosureBasis).toBe('unknown');
    expect(privacyGuidance(fixture({ willDisclose: false }).project).disclosureBasis).toBe('not-applicable');
  });
  it.each([{ processingDate: '2026-02-30' }, { consentObtained: 'yes' }, { basisSource: {} }, { personalDataPresent: false, healthDataPresent: true }])('rejects malformed or contradictory inputs %j', facts => {
    expect(validatePrivacy(facts).length).toBeGreaterThan(0);
  });
  it('exports legal sources and guidance through the JSON/DOM-free port', async () => {
    const f = fixture(), port = createRulesPort();
    expect(port.describe(f.project).find(d => d.id === 'rules.privacy-legal')?.inputs.some(i => i.path.endsWith('/processingDate'))).toBe(true);
    const result = await port.evaluate(f.project, f.timeline); expect(result.status).toBe('ok'); if (result.status !== 'ok') return;
    const guidance = result.value.legal.duties.find(d => d.trace.kind === 'privacy.legal-guidance')?.trace.assessment as JsonObject;
    expect(guidance).toMatchObject({ lawfulness: null, legalCertification: false });
    expect(JSON.parse(JSON.stringify(result.value))).toEqual(result.value);
  });
});
