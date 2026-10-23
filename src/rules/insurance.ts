import type { FeatureDescriptor, FeatureIssue, JsonObject, ProjectEnvelope } from '../parallel/contracts';
import { lawRef, type LawRef } from '../law';
import { lawDate } from '../law-version';
import { all, any, bool, not, number, object, validateFields, type Known } from './facts';

const BOOLS = ['vehiclesInteracted', 'bothOwnersInsured', 'disagreement', 'noticeCompleted', 'dataRecordedAndTransferred',
  'experimentalRegime', 'multipleResponsibleEstablished', 'courtFaultSharesEstablished'] as const;
const ENUMS = { harm: ['vehicles-only', 'health', 'other-property', 'mixed'], insuranceSystem: ['domestic-osago', 'foreign-system', 'none'] };
export interface EuroprotocolAssessment {
  status: 'met' | 'not-met' | 'unknown'; accidentDate: string;
  limitRub: number | null; conditionalLimitRangeRub: [number, number] | null;
  estimatedDamageWithinLimit: Known; disagreementLimitRub: number | null;
  reasons: string[]; hints: string[]; sources: LawRef[];
  trace: { facts: JsonObject; conditions: Record<string, Known>; formula: string; units: { money: 'RUB' }; officialService: false };
}
export function describeInsurance(_project: ProjectEnvelope): FeatureDescriptor {
  return { id: 'rules.insurance', title: 'Условия европротокола и ОСАГО', available: true, inputs: [
    ...BOOLS.map(key => ({ path: `/extensions/rules/insurance/${key}`, label: `${key} (null — неизвестно)`, kind: 'boolean' as const })),
    { path: '/extensions/rules/insurance/vehicleCount', label: 'ТС в ДТП, прицеп с тягачом считается одним ТС', kind: 'number', minimum: 1 },
    { path: '/extensions/rules/insurance/estimatedDamageRub', label: 'Установленная оценка ущерба для сравнения с лимитом', kind: 'number', unit: 'RUB', minimum: 0 },
    ...Object.entries(ENUMS).map(([key, values]) => ({ path: `/extensions/rules/insurance/${key}`, label: key, kind: 'enum' as const, choices: values.map(value => ({ value, label: value })) })),
    { path: '/extensions/rules/insurance/source', label: 'Источник обстоятельств ДТП и страхования', kind: 'text' },
    { path: '/extensions/rules/insurance/responsibilitySource', label: 'Документ, устанавливающий нескольких ответственных (не вывод симулятора)', kind: 'text' },
  ] };
}
export function validateInsurance(raw: unknown): FeatureIssue[] {
  if (raw == null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'rules.invalid-insurance', path: '/extensions/rules/insurance', message: 'Страховые обстоятельства должны быть объектом.' }];
  const input = object(raw), issues = validateFields(input, '/extensions/rules/insurance', BOOLS, ['vehicleCount', 'estimatedDamageRub'], ENUMS);
  if (input.vehicleCount != null && (number(input.vehicleCount) === null || Number(input.vehicleCount) < 1 || !Number.isInteger(input.vehicleCount))) issues.push({ code: 'rules.invalid-vehicle-count', path: '/extensions/rules/insurance/vehicleCount', message: 'Число ТС должно быть положительным целым; прицепы учитываются вместе с тягачом.' });
  return issues;
}

/** Guidance only: no official notice submission, policy lookup or determination
 * of liability/damage. Photos on disk are not successful statutory transmission. */
