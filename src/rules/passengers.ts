import type { Ctx } from '../analysis/context';
import type { FindingInput } from '../analysis/types';
import { tOf } from '../analysis/technical';
import { lawRef } from '../law';
import type { FeatureDescriptor, FeatureIssue, InputDescriptor, JsonObject, ProjectEnvelope } from '../parallel/contracts';
import { all, any, bool, compliance, isObject, not, number, object, pointer, severity, validateFields, type Known } from './facts';

const BOOLS = ['licenseCOrC1', 'licenseD', 'licenseD1', 'militaryDriver', 'militaryAdmissionVerified', 'bodyEquippedForPeople',
  'passengersBriefed', 'safetyCheckedBeforeStart', 'childrenSigns', 'organizedOperatorInScope', 'busBeaconCorrect',
  'busDriverBriefed', 'busDriverNoDisqualifyingPenalty', 'chartered', 'charterDocumentPresent', 'routeDocumentPresent',
  'nightExceptionEstablished', 'nightSpecialTerritory', 'nightExceptionAgreed', 'noticeSubmitted', 'noticeSpecialTerritory', 'noticeExceptionAgreed',
  'escortApplicationSubmitted', 'accompanyingAtEachBoardingDoor', 'oneBoardingDoor', 'seniorResponsibleAppointed', 'medicalWorkerPresent',
  'peopleListComplete', 'peopleListMatchesPresent', 'listChangesCertifiedBeforeDeparture', 'documentsWithResponsible', 'internationalIdentityDocumentsPresent',
  'departureDelayOccurred', 'delayNotificationsSent', 'replacementRequired', 'replacementMeasuresTaken', 'replacementActDone',
  'documentsTransferredToReplacementDriver', 'storageRetentionMet', 'childrenBeltsAdjusted'] as const;
const NUMS = ['truckLicenseYears', 'bodySeatingPlaces', 'busSeatingPlaces', 'busDriverDWorkYearsLast2', 'scheduledHours', 'nightDistanceKm',
  'busCount', 'notificationLeadHours', 'accompanyingCount', 'actualDurationHours'] as const;
const PERSON_BOOLS = ['accompaniesCargo', 'goingForCargo', 'seatBelowSides', 'boardingOccurred', 'sidewalkBoardingImpossible',
  'boardingSafe', 'boardingUnobstructed', 'standingOrSittingAboveSides', 'distractsDriver', 'opensDoorWhileMoving'] as const;
