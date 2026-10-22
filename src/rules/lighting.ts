import type { Ctx } from '../analysis/context';
import type { FindingInput } from '../analysis/types';
import { classifyStop, stopIntervals } from '../analysis/stopping';
import { tOf } from '../analysis/technical';
import { lawRef } from '../law';
import { vehicleSignalAt } from '../maneuver-signals';
import { VEHICLES, type VehicleType } from '../scene';
import type { FeatureDescriptor, FeatureIssue, InputDescriptor, JsonObject, ProjectEnvelope } from '../parallel/contracts';
import { all, any, bool, compliance, isObject, not, number, object, pointer, severity, validateFields, type Known } from './facts';

const GLOBAL_BOOLS = ['insufficientVisibility'] as const;
const ACTOR_BOOLS = ['lowBeam', 'highBeam', 'drl', 'frontFog', 'rearFog', 'positionLamp', 'headlamp', 'lampsInstalled',
  'inTunnel', 'roadLit', 'inSettlement', 'oncomingEncounter', 'oncomingRequestsDip', 'dazzleRisk',
  'slowedAfterDazzle', 'stoppedAfterDazzle', 'laneKeptAfterDazzle', 'searchlight', 'searchlightAuthorized',
  'rearFogLinkedToBrakes', 'hornUsed', 'hornNecessaryToPreventAccident', 'overtakeWarning', 'overtakeFlash', 'flashBrief'] as const;
const ACTOR_NUMBERS = ['oncomingDistanceM'] as const;
const TIME = ['day', 'twilight', 'night'] as const;
const LABEL: Record<string, string> = {
  lowBeam: 'Ближний свет включён', highBeam: 'Дальний свет включён', drl: 'Дневные ходовые огни включены',
  frontFog: 'Передние противотуманные фары включены', rearFog: 'Задние противотуманные фонари включены',
  positionLamp: 'Габаритные огни включены', headlamp: 'Фара или фонарь включены', lampsInstalled: 'Фонари повозки установлены',
  inTunnel: 'Движение в тоннеле', roadLit: 'Дорога освещена', inSettlement: 'В населённом пункте',
  oncomingEncounter: 'Установлен встречный разъезд', oncomingRequestsDip: 'Встречный водитель просит переключить свет',
  dazzleRisk: 'Установлена возможность ослепления других водителей', oncomingDistanceM: 'Расстояние до встречного ТС',
  slowedAfterDazzle: 'После ослепления снизил скорость', stoppedAfterDazzle: 'После ослепления остановился',
  laneKeptAfterDazzle: 'После ослепления сохранил полосу', searchlight: 'Фара-прожектор/искатель включена',
  searchlightAuthorized: 'Установлены все условия служебного исключения 19.6', rearFogLinkedToBrakes: 'Задние ПТФ подключены к стоп-сигналам',
  hornUsed: 'Звуковой сигнал использован', hornNecessaryToPreventAccident: 'Сигнал необходим для предотвращения ДТП',
  overtakeWarning: 'Сигнал для предупреждения об обгоне', overtakeFlash: 'Подан световой сигнал об обгоне', flashBrief: 'Переключение ближнего на дальний кратковременное',
};
export function validateLighting(raw: unknown): FeatureIssue[] {
  if (raw === undefined || raw === null) return [];
  const path = '/extensions/rules/lighting';
  if (!isObject(raw as JsonObject)) return [{ code: 'rules.invalid-lighting', path, message: 'lighting должен быть JSON-объектом.' }];
  const lighting = object(raw);
  const issues = validateFields(lighting, path, GLOBAL_BOOLS, [], { timeOfDay: TIME });
  if (lighting.actors != null && !isObject(lighting.actors)) issues.push({ code: 'rules.invalid-lighting-actors', path: `${path}/actors`, message: 'Состояния света задаются объектом по ID участников.' });
  for (const [id, state] of Object.entries(object(lighting.actors))) {
    const actorPath = `${path}/actors/${pointer(id)}`;
    if (!isObject(state)) issues.push({ code: 'rules.invalid-lighting-actor', path: actorPath, message: 'Состояние приборов должно быть объектом.' });
    else issues.push(...validateFields(object(state), actorPath, ACTOR_BOOLS, ACTOR_NUMBERS));
    if ('hazard' in object(state) || 'dazzled' in object(state)) issues.push({ code: 'rules.duplicate-warning-source', path: actorPath,
      message: 'hazard задаётся Waypoint.signal; ослепление — Actor.warningContext.dazzled.' });
  }
  return issues;
}
export function describeLighting(project: ProjectEnvelope): FeatureDescriptor {
  const inputs: InputDescriptor[] = [
    { path: '/extensions/rules/lighting/timeOfDay', label: 'Время суток (отсутствует/null — неизвестно)', kind: 'enum', choices: TIME.map(value => ({ value, label: value })) },
    { path: '/extensions/rules/lighting/insufficientVisibility', label: 'Установлена недостаточная видимость по 1.2 (null — неизвестно)', kind: 'boolean' },
    { path: '/extensions/rules/lighting/source', label: 'Источник условий и периода наблюдения', kind: 'text' },
  ];
  for (const [index, a] of project.scene.actors.entries()) if (a.kind === 'vehicle' && !a.railwayTrain) {
    for (const key of [...ACTOR_BOOLS, ...ACTOR_NUMBERS]) inputs.push({ path: `/extensions/rules/lighting/actors/${pointer(a.id)}/${key}`,
      label: `${a.id}: ${LABEL[key]} (null — неизвестно)`, kind: key === 'oncomingDistanceM' ? 'number' : 'boolean',
      ...(key === 'oncomingDistanceM' ? { unit: 'm', minimum: 0 } : {}) });
    inputs.push({ path: `/extensions/rules/lighting/actors/${pointer(a.id)}/source`, label: `${a.id}: источник наблюдения приборов`, kind: 'text' },
      { path: `/scene/actors/${index}/warningContext/dazzled`, label: `${a.id}: факт ослепления (null — неизвестно)`, kind: 'boolean' },
      { path: `/scene/actors/${index}/warningContext/hazardAvailable`, label: `${a.id}: аварийная сигнализация исправна/имеется`, kind: 'boolean' });
    for (const key of ['towedMechanical', 'accident', 'childrenBoardingWithSign', 'otherDanger']) inputs.push({ path: `/scene/actors/${index}/warningContext/${key}`, label: `${a.id}: warningContext.${key} (null — неизвестно)`, kind: 'boolean' });
    for (const [wi] of a.path.entries()) inputs.push({ path: `/scene/actors/${index}/path/${wi}/signal`, label: `${a.id}: команда сигнала в точке ${wi + 1}`, kind: 'enum',
      choices: ['none', 'left', 'right', 'hazard'].map(value => ({ value, label: value })) });
  }
  return { id: 'rules.lighting', title: 'Световые приборы и аварийная сигнализация: раздел 19, 7.1', available: true, inputs };
}

