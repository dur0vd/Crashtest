import type { FeatureDescriptor, FeatureIssue, ProjectEnvelope } from '../parallel/contracts';
import { lawDate } from '../law-version';
import { all, any, bool, object, validateFields, type Known } from './facts';

const CHECKED_ON = '2026-10-22';
const ROOT = 'https://www.consultant.ru/document/cons_doc_LAW_61801/';
const SOURCES = [
  ['152:1', 'ст.1 152-ФЗ', 'd44bdb356e6a691d0c72fef05ed16f68af0af9eb/'],
  ['152:3', 'ст.3 152-ФЗ', '4f41fe599ce341751e4e34dc50a4b676674c1416/'],
  ['152:5', 'ст.5 152-ФЗ', '96fbc469f91f57235cc842a85e0516a99f23dc85/'],
  ['152:6', 'ст.6 152-ФЗ', '315f051396c88f1e4f827ba3f2ae313d999a1873/'],
  ['152:9', 'ст.9 152-ФЗ', '6c94959bc017ac80140621762d2ac59f6006b08c/'],
  ['152:10', 'ст.10 152-ФЗ', '26edb2934b899bf9c74c3a8f7e574651c6565e6d/'],
  ['152:11', 'ст.11 152-ФЗ', '7336c78762a98b5f4f698b8c3800dca1111acc16/'],
].map(([id, cite, path]) => ({ id, cite, url: ROOT + path, checkedOn: CHECKED_ON, edition: '152-ФЗ, редакция от 26.07.2026; проверенный текст на дату 22.10.2026, без утверждения всей истории' }));
const CONSENT_CHANGE = { id: '156:5-7', cite: 'ст.5/7 156-ФЗ от 24.06.2025', url: 'https://www.garant.ru/products/ipo/prime/doc/412110426/', checkedOn: CHECKED_ON, effectiveFrom: '2025-09-01' };
const PURPOSES = ['personal-family', 'commissioner-service', 'expert-service', 'publication', 'other'] as const;
const BASES = ['consent', 'contract', 'legal-obligation', 'legal-interest', 'other'] as const;
const BOOLS = ['personalDataPresent', 'rightsRespected', 'organizesOrCarriesOutProcessing', 'determinesProcessingPurposes', 'determinesDataAndActions',
  'basisApplicabilityConfirmed', 'consentObtained', 'consentFreeSpecificInformed', 'consentSeparate', 'writtenConsentRequired', 'writtenConsentRecorded',
  'healthDataPresent', 'biometricsUsedForIdentification', 'specialCategoryBasisConfirmed', 'biometricBasisConfirmed', 'willDisclose', 'disclosureBasisConfirmed'] as const;
const TEXTS = ['basisSource', 'specialCategorySource', 'biometricSource', 'disclosureSource'] as const;
const evidence = (confirmed: unknown, source: unknown): Known => all(bool(confirmed), typeof source === 'string' && source.trim() ? true : null);
const status = (value: Known) => value === true ? 'documented-declaration' : value === false ? 'gap-reported' : 'unknown';

export function describePrivacy(_project: ProjectEnvelope): FeatureDescriptor {
  return { id: 'rules.privacy-legal', title: 'Правовые основания обработки персональных данных', available: true, inputs: [
    { path: '/extensions/rules/privacy/processingDate', label: 'Дата обработки данных (ISO; отдельно от ДТП)', kind: 'text' },
    { path: '/extensions/rules/privacy/purpose', label: 'Конкретная цель обработки', kind: 'enum', choices: PURPOSES.map(value => ({ value, label: value })) },
    { path: '/extensions/rules/privacy/lawfulBasis', label: 'Заявленное основание, применимость подтверждается отдельно', kind: 'enum', choices: BASES.map(value => ({ value, label: value })) },
    ...BOOLS.map(key => ({ path: `/extensions/rules/privacy/${key}`, label: `${key} (null — неизвестно)`, kind: 'boolean' as const })),
    ...TEXTS.map(key => ({ path: `/extensions/rules/privacy/${key}`, label: `${key}: документ и конкретное основание`, kind: 'text' as const })),
  ] };
}
export function validatePrivacy(raw: unknown): FeatureIssue[] {
  if (raw == null) return [];
  const path = '/extensions/rules/privacy';
  if (typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'rules.invalid-privacy', path, message: 'Требуется объект правовых обстоятельств обработки.' }];
  const f = object(raw), issues = validateFields(f, path, BOOLS, [], { purpose: PURPOSES, lawfulBasis: BASES });
  if (f.processingDate != null && (typeof f.processingDate !== 'string' || !lawDate(f.processingDate))) issues.push({ code: 'rules.invalid-processing-date', path: `${path}/processingDate`, message: 'Требуется корректная локальная дата обработки ISO.' });
  for (const key of TEXTS) if (f[key] != null && typeof f[key] !== 'string') issues.push({ code: 'rules.invalid-privacy-source', path: `${path}/${key}`, message: 'Источник основания должен быть текстом.' });
  if (f.personalDataPresent === false && (f.healthDataPresent === true || f.biometricsUsedForIdentification === true)) issues.push({ code: 'rules.conflicting-privacy-facts', path, message: 'Заявлены специальные/биометрические ПДн при заявленном отсутствии ПДн.' });
  return issues;
}