const ENUMS = { truckBodyKind: ['board-platform', 'van-body', 'other'], busRouteClass: ['long-distance', 'international', 'city', 'suburban', 'mountain', 'tourist', 'excursion', 'other'] };
const PERSON_ENUMS = { boardingSide: ['sidewalk', 'shoulder', 'carriageway'] };
export function validatePassengerSupplement(raw: unknown): FeatureIssue[] {
  if (raw == null) return [];
  const path = '/extensions/rules/passengers';
  if (!isObject(raw as JsonObject)) return [{ code: 'rules.invalid-passengers', path, message: 'passengers должен быть объектом.' }];
  const input = object(raw), issues: FeatureIssue[] = [];
  if (input.actors != null && !isObject(input.actors)) issues.push({ code: 'rules.invalid-passengers-actors', path: `${path}/actors`, message: 'Требуется объект по ID ТС.' });
  for (const [id, value] of Object.entries(object(input.actors))) {
    const actorPath = `${path}/actors/${pointer(id)}`;
    if (!isObject(value)) { issues.push({ code: 'rules.invalid-passengers-actor', path: actorPath, message: 'Требуется объект фактов.' }); continue; }
    const f = object(value); issues.push(...validateFields(f, actorPath, BOOLS, NUMS, ENUMS));
    if (f.people != null && !isObject(f.people)) issues.push({ code: 'rules.invalid-passengers-people', path: `${actorPath}/people`, message: 'Требуется объект дополнительных фактов по ID из Actor.passengers.' });
    for (const [pid, person] of Object.entries(object(f.people))) issues.push(...validateFields(object(person), `${actorPath}/people/${pointer(pid)}`, PERSON_BOOLS, [], PERSON_ENUMS));
  }
  return issues;
}
export function describePassengerSupplement(project: ProjectEnvelope): FeatureDescriptor {
  const inputs: InputDescriptor[] = [];
  for (const [index, a] of project.scene.actors.entries()) if (a.kind === 'vehicle' && !a.railwayTrain) {
    const path = `/extensions/rules/passengers/actors/${pointer(a.id)}`;
    for (const key of BOOLS) inputs.push({ path: `${path}/${key}`, label: `${a.id}: ${key} (null — неизвестно)`, kind: 'boolean' });
    for (const key of NUMS) inputs.push({ path: `${path}/${key}`, label: `${a.id}: ${key}`, kind: 'number', minimum: 0,
      ...(key.includes('Years') ? { unit: 'years' } : key.endsWith('Hours') ? { unit: 'h' } : key.endsWith('Km') ? { unit: 'km' } : {}) });
    for (const [key, values] of Object.entries(ENUMS)) inputs.push({ path: `${path}/${key}`, label: `${a.id}: ${key}`, kind: 'enum', choices: values.map(value => ({ value, label: value })) });
    for (const key of ['beltsProvided', 'driverBeltUsed', 'driverHelmetFastened', 'boardingWhileMoving', 'doorsClosedWhileMoving', 'organizedChildren'])
      inputs.push({ path: `/scene/actors/${index}/passengerContext/${key}`, label: `${a.id}: passengerContext.${key} (null — неизвестно)`, kind: 'boolean' });
    inputs.push({ path: `/scene/actors/${index}/passengerContext/vehicleClass`, label: `${a.id}: установленный класс ТС`, kind: 'enum', choices: ['passenger-car', 'truck', 'other'].map(value => ({ value, label: value })) });
    for (const key of ['passengerCapacity', 'qualifyingLicenseYears']) inputs.push({ path: `/scene/actors/${index}/passengerContext/${key}`, label: `${a.id}: ${key}`, kind: 'number', minimum: 0, ...(key.endsWith('Years') ? { unit: 'years' } : {}) });
    for (const [pi, person] of (a.passengers ?? []).entries()) {
      const personPath = `${path}/people/${pointer(person.id)}`, scenePath = `/scene/actors/${index}/passengers/${pi}`;
      inputs.push({ path: `${scenePath}/age`, label: `${person.id}: полных лет`, kind: 'number', minimum: 0, maximum: 120, unit: 'years' });
      for (const key of ['beltUsed', 'helmetFastened', 'restraintUsed', 'restraintFits', 'restraintInstalledCorrectly']) inputs.push({ path: `${scenePath}/${key}`, label: `${person.id}: ${key} (null — неизвестно)`, kind: 'boolean' });
      for (const key of PERSON_BOOLS) inputs.push({ path: `${personPath}/${key}`, label: `${person.id}: ${key} (null — неизвестно)`, kind: 'boolean' });
      inputs.push({ path: `${personPath}/boardingSide`, label: `${person.id}: сторона посадки/высадки`, kind: 'enum', choices: PERSON_ENUMS.boardingSide.map(value => ({ value, label: value })) });
    }
    inputs.push({ path: `${path}/source`, label: `${a.id}: источник специальных условий`, kind: 'text' });
  }
  return { id: 'rules.passengers', title: 'Специальные условия перевозки и обязанности пассажиров', available: true, inputs };
}

