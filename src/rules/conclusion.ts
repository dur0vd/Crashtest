import type { FeatureDescriptor, FeatureIssue, ProjectEnvelope } from '../parallel/contracts';
import { lawDate } from '../law-version';
import { all, bool, object, type Known, validateFields } from './facts';

const CHECKED_ON = '2026-10-22';
const SOURCE25 = { id: 'fz73:25', cite: 'ст.25 73-ФЗ', url: 'https://14.mchs.gov.ru/deyatelnost/napravleniya-deyatelnosti/ispytatelnaya-pozharnaya-laboratoriya/rukovodyashchie-dokumenty/73-fz-zakon-o-sud-eksp-deyatelnosti-zakon-31-05-2001',
  checkedOn: CHECKED_ON, edition: 'Текст нормативного акта на официальном сайте МЧС; дата редакции страницы не обозначена' };
const SOURCE41 = { ...SOURCE25, id: 'fz73:41', cite: 'ст.41 73-ФЗ' };
const SOURCE204 = { id: 'upk:204', cite: 'ст.204 УПК РФ', url: 'https://www.consultant.ru/document/cons_doc_LAW_34481/2df1a669ef600720edab36ae59d4c099a5e86284/',
  checkedOn: CHECKED_ON, edition: 'УПК РФ, редакция от 26.07.2026' };
const PROCEDURES = ['technical-draft', 'commissioner', 'judicial-expert', 'criminal-expert'] as const;
const REQUISITES = [
  ['dateTimePlaceRecorded', 'Дата, время и место исследования'],
  ['appointmentBasisRecorded', 'Основания назначения исследования/экспертизы'],
  ['appointingAuthorityRecorded', 'Орган или лицо, назначившее экспертизу; для УПК — должностное лицо'],
  ['expertIdentityQualificationsRecorded', 'ФИО эксперта, образование, специальность, стаж, степень/звание и должность'],
  ['institutionRecorded', 'Сведения об экспертном учреждении либо установленный статус независимого эксперта'],
  ['liabilityWarningRecorded', 'Фактическое предупреждение об ответственности за заведомо ложное заключение'],
  ['questionsRecorded', 'Вопросы, поставленные перед экспертом'],
  ['objectsMaterialsRecorded', 'Объекты и предоставленные материалы исследования'],
  ['attendeesRecorded', 'Присутствовавшие участники процесса либо установленное отсутствие таких лиц'],
  ['methodsResultsRecorded', 'Содержание и результаты исследований, применённые методики и пределы'],
  ['conclusionsJustified', 'Выводы по вопросам, оценка результатов и обоснование'],
  ['signaturesRecorded', 'Фактическая подпись эксперта/членов комиссии'],
] as const;
const BOOLS = [...REQUISITES.map(([key]) => key), 'stateInstitution', 'institutionSealRecorded', 'illustrationsUsed', 'illustrationsAttached'] as const;
export function describeConclusion(_project: ProjectEnvelope): FeatureDescriptor {
  return { id: 'rules.conclusion-requisites', title: 'Реквизиты справки и проекта заключения', available: true, inputs: [
    { path: '/extensions/rules/conclusion/procedure', label: 'Назначение документа', kind: 'enum', choices: PROCEDURES.map(value => ({ value, label: value })) },
    { path: '/extensions/rules/conclusion/preparedDate', label: 'Дата подготовки документа (ISO, отдельно от даты ДТП)', kind: 'text' },
    ...BOOLS.map(key => ({ path: `/extensions/rules/conclusion/${key}`, label: `${key} (null — неизвестно; факт реквизита, не юридическая сертификация)`, kind: 'boolean' as const })),
  ] };
}
export function validateConclusion(raw: unknown): FeatureIssue[] {
  if (raw == null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'rules.invalid-conclusion', path: '/extensions/rules/conclusion', message: 'Требуется объект реквизитов документа.' }];
  const f = object(raw), issues = validateFields(f, '/extensions/rules/conclusion', BOOLS, [], { procedure: PROCEDURES });
  if (f.preparedDate != null && (typeof f.preparedDate !== 'string' || !lawDate(f.preparedDate))) issues.push({ code: 'rules.invalid-prepared-date', path: '/extensions/rules/conclusion/preparedDate', message: 'Дата документа должна быть корректной локальной датой ISO.' });
  return issues;
}

/** A content checklist cannot appoint an expert, warn them of liability, sign
 * a report, establish admissibility or certify scientific/legal validity. */
export function conclusionGuidance(project: ProjectEnvelope) {
  const f = object(project.extensions.rules.conclusion), procedure = f.procedure ?? null;
  const judicial: Known = procedure === 'judicial-expert' || procedure === 'criminal-expert' ? true : procedure === 'technical-draft' || procedure === 'commissioner' ? false : null;
  const sources = procedure === 'criminal-expert' ? [SOURCE25, SOURCE41, SOURCE204] : [SOURCE25, SOURCE41];
  const records = REQUISITES.map(([field, label]) => ({ field, label, required: judicial,
    recorded: bool(f[field]), sources: sources.map(s => s.id) }));
  const conditional = (field: string, label: string, required: Known) => ({ field, label, required, recorded: bool(f[field]), sources: [SOURCE25.id] });
  const checklist: { field: string; label: string; required: Known; recorded: Known; sources: string[] }[] = [
    ...records,
    conditional('institutionSealRecorded', 'Печать государственного судебно-экспертного учреждения при применимости', judicial === false ? false : bool(f.stateInstitution)),
    conditional('illustrationsAttached', 'Использованные иллюстрации приложены как составная часть заключения', judicial === false ? false : bool(f.illustrationsUsed)),
  ];
  const states = checklist.map(item => item.required === false || item.recorded === true ? true : item.required === null ? null : item.recorded);
  const contentState = all(...states);
  const preparedDate = typeof f.preparedDate === 'string' ? lawDate(f.preparedDate) : null;
  const limitations = ['Это проверка полноты заявленных реквизитов, не удостоверение процессуального статуса, научной правильности, допустимости или юридической силы документа.',
    'Предупреждение, подпись и печать отмечаются только если они фактически имели место; текст приложения не создаёт их.',
    'Справка аварийного комиссара и технический проект не становятся заключением судебного эксперта от применения этого списка.',
    'Научные расчёты, нормы и предварительная квалификация должны оставаться отдельными частями; неизвестные обстоятельства и пределы методов раскрываются.'];
  if (!preparedDate || preparedDate !== CHECKED_ON) limitations.push('TODO(legal-check): проверить редакции процессуальных требований на отдельную дату подготовки документа; дата ДТП её не заменяет.');
  if (judicial && procedure !== 'criminal-expert') limitations.push('TODO(legal-check): выбрать применимые ГПК/АПК/КАС/КоАП по реальному производству; статья 204 УПК не распространяется автоматически на все документы.');
  return { kind: 'conclusion.requisites', procedure, preparedDate, checkedOn: CHECKED_ON, checklist,
    contentState: judicial === false ? 'advisory' : judicial === null ? 'unknown' : contentState === true ? 'recorded' : contentState === false ? 'incomplete' : 'unknown',
    legalCertification: false, scientificCertification: false, sources, limitations,
    structure: ['Основания, вопросы, сведения об эксперте и предоставленных материалах', 'Технические исследования, расчёты, источники и пределы',
      'Проверка нормативных требований по применимой редакции', 'Предварительная правовая интерпретация и неразрешённые вопросы', 'Выводы по вопросам, приложения и фактическое удостоверение'] };
}