/** Records the supplied legal basis and gaps. It cannot establish an operator's
 * real practices, obtain consent or certify a lawful processing operation. */
export function privacyGuidance(project: ProjectEnvelope) {
  const f = object(project.extensions.rules.privacy);
  const processingDate = typeof f.processingDate === 'string' ? lawDate(f.processingDate) : null;
  const personal = bool(f.personalDataPresent);
  const family = f.purpose == null ? null : f.purpose === 'personal-family';
  const familyException = all(family, bool(f.rightsRespected));
  const scope = personal === false ? 'no-personal-data-reported' : personal === null ? 'unknown'
    : familyException === true ? 'personal-family-exception-reported' : familyException === false ? '152-scope-reported' : 'unknown';
  const operatorFunctions = all(bool(f.organizesOrCarriesOutProcessing), bool(f.determinesProcessingPurposes), bool(f.determinesDataAndActions));
  const separateRequired: Known = !processingDate || processingDate > CHECKED_ON ? null : processingDate >= CONSENT_CHANGE.effectiveFrom;
  const health = bool(f.healthDataPresent), biometric = bool(f.biometricsUsedForIdentification);
  const consent = f.lawfulBasis === 'consent';
  const writtenRequired = consent ? any(health, biometric, bool(f.writtenConsentRequired)) : bool(f.writtenConsentRequired);
  const basisEvidence = f.lawfulBasis == null ? null : evidence(f.basisApplicabilityConfirmed, f.basisSource);
  const consentEvidence = consent ? all(bool(f.consentObtained), bool(f.consentFreeSpecificInformed),
    separateRequired === false ? true : separateRequired === true ? bool(f.consentSeparate) : null,
    writtenRequired === false ? true : writtenRequired === true ? bool(f.writtenConsentRecorded) : null) : null;
  const categoryCheck = (present: Known, confirmed: unknown, source: unknown) => present === false ? 'not-applicable' : present === null ? 'unknown' : status(evidence(confirmed, source));
  const disclosure = bool(f.willDisclose);
  const limitations = ['Результат отражает заявленные обстоятельства и документы, не удостоверяет законность обработки или соответствие приложения 152-ФЗ.',
    'Оператор определяется по фактическим функциям, в том числе совместным; статус пользователя или установка программы сами по себе его не определяют.',
    'Договор с одним участником не подтверждает основание для всех третьих лиц и всех целей; согласие — одно из возможных оснований, а не универсальное требование.',
    'Сведения о здоровье требуют основания по ст.10; фотография не становится биометрией автоматически: существенна её обработка для установления личности по ст.11.',
    'Собирать только необходимые для конкретной цели данные, ограничивать срок хранения целью/законом и отдельно проверять основание передачи получателю.',
    'Шифрование, контроль доступа, редактор ПДн, удаление и отправка не реализуются этим правовым модулем.'];
  if (processingDate !== CHECKED_ON) limitations.push('TODO(legal-check): проверить полный состав и редакцию требований на дату обработки; подтверждённая граница отдельного согласия не подтверждает историю остальных статей.');
  return { kind: 'privacy.legal-guidance', scope, purpose: f.purpose ?? null, processingDate, checkedOn: CHECKED_ON,
    operatorFunctions: status(operatorFunctions), operatorIdentity: null,
    basis: f.lawfulBasis ?? null, basisEvidence: status(basisEvidence), consentEvidence: consent ? status(consentEvidence) : 'not-assessed',
    separateConsentRequired: consent ? separateRequired : null, writtenConsentRequired: consent ? writtenRequired : null,
    healthBasis: categoryCheck(health, f.specialCategoryBasisConfirmed, f.specialCategorySource),
    biometricBasis: categoryCheck(biometric, f.biometricBasisConfirmed, f.biometricSource),
    disclosureBasis: disclosure === false ? 'not-applicable' : disclosure === null ? 'unknown' : status(evidence(f.disclosureBasisConfirmed, f.disclosureSource)),
    consentRequisites: consent && writtenRequired !== false ? ['Идентификация субъекта и представителя при наличии полномочий', 'Идентификация оператора',
      'Конкретная цель, перечень данных, действия и способы', 'Данные обработчика по поручению, если применимо', 'Срок, порядок отзыва и подпись по ст.9 ч.4'] : [],
    lawfulness: null, legalCertification: false, sources: [...SOURCES, CONSENT_CHANGE], limitations };
}
