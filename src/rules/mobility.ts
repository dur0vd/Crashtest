import type { Ctx } from '../analysis/context';
import type { FindingInput } from '../analysis/types';
import { observedManeuvers } from '../analysis/maneuvers';
import { posAt, tOf } from '../analysis/technical';
import { lawRef } from '../law';
import { isSmallRider, mobilityPlaceAt } from '../mobility';
import { VEHICLES, type VehicleType } from '../scene';
import type { FeatureDescriptor, FeatureIssue, InputDescriptor, JsonObject, ProjectEnvelope } from '../parallel/contracts';
import { all, any, bool, compliance, isObject, not, number, object, pointer, severity, validateFields, type Known } from './facts';

const BOOLEANS = ['hasHandlebar', 'handOnHandlebar', 'loadObstructsControl', 'passengerDesignPermitted', 'childSeatEquipped',
  'trailerDesignedForDevice', 'reflectorsPresent', 'reflectorsVisible', 'columnGroupsSeparated', 'crossesOutsideIntersection',
  'outsideYieldRespected', 'zoneConflictObserved', 'zonePriorityRespected'] as const;
const NUMBERS = ['columnRows', 'columnGroupPeople', 'columnGapM', 'columnBicycleWidthM'] as const;
const TOWING = ['none', 'towed', 'tows-device', 'tows-trailer'] as const;
export function validateMobility(raw: unknown): FeatureIssue[] {
  if (raw == null) return [];
  const path = '/extensions/rules/mobility';
  if (!isObject(raw as JsonObject)) return [{ code: 'rules.invalid-mobility', path, message: 'mobility должен быть объектом.' }];
  const input = object(raw), issues: FeatureIssue[] = [];
  if (input.actors != null && !isObject(input.actors)) issues.push({ code: 'rules.invalid-mobility-actors', path: `${path}/actors`, message: 'Требуется объект по ID участников.' });
  for (const [id, value] of Object.entries(object(input.actors))) {
    const actorPath = `${path}/actors/${pointer(id)}`;
    if (!isObject(value)) issues.push({ code: 'rules.invalid-mobility-actor', path: actorPath, message: 'Требуется объект фактов.' });
    else issues.push(...validateFields(object(value), actorPath, BOOLEANS, NUMBERS, { towing: TOWING }));
  }
  return issues;
}
export function describeMobility(project: ProjectEnvelope): FeatureDescriptor {
  const inputs: InputDescriptor[] = [];
  for (const [index, a] of project.scene.actors.entries()) if (isSmallRider(a)) {
    const path = `/extensions/rules/mobility/actors/${pointer(a.id)}`;
    for (const key of BOOLEANS) inputs.push({ path: `${path}/${key}`, label: `${a.id}: ${key} (null — неизвестно)`, kind: 'boolean' });
    for (const key of NUMBERS) inputs.push({ path: `${path}/${key}`, label: `${a.id}: ${key}`, kind: 'number', minimum: 0, ...(key.endsWith('M') ? { unit: 'm' } : {}) });
    inputs.push({ path: `${path}/towing`, label: `${a.id}: вид буксировки`, kind: 'enum', choices: TOWING.map(value => ({ value, label: value })) },
      { path: `${path}/zoneMechanicalActorId`, label: `${a.id}: ID водителя механического ТС в наблюдаемом конфликте зоны`, kind: 'text' },
      { path: `${path}/source`, label: `${a.id}: источник новых наблюдений`, kind: 'text' },
      { path: `/scene/actors/${index}/age`, label: `${a.id}: полных лет`, kind: 'number', unit: 'years', minimum: 0, maximum: 120 });
    // Reuse existing facts instead of copying them into extensions.
    for (const key of ['column', 'singleFile', 'leftTurnPermittedFromRight', 'roadEquipmentComplete', 'cycleInfrastructureUnavailable',
      'carriagewayUnavailable', 'shoulderUnavailable', 'pedestrianInfrastructureUnavailable', 'accompaniesChildUnder14', 'carriesChildUnder7',
      'adultAccompanied', 'roadAllowsCycling', 'pedestrianObstruction', 'pedestrianDanger', 'pedestrianPriorityRespected', 'leftBypass', 'causedVehicleObstruction'])
      inputs.push({ path: `/scene/actors/${index}/mobilityContext/${key}`, label: `${a.id}: mobilityContext.${key} (null — неизвестно)`, kind: 'boolean' });
    for (const key of ['roadSpeedLimit', 'pedestrianSpeedKmh']) inputs.push({ path: `/scene/actors/${index}/mobilityContext/${key}`, label: `${a.id}: ${key}`, kind: 'number', unit: 'km/h', minimum: 0 });
    inputs.push({ path: `/scene/actors/${index}/passengerContext/driverHelmetFastened`, label: `${a.id}: застёгнут мотошлем`, kind: 'boolean' });
  }
  return { id: 'rules.mobility', title: 'Дополнительные наблюдения раздела 24', available: true, inputs };
}