export function checkPassengerSupplement(ctx: Ctx, input: JsonObject, add: (f: FindingInput) => unknown): void {
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || i.a.railwayTrain || i.k0 >= ctx.tl.n) continue;
    const a = i.a, c = a.passengerContext ?? {}, f = object(object(input.actors)[a.id]);
    const people = a.passengers, body = people?.filter(p => p.place === 'body'), count = people?.length;
    let moving: number | undefined;
    for (let k = i.k0; k <= i.kEnd; k++) if (i.tr.present[k] && Math.abs(i.tr.v[k]) > 0) { moving = k; break; }
    const emit = (refs: string[], key: string, title: string, state: Known, code = 'rule:passenger-general', personId?: string, requiresMovement = true, extra: Record<string, unknown> = {}) => {
      if (requiresMovement && moving === undefined) return;
      const sources = refs.map(ref => lawRef(ref, ctx.scene.env.accidentDate));
      const result = sources.every(s => s.revision) ? state : null;
      add({ actorId: a.id, t: tOf(moving ?? i.k0), severity: severity(result), title, causal: false,
        detail: `${compliance(result)}. ${personId ? `Пассажир ${personId}. ` : ''}Оценка по заданным фактам; медицинский эффект и причинность не вычисляются.`,
        refs: [...refs, ...(result === false && code ? [code] : [])],
        trace: { passengerSupplement: true, passengerRequirement: key, passengerId: personId, facts: f, sources, ...extra,
          compliance: compliance(result), personalDuty: code === 'rule:passenger-personal',
          legalSubject: code === 'rule:passenger-personal' ? 'passenger' : code === 'rule:organized-other' || code === 'rule:organized-accompanying' ? 'organizer' : 'driver',
          formula: 'conjunction of established category, duration, capacity and safety requirements', units: { licenseYears: 'years', count: 'persons' } } });
    };
    const truck = c.vehicleClass === 'truck';
    if (truck && body && body.length > 0) {
      const years = number(f.truckLicenseYears);
      const civil = all(bool(f.licenseCOrC1), years === null ? null : years >= 3,
        count === undefined ? null : count > 16 ? bool(f.licenseD) : count > 8 ? any(bool(f.licenseD), bool(f.licenseD1)) : true);
      const qualified = f.militaryDriver === true ? bool(f.militaryAdmissionVerified) : f.militaryDriver === false ? civil : null;
      emit(['pdd:22.1'], 'truck-license', 'Категории и стаж для перевозки в кузове грузовика', qualified);
      const platform = f.truckBodyKind === 'board-platform';
      if (platform) {
        const equipped = bool(f.bodyEquippedForPeople);
        const capacity = number(f.bodySeatingPlaces);
        emit(['pdd:22.3'], 'body-seats', 'Число людей в кузове не превышает сидячие места', capacity === null ? null : body.length <= capacity);
        for (const p of body) {
          const pf = object(object(f.people)[p.id]);
          const cargoException = all(any(bool(pf.accompaniesCargo), bool(pf.goingForCargo)), bool(pf.seatBelowSides));
          const permitted = equipped === true ? true : equipped === false ? cargoException : null;
          emit(['pdd:22.2', 'pdd:22.5'], 'body-equipment', 'Оборудование платформы либо исключение для сопровождающего груз', permitted, 'rule:passenger-outside', p.id);
          if (equipped === true) emit(['pdd:22.2'], 'body-child', 'Запрет перевозки детей в оборудованном бортовом кузове', p.age === undefined ? null : p.age >= 18, 'rule:passenger-child', p.id,
            true, { childDefinitionSource: 'https://www.consultant.ru/document/cons_doc_LAW_19558/8ecbe3314ad9e500bfb90273b6c736f7e0e78429/' });
        }
      } else if (f.truckBodyKind !== 'van-body') emit(['pdd:22.8'], 'body-kind', 'Кузов должен соответствовать разрешённому исключению', f.truckBodyKind === 'other' ? false : null, 'rule:passenger-outside');
      emit(['pdd:22.4'], 'briefing', 'Водитель инструктирует пассажиров и проверяет безопасность перед началом движения', all(bool(f.passengersBriefed), bool(f.safetyCheckedBeforeStart)));
    }
    const seatedBus = a.type === 'bus' && (['long-distance', 'mountain', 'tourist', 'excursion'].includes(String(f.busRouteClass)) || c.organizedChildren === true);
    if (seatedBus && count !== undefined && count > 0) { const seats = number(f.busSeatingPlaces);
      emit(['pdd:22.3'], 'bus-seats', 'Число пассажиров автобуса не превышает сидячие места', seats === null ? null : count <= seats); }
    for (const p of people ?? []) {
      const pf = object(object(f.people)[p.id]);
      if (pf.boardingOccurred === true) {
        const side = pf.boardingSide;
        const sideOK = side === 'sidewalk' || side === 'shoulder' ? true : side === 'carriageway' ? all(bool(pf.sidewalkBoardingImpossible), bool(pf.boardingSafe), bool(pf.boardingUnobstructed)) : null;
        emit(['pdd:5.1'], 'boarding-side', 'Сторона и безопасность посадки/высадки пассажира', all(sideOK, not(bool(c.boardingWhileMoving))), 'rule:passenger-personal', p.id, false);
      }
      for (const [key, title] of [['standingOrSittingAboveSides', 'Пассажир не стоит и не сидит выше бортов'], ['distractsDriver', 'Пассажир не отвлекает водителя'], ['opensDoorWhileMoving', 'Пассажир не открывает дверь при движении']])
        if (pf[key] !== undefined && (key !== 'standingOrSittingAboveSides' || truck && f.truckBodyKind === 'board-platform')) emit(['pdd:5.2'], key, title, not(bool(pf[key])), 'rule:passenger-personal', p.id);
    }
    if (c.organizedChildren === true) {
      emit(['pdd:22.6'], 'group-bus', 'Организованная перевозка детей: автобус со знаками', all(a.type === 'bus', bool(f.childrenSigns)), 'rule:passenger-child');
      const scope = bool(f.organizedOperatorInScope);
      const recent = lawRef('bus:680.17', ctx.scene.env.accidentDate).revision;
      if (!recent || scope !== true || a.type !== 'bus') {
        emit(['pdd:22.6'], 'group-rules-scope', 'Применимость специальных правил перевозки группы', null, '', undefined, true,
          { scope, legalCheck: 'TODO(legal-check): до 01.09.2026 требуется редакция №1527; для №680 требуется субъект по пункту 3. Старые условия не подставляются.' });
        continue;
      }
      emit(['pdd:22.6', 'bus:680.17'], 'group-belts', 'Автобус оборудован ремнями безопасности', bool(c.beltsProvided), 'rule:organized-bus');
      emit(['pdd:22.6', 'bus:680.18'], 'group-beacon', 'Жёлтый/оранжевый маячок с видимостью 360° включён', bool(f.busBeaconCorrect), 'rule:organized-bus');
      const work = number(f.busDriverDWorkYearsLast2);
      emit(['pdd:22.6', 'bus:680.19'], 'group-driver', 'Стаж D, инструктаж и отсутствие исключающих наказаний', all(work === null ? null : work >= 1 && work <= 2, bool(f.busDriverBriefed), bool(f.busDriverNoDisqualifyingPenalty)), 'rule:organized-bus');
      const hours = number(f.scheduledHours);
      const under7: Known = people?.some(p => p.age !== undefined && p.age < 7) ? true : people === undefined || people.some(p => p.age === undefined) ? null : false;
      if (hours !== null && hours > 4 || hours === null) emit(['pdd:22.6', 'bus:680.8'], 'group-under7', 'При времени по графику свыше 4 часов нет детей младше 7', hours === null ? null : not(under7), 'rule:organized-other');
      const localTime = ctx.scene.env.accidentDate.match(/T(\d{2}):(\d{2})/);
      if (localTime) { const hour = +localTime[1]; if (hour >= 23 || hour < 6) {
        const distance = number(f.nightDistanceKm);
        const exception = any(bool(f.nightExceptionEstablished), all(bool(f.nightSpecialTerritory), bool(f.nightExceptionAgreed)));
        emit(['pdd:22.6', 'bus:680.12'], 'group-night', 'Ночная перевозка: специальное основание и расстояние до 100 км', all(exception, distance === null ? null : distance <= 100), 'rule:organized-night');
      } } else emit(['pdd:22.6', 'bus:680.12'], 'group-night-time', 'Для ночных ограничений требуется местное время', null, '');
      emit(['pdd:22.6', 'bus:680.20'], 'group-driver-documents', 'У водителя имеются документы маршрута и фрахтования при его наличии', all(bool(f.routeDocumentPresent), f.chartered === false ? true : f.chartered === true ? bool(f.charterDocumentPresent) : null), 'rule:organized-bus');
      const operatorDuty = (point: string, key: string, title: string, state: Known, accompanying = false) => emit(['pdd:22.6', `bus:680.${point}`], key, title, state,
        accompanying ? 'rule:organized-accompanying' : 'rule:organized-other', undefined, true, { responsibleRole: accompanying ? 'accompanying-person' : 'organizer-or-charterer' });
      const buses = number(f.busCount), lead = number(f.notificationLeadHours);
      if (buses === null || buses < 3) {
        operatorDuty('4', 'group-notice', 'Уведомление для одного/двух автобусов подано до начала', buses === null ? null : bool(f.noticeSubmitted));
        const route = f.busRouteClass;
        const requiredHours = ['long-distance', 'international'].includes(String(route)) ? 48 : ['city', 'suburban'].includes(String(route)) ? 24 : null;
        operatorDuty('5', 'group-notice-time', 'Срок уведомления 24/48 часов либо согласованное исключение', buses === null ? null : any(all(bool(f.noticeSpecialTerritory), bool(f.noticeExceptionAgreed)), lead === null || requiredHours === null ? null : lead >= requiredHours));
      } else operatorDuty('7', 'group-escort-application', 'Для трёх и более автобусов подана заявка на сопровождение', bool(f.escortApplicationSubmitted));
      const childrenCount = people === undefined || people.some(p => p.age === undefined) ? null : people.filter(p => p.age! < 18).length;
      const accompanying = number(f.accompanyingCount);
      operatorDuty('9', 'group-accompanying', 'Сопровождающие назначены на всю поездку и размещены у дверей', all(accompanying === null ? null : accompanying >= 1,
        any(bool(f.accompanyingAtEachBoardingDoor), all(childrenCount === null ? null : childrenCount <= 20, bool(f.oneBoardingDoor)))));
      if (buses === null || buses >= 2) operatorDuty('10', 'group-senior', 'Для двух и более автобусов назначен старший ответственный', buses === null ? null : bool(f.seniorResponsibleAppointed));
      const actualHours = number(f.actualDurationHours);
      const needsMedic = all(buses === null ? null : buses >= 3, actualHours === null ? null : actualHours > 12);
      if (needsMedic !== false) operatorDuty('11', 'group-medic', 'При трёх и более автобусах свыше 12 часов есть медработник', needsMedic === true ? bool(f.medicalWorkerPresent) : null);
      operatorDuty('13', 'group-people-list', 'Список лиц содержит все необходимые сведения', bool(f.peopleListComplete));
      operatorDuty('15', 'group-responsible-documents', 'У ответственного находятся необходимые копии и список', bool(f.documentsWithResponsible));
      operatorDuty('16', 'group-list-consistency', 'Фактический состав и изменения списка соответствуют требованиям', all(bool(f.peopleListMatchesPresent), bool(f.listChangesCertifiedBeforeDeparture)));
      if (f.busRouteClass === 'international') operatorDuty('14', 'group-international-documents', 'Документы личности для международной перевозки', bool(f.internationalIdentityDocumentsPresent));
      if (f.departureDelayOccurred === true) operatorDuty('21', 'group-delay-notice', 'О задержке уведомлены установленные адресаты', bool(f.delayNotificationsSent));
      const childrenBelts: Known = people?.some(p => p.age !== undefined && p.age < 18 && p.beltUsed === false) ? false
        : people === undefined || people.some(p => p.age === undefined || p.age < 18 && p.beltUsed === undefined) ? null : true;
      operatorDuty('22', 'group-child-belts', 'Сопровождающий контролирует пристёгивание и регулировку ремней детей', all(childrenBelts, bool(f.childrenBeltsAdjusted)), true);
      if (f.replacementRequired === true) operatorDuty('23', 'group-replacement', 'Приняты меры замены, оформлен акт и переданы документы', all(bool(f.replacementMeasuresTaken), bool(f.replacementActDone), bool(f.documentsTransferredToReplacementDriver)));
      if (f.storageRetentionMet !== undefined) operatorDuty('24', 'group-document-retention', 'Соблюдены сроки хранения документов после перевозки', bool(f.storageRetentionMet));
    }
  }
}