/** Authored observations apply to the declared observation period, not inferred
 * beam optics. A 150 m encounter is never itself evidence of dazzling. */
export function checkLighting(ctx: Ctx, lighting: JsonObject, add: (finding: FindingInput) => unknown): void {
  const dark: Known = lighting.timeOfDay === 'night' ? true : lighting.timeOfDay === 'day' ? false : null;
  const day: Known = lighting.timeOfDay === 'day' ? true : lighting.timeOfDay === 'night' ? false : null;
  const poor = bool(lighting.insufficientVisibility);
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || i.a.railwayTrain || i.k0 >= ctx.tl.n) continue;
    const a = i.a, facts = object(object(lighting.actors)[a.id]);
    const f = (key: string) => bool(facts[key]);
    let moving: number | undefined;
    for (let k = i.k0; k <= i.kEnd; k++) if (i.tr.present[k] && Math.abs(i.tr.v[k]) > 0) { moving = k; break; }
    const emit = (ref: string, key: string, title: string, applicable: Known, satisfied: Known, frame = moving ?? i.k0, extra: Record<string, unknown> = {}) => {
      if (applicable === false) return;
      const source = lawRef(`pdd:${ref}`, ctx.scene.env.accidentDate);
      const state = applicable === true && source.revision ? satisfied : null;
      add({ actorId: a.id, t: tOf(frame), severity: severity(state), causal: false, title,
        detail: `${compliance(state)}. Оценка по установленным наблюдениям; неизвестные условия и приборы не считаются выключенными. Причинная связь не установлена.`,
        refs: [`pdd:${ref}`, ...(state === false ? ['rule:lighting'] : [])],
        trace: { lighting: true, lightingRequirement: key, facts, conditions: lighting, applicable, requirementResult: satisfied,
          compliance: compliance(state), source, ...extra,
          formula: 'applicable = conjunction/disjunction of established conditions; result = requirement on observed device state',
          units: { distance: 'm', time: 's' }, limits: 'Статические наблюдения за заявленный период; оптика, ослепление и причинность из расстояния не вычисляются' } });
    };
    const mechanical = VEHICLES[a.type as VehicleType]?.motorized === true;
    if (moving !== undefined) {
      const nightUse = any(dark, poor, f('inTunnel'));
      const towed = bool(a.warningContext?.towedMechanical);
      if (towed === true) emit('19.1', 'towed-position', 'Габаритные огни буксируемого механического ТС', nightUse, f('positionLamp'));
      else if (mechanical) emit('19.1', 'headlights', 'Фары при темноте, недостаточной видимости или в тоннеле', all(nightUse, not(towed)), any(f('lowBeam'), f('highBeam')));
      else if (['bicycle', 'sim'].includes(a.type)) emit('19.1', 'rider-lamp', 'Фара или фонарь велосипеда/СИМ', nightUse, f('headlamp'));
      else if (a.type === 'cart') emit('19.1', 'cart-lamp', 'Фонари повозки при их наличии', all(nightUse, f('lampsInstalled')), f('headlamp'));
      // 19.5 applies to all moving vehicles except bicycles; 19.4 permits front fog instead.
      if (a.type !== 'bicycle') emit('19.5', 'day-identification', 'Обозначение движущегося ТС днём', day,
        any(f('lowBeam'), f('drl'), f('frontFog')), moving, { permittedFrontFogRef: 'pdd:19.4' });
    }
    const encounter = f('oncomingEncounter');
    const distance = number(facts.oncomingDistanceM);
    const within150 = distance === null ? null : distance <= 150;
    const mustDip = any(all(f('inSettlement'), f('roadLit')), all(encounter, any(within150, f('oncomingRequestsDip'))), f('dazzleRisk'));
    emit('19.2', 'dip', 'Переключение дальнего света на ближний', all(mustDip, f('highBeam')), false,
      moving ?? i.k0, { oncomingDistanceM: distance, thresholdM: 150, distanceDoesNotProveDazzling: true });
    if (f('highBeam') === false && mustDip === true) emit('19.2', 'dip', 'Дальний свет при обязанности переключить', true, true);
    if (a.warningContext?.dazzled === true) {
      emit('19.2', 'dazzled-response', 'Снижение скорости, остановка и сохранение полосы при ослеплении', true,
        all(f('slowedAfterDazzle'), f('stoppedAfterDazzle'), f('laneKeptAfterDazzle')));
    }
    let observedRest: Known = false;
    for (const interval of stopIntervals(i)) {
      const classification = classifyStop(a, interval, interval.to, i.k0);
      const stopped: Known = ['stop', 'parking', 'forced'].includes(classification.kind) ? true : classification.kind === 'traffic' ? false : null;
      observedRest = any(observedRest, stopped);
      emit('19.3', 'rest-position', 'Габаритные огни при остановке и стоянке', all(stopped, any(all(dark, not(f('roadLit'))), poor)), f('positionLamp'), interval.from);
    }
    const headlights = any(f('lowBeam'), f('highBeam'));
    const fogPermitted = any(all(poor, headlights), all(dark, not(f('roadLit')), headlights), day, all(observedRest, poor, f('positionLamp')));
    emit('19.4', 'front-fog', 'Условия применения передних противотуманных фар', f('frontFog'), fogPermitted);
    emit('19.7', 'rear-fog', 'Задние противотуманные фонари только при недостаточной видимости', f('rearFog'), poor);
    if (f('rearFogLinkedToBrakes') !== null) emit('19.7', 'rear-fog-brakes', 'Запрет соединения задних ПТФ со стоп-сигналами', true, not(f('rearFogLinkedToBrakes')));
    emit('19.6', 'searchlight', 'Условия применения фары-прожектора или искателя', f('searchlight'),
      any(all(not(f('inSettlement')), not(encounter)), all(f('inSettlement'), f('searchlightAuthorized'))));
    emit('19.10', 'horn', 'Условия подачи звукового сигнала', f('hornUsed'),
      any(f('hornNecessaryToPreventAccident'), all(not(f('inSettlement')), f('overtakeWarning'))));
    emit('19.11', 'overtake-flash', 'Световое предупреждение об обгоне', f('overtakeFlash'), all(f('overtakeWarning'), f('flashBrief')));
    // Moving dazzled/towed vehicles must be covered too. The existing stopping
    // checker owns 7.1 at rest, so do not create duplicate findings there.
    if (moving !== undefined && any(a.warningContext?.dazzled, a.warningContext?.towedMechanical, a.warningContext?.childrenBoardingWithSign, a.warningContext?.otherDanger, a.warningContext?.accident) === true) {
      const seen = new Set<Known>();
      for (let k = moving; k <= i.kEnd; k++) {
        if (!i.tr.present[k] || Math.abs(i.tr.v[k]) === 0) continue;
        const state = vehicleSignalAt(a, tOf(k), i.tr.waypointTimes ?? []);
        const hazard: Known = a.warningContext?.hazardAvailable === false ? false : state.source === 'none' ? null : state.signal === 'hazard';
        if (seen.has(hazard)) continue;
        seen.add(hazard);
        emit('7.1', 'moving-hazard', 'Аварийная сигнализация при ослеплении, буксировке или опасности', true, hazard, k, { vehicleSignal: { ...state }, warningContext: { ...a.warningContext } });
      }
    }
  }
}