/** Complements the existing geometry and known/unknown facts. It never models
 * rider dynamics, injury protection, or a second list of passengers. */
export function checkMobilitySupplement(ctx: Ctx, input: JsonObject, lighting: JsonObject, add: (f: FindingInput) => unknown): void {
  for (const i of ctx.infos.values()) {
    if (!isSmallRider(i.a) || i.k0 >= ctx.tl.n) continue;
    const a = i.a, c = a.mobilityContext ?? {}, f = object(object(input.actors)[a.id]);
    let moving: number | undefined;
    for (let k = i.k0; k <= i.kEnd; k++) if (i.tr.present[k] && Math.abs(i.tr.v[k]) > 0) { moving = k; break; }
    if (moving === undefined) continue;
    const emit = (ref: string, key: string, title: string, state: Known, code = 'rule:mobility', frame = moving, extra: Record<string, unknown> = {}) => {
      const source = lawRef(`pdd:${ref}`, ctx.scene.env.accidentDate);
      const result = source.revision ? state : null;
      add({ actorId: a.id, t: tOf(frame), severity: severity(result), title, causal: false,
        detail: `${compliance(result)}. Установленные наблюдения проверяются отдельно от причинности столкновения.`,
        refs: [`pdd:${ref}`, ...(result === false ? [code] : [])], trace: { mobilitySupplement: true, mobilityRequirement: key,
          facts: f, mobilityContext: c, compliance: compliance(result), source, ...extra,
          formula: 'logical requirements on established observations; missing input → unknown', units: { distance: 'm', age: 'completed years' } } });
    };
    if (f.hasHandlebar !== undefined || f.handOnHandlebar !== undefined) emit('24.8', 'handlebar', 'Руль удерживается хотя бы одной рукой', any(not(bool(f.hasHandlebar)), bool(f.handOnHandlebar)));
    if (f.loadObstructsControl !== undefined) emit('24.8', 'load-control', 'Груз не мешает управлению', not(bool(f.loadObstructsControl)));
    if (a.cargo) emit('24.8', 'load-projection', 'Груз выступает не более чем на 0,5 м', Math.max(a.cargo.front, a.cargo.rear, a.cargo.left, a.cargo.right) <= 0.5);
    if (a.passengers && a.passengers.length > 0) {
      if (a.type !== 'moped') emit('24.8', 'passenger-design', 'Конструкция велосипеда/СИМ допускает пассажиров', bool(f.passengerDesignPermitted));
      const under7: Known = a.passengers.some(p => p.age !== undefined && p.age < 7) ? true : a.passengers.some(p => p.age === undefined) ? null : false;
      if (under7 !== false) emit('24.8', 'child-seat', 'Для ребёнка младше 7 лет оборудовано специальное место', under7 === true ? bool(f.childSeatEquipped) : null, 'rule:passenger-child');
    }
    if (f.towing !== undefined && f.towing !== null) emit('24.9', 'towing', 'Буксировка: только предназначенный для устройства прицеп',
      f.towing === 'none' ? true : f.towing === 'tows-trailer' ? bool(f.trailerDesignedForDevice) : false, a.type === 'moped' ? 'rule:mobility-towing' : 'rule:mobility');
    if (a.type === 'bicycle' && c.column === true) {
      const rows = number(f.columnRows), width = number(f.columnBicycleWidthM), group = number(f.columnGroupPeople), gap = number(f.columnGapM);
      const formation: Known = rows === null ? null : rows === 1 ? true : rows === 2 ? width === null ? null : width <= 0.75 : false;
      emit('24.5', 'column-rows', 'Колонна: один ряд либо два при ширине до 0,75 м', formation);
      emit('24.5', 'column-group', 'Колонна: группы до 10 велосипедистов или 10 пар', all(bool(f.columnGroupsSeparated),
        rows === null || group === null ? null : Number.isInteger(group) && group > 0 && group <= (rows === 2 ? 20 : 10)));
      if (f.columnGapM !== undefined) emit('24.5', 'column-gap', 'Расстояние между группами колонны 80–100 м', gap === null ? null : gap >= 80 && gap <= 100);
    }
    if (f.reflectorsPresent !== undefined || f.reflectorsVisible !== undefined) {
      const lf = object(object(lighting.actors)[a.id]);
      const dark: Known = lighting.timeOfDay === 'night' ? true : lighting.timeOfDay === 'day' ? false : null;
      const need = all(any(dark, bool(lighting.insufficientVisibility)), not(bool(lf.inSettlement)));
      if (need !== false) emit('24.10', 'reflectors', 'Световозвращающие предметы вне населённого пункта', need === true ? all(bool(f.reflectorsPresent), bool(f.reflectorsVisible)) : null);
    }
    if (f.crossesOutsideIntersection === true && a.type !== 'moped') emit('24.6(1)', 'outside-yield', 'Уступить при пересечении проезжей части вне перекрёстка', bool(f.outsideYieldRespected));
    for (const turn of observedManeuvers(ctx, i)) {
      if (turn.intersectionId || !['left', 'uturn'].includes(turn.kind)) continue;
      const road = ctx.scene.roads.find(r => r.id === turn.roadId);
      const place = mobilityPlaceAt(ctx.geo, posAt(i, turn.frame), turn.heading);
      const trams = ctx.geo.tracks.some(t => t.item.kind !== 'railway' && t.pts.some(p => road && ctx.geo.roads.some(r => r.road === road && r.pts.some(q => Math.hypot(p.x - q.x, p.y - q.y) < r.half))));
      if ((road && road.lanes > 1 || trams) && !place.cycleZone) emit('24.8', 'outside-turn', 'Ограничение поворота налево/разворота вне перекрёстка', bool(c.leftTurnPermittedFromRight), 'rule:mobility', turn.frame,
        { maneuver: turn, geometryLimit: 'Параметры распознавания манёвра — модельный фильтр, не законодательный порог' });
    }
    if (f.zoneConflictObserved === true && ['bicycle', 'sim'].includes(a.type)) {
      const place = mobilityPlaceAt(ctx.geo, posAt(i, moving), i.tr.h[moving]);
      if (place.cycleZone) {
        const other = typeof f.zoneMechanicalActorId === 'string' ? ctx.infos.get(f.zoneMechanicalActorId) : undefined;
        const mechanical = other?.isVeh && !other.a.railwayTrain && VEHICLES[other.a.type as VehicleType]?.motorized === true;
        const source = lawRef('pdd:24.11', ctx.scene.env.accidentDate);
        const result = mechanical && source.revision ? bool(f.zonePriorityRespected) : null;
        add({ actorId: mechanical ? other.a.id : a.id, t: tOf(moving), severity: severity(result), causal: false,
          title: 'Преимущество велосипедиста/СИМ в подтверждённой велосипедной зоне', detail: `${compliance(result)}. Требуется установленный конфликт и субъект обязанности уступить.`,
          refs: ['pdd:24.11', ...(result === false ? ['rule:maneuver-priority'] : [])],
          trace: { mobilitySupplement: true, mobilityRequirement: 'zone-priority', rightHolder: a.id, otherActorId: other?.a.id,
            facts: f, source, compliance: compliance(result), geometrySource: place.source, contactDoesNotProveCausality: true } });
      }
    }
  }
}