export function assessEuroprotocol(project: ProjectEnvelope): EuroprotocolAssessment {
  const f = object(project.extensions.rules.insurance), date = project.scene.env.accidentDate, day = lawDate(date);
  const source = lawRef('osago:11.1', date), supported = !!source.revision;
  const conflictCap = supported && day ? day >= '2025-07-05' ? 200000 : 100000 : null;
  const count = number(f.vehicleCount), digital = bool(f.dataRecordedAndTransferred), disagreement = bool(f.disagreement);
  const domestic: Known = f.insuranceSystem === 'domestic-osago' ? true : f.insuranceSystem === 'none' ? false : null;
  const harm: Known = f.harm === 'vehicles-only' ? true : ['health', 'other-property', 'mixed'].includes(String(f.harm)) ? false : null;
  const conditions: Record<string, Known> = { edition: supported, twoVehicles: count === null ? null : count === 2,
    collision: bool(f.vehiclesInteracted), onlyVehicleDamage: harm, insured: all(domestic, bool(f.bothOwnersInsured)),
    notice: bool(f.noticeCompleted), ordinaryRegime: not(bool(f.experimentalRegime)), agreementOrTransmission: any(not(disagreement), digital) };
  const outsideScope = f.experimentalRegime === true || f.insuranceSystem === 'foreign-system';
  const state = supported && !outsideScope ? all(...Object.values(conditions)) : null;
  const caps: number[] = [];
  if (supported && conflictCap !== null) {
    // Enumerate the genuinely unknown facts, not a false default.
    for (const conflict of disagreement === null ? [false, true] : [disagreement]) for (const recorded of digital === null ? [false, true] : [digital]) {
      if (conflict && !recorded) continue;
      caps.push(conflict ? conflictCap : recorded ? 400000 : 100000);
    }
  }
  const bounds: [number, number] | null = caps.length ? [Math.min(...caps), Math.max(...caps)] : null;
  const limit = state === true && bounds && bounds[0] === bounds[1] ? bounds[0] : null;
  const damage = number(f.estimatedDamageRub);
  const within: Known = state !== true || damage === null || bounds === null ? null : damage <= bounds[0] ? true : damage > bounds[1] ? false : null;
  const reasons: string[] = [];
  if (!supported) reasons.push('TODO(legal-check): для этой даты нет проверенного набора условий/лимитов европротокола.');
  if (count !== null && count !== 2) reasons.push('Условие взаимодействия именно двух ТС не выполнено.');
  if (harm === false) reasons.push('При вреде здоровью или иному имуществу проверяемые условия европротокола не выполнены.');
  if (disagreement === true && digital === false) reasons.push('При разногласиях необходима предусмотренная законом фиксация и передача данных.');
  if (f.insuranceSystem === 'foreign-system' || f.experimentalRegime !== false) reasons.push('TODO(legal-check): иностранная система/экспериментальный режим или его неизвестность требуют отдельной проверки применимости.');
  if (within === false) reasons.push('Оценка ущерба превышает проверенный лимит: для сохранения возможности требовать больший размер рекомендуется оформление с полицией. Это не автоматическая недействительность европротокола.');
  const hints = ['Установить дату, место, участников, действующее страхование, отсутствие пострадавших и вреда другому имуществу.',
    'Зафиксировать схему, обстоятельства, характер и перечень видимых повреждений, наличие/суть разногласий в извещении.',
    'Фото проекта не заменяют фиксацию и подтверждённую передачу через предусмотренные законом средства; использовать официальный канал оформления.',
    'Это правовая подсказка: приложение не подаёт извещение и не имитирует сервис страховщика, РСА или Госуслуг.'];
  return { status: state === true ? 'met' : state === false ? 'not-met' : 'unknown', accidentDate: date, limitRub: limit,
    conditionalLimitRangeRub: state === false ? null : bounds, estimatedDamageWithinLimit: within, disagreementLimitRub: conflictCap,
    reasons, hints, sources: [source], trace: { facts: f, conditions, formula: 'all statutory conditions; limit = f(date, disagreement, statutory recording/transmission); unknown facts enumerate conditional limits', units: { money: 'RUB' }, officialService: false } };
}
export function assessEqualShares(project: ProjectEnvelope) {
  const f = object(project.extensions.rules.insurance), source = lawRef('osago:12#22', project.scene.env.accidentDate);
  const established: Known = typeof f.responsibilitySource === 'string' && !!f.responsibilitySource.trim() ? bool(f.multipleResponsibleEstablished) : null;
  const state = source.revision ? all(established, bool(f.bothOwnersInsured), not(bool(f.courtFaultSharesEstablished))) : null;
  return { status: state === true ? 'applicable' : state === false ? 'not-applicable' : 'unknown', source,
    text: state === true ? 'При установленных нескольких ответственных и отсутствии установленной судом степени вины применяется правило страхового возмещения в равных долях. Проценты вины не определяются.'
      : 'Неопределённость реконструкции сама по себе не влечёт равные доли: нужны документы о нескольких ответственных, страхование и сведения об установленной судом степени вины.',
    trace: { multipleResponsibleEstablished: established, courtFaultSharesEstablished: bool(f.courtFaultSharesEstablished), responsibilitySource: f.responsibilitySource ?? null, faultPercentage: null, inferredFromSimulation: false } };
}
