import { angDiff, dist, distToSegment, segIntersect, toLocal, type Vec } from '../geom';
import { lateralFor, roadsAt } from '../geo';
import { LANE_WIDTH, type Actor } from '../scene';
import { DT, type Collision } from '../sim';
import type { Ctx, Info } from './context';
import { posAt, sampleTrace, tOf } from './technical';
import type { FindingInput, Trace } from './types';

type Add = (finding: FindingInput) => unknown;
// Bounds of the observation algorithm, not distances or times prescribed by 3.2/3.3.
const APPROACH_RANGE = 45;
const STATIONARY_SPEED = 0.1;
const EQUAL_SPEED_TOLERANCE = 0.5;
const ALONGSIDE_OBSERVATION_SECONDS = 0.5;

export function blueBeacon(a: Actor): boolean {
  return a.specialSignals?.beacon === 'blue' || a.specialSignals?.beacon === 'blue-red';
}

/** A siren is needed for priority, but not for the separate right to depart
 * from listed requirements under 3.1. No privilege is attached to vehicle type. */
export function prioritySignals(a: Actor): boolean | null {
  if (a.kind !== 'vehicle' || a.railwayTrain || !blueBeacon(a)) return false;
  return a.specialSignals?.siren ?? null;
}

export function specialPairState(a: Actor, b: Actor): 'a' | 'b' | 'both' | 'unknown' | 'none' {
  if (a.kind !== 'vehicle' || b.kind !== 'vehicle' || a.railwayTrain || b.railwayTrain) return 'none';
  const A = prioritySignals(a), B = prioritySignals(b);
  if (A === null || B === null) return 'unknown';
  return A && B ? 'both' : A ? 'a' : B ? 'b' : 'none';
}

/** null means the input does not establish the conditions of the exception. */
export function specialDeparture(a: Actor, controller = false): boolean | null {
  if (controller || a.kind !== 'vehicle' || a.railwayTrain || !blueBeacon(a)) return false;
  const facts = a.specialSignals!;
  if (facts.urgentDuty === false || facts.safetyEnsured === false) return false;
  return facts.urgentDuty === true && facts.safetyEnsured === true ? true : null;
}

export interface SpecialPriority {
  from: string;
  to: string;
  refs: string[];
  explain: string;
  trace: Trace;
}

function qualification(a: Actor): string[] {
  const signals = a.specialSignals!;
  if (signals.colorScheme === true) return ['rule:special-priority-marked'];
  if (signals.colorScheme === false) return [signals.beacon === 'blue-red'
    ? 'rule:special-priority-blue-red-unmarked' : 'rule:special-priority-blue-unmarked'];
  return [];
}

/** Call only for a geometrically established encounter or conflicting pair.
 * This represents the other's duty, not unconditional permission for the
 * special driver to enter before checking that the way has been yielded. */
export function specialPriority(ctx: Ctx, a: string, b: string, frame: number): SpecialPriority | null {
  const A = ctx.infos.get(a), B = ctx.infos.get(b);
  if (!A || !B) return null;
  const state = specialPairState(A.a, B.a);
  if (state !== 'a' && state !== 'b') return null;
  const [special, other] = state === 'a' ? [A, B] : [B, A];
  const k = Math.max(special.k0, other.k0, Math.min(frame, special.kEnd, other.kEnd));
  if (k >= ctx.tl.n || !special.tr.present[k] || !other.tr.present[k] || special.tr.v[k] <= STATIONARY_SPEED) return null;
  const code = qualification(special.a);
  return { from: other.a.id, to: special.a.id, refs: ['pdd:3.2', ...code],
    explain: `${other.label} обязан обеспечить беспрепятственный проезд приближающегося ${special.label} с синим${special.a.specialSignals!.beacon === 'blue-red' ? ' и красным' : ''} маячком и специальным звуковым сигналом. Сам ${special.label} может воспользоваться приоритетом только убедившись в уступании (п. 3.1).`,
    trace: { frame: k, priorityVehicleId: special.a.id, prioritySignals: structuredClone(special.a.specialSignals),
      qualificationUnknown: !code.length, other: sampleTrace(ctx, other, k), special: sampleTrace(ctx, special, k),
      interaction: structuredClone(other.a.specialInteractions?.find(f => f.otherId === special.a.id)),
      priorityUse: structuredClone(special.a.specialInteractions?.find(f => f.otherId === other.a.id)) } };
}

function controllerFinding(f: FindingInput): boolean {
  const light = f.trace?.light as { kind?: string } | undefined;
  return light?.kind === 'controller' || !!f.trace?.controllerId
    || f.refs.some(ref => /^pdd:6\.(?:10|11|12)$/.test(ref));
}

function exemptible(f: FindingInput): boolean {
  const refs = f.refs.filter(ref => !ref.startsWith('rule:') && !ref.startsWith('koap:'));
  return refs.length > 0 && refs.every(ref => {
    if (ref.startsWith('sign:') || ref.startsWith('marking:')) return true;
    const section = /^pdd:(\d+)\./.exec(ref)?.[1];
    return section === '6' || Number(section) >= 8 && Number(section) <= 18;
  });
}

/** One path for speed, signals, position, signs and markings, including Kit.
 * Retain the original requirement and facts when its applicability is unknown.
 * The exception never erases an observed dangerous manoeuvre or a controller. */
export function applySpecialDeparture(ctx: Ctx, original: FindingInput): FindingInput {
  const a = ctx.infos.get(original.actorId)?.a;
  if (!a || original.severity !== 'violation' || !blueBeacon(a) || a.railwayTrain) return original;
  const otherId = original.trace?.otherActorId;
  if (typeof otherId === 'string' && original.refs.includes('rule:maneuver-priority')) {
    const relation = specialPriority(ctx, a.id, otherId, Math.round((original.t ?? 0) / DT));
    if (relation?.to === a.id) return { ...original, severity: 'info', causal: false,
      title: 'обычная очерёдность манёвра заменена специальной обязанностью уступить',
      detail: `${relation.explain} Требования безопасности и проверки уступания оцениваются отдельно.`,
      refs: ['pdd:3.1', 'pdd:3.2'], trace: { ...original.trace, originalRequirement: original, specialPriority: relation.trace, compliance: 'не определить' } };
  }
  if (controllerFinding(original) || !exemptible(original)) return original;
  // A causal finding about actual dangerous movement is not a mere departure
  // from a formal order. Ensuring safety remains an express condition of 3.1.
  if (original.causal) return original;
  const allowed = specialDeparture(a);
  if (allowed === false) return original;
  const refs = original.refs.filter(ref => !ref.startsWith('rule:') && !ref.startsWith('koap:'));
  const facts = a.specialSignals!;
  const unknown = [facts.urgentDuty === undefined ? 'неотложное служебное задание' : '',
    facts.safetyEnsured === undefined ? 'обеспечение безопасности' : ''].filter(Boolean);
  return { ...original, severity: allowed ? 'info' : 'contributing', causal: false,
    title: allowed ? 'отступление при выполнении неотложного задания' : 'условия допустимости отступления не установлены',
    detail: allowed ? `${original.detail} Заданы синий маячок, неотложное задание и обеспечение безопасности: п. 3.1 допускает отступление от указанного требования. Это само по себе не даёт приоритета.`
      : `${original.detail} Не установлены: ${unknown.join(', ')}. По одному маячку нельзя подтвердить ни разрешённое отступление, ни административный состав за исходное требование.`,
    refs: [...refs, 'pdd:3.1'], trace: { ...original.trace, originalRequirement: structuredClone(original),
      specialDeparture: allowed, specialSignals: structuredClone(facts), unknown, compliance: allowed ? 'выполнено' : 'не определить' } };
}

const routePoints = (i: Info): Vec[] => [{ x: i.a.x, y: i.a.y }, ...i.a.path];
function routeConflict(a: Info, b: Info): boolean {
  const A = routePoints(a), B = routePoints(b);
  for (let x = 1; x < A.length; x++) for (let y = 1; y < B.length; y++) {
    if (segIntersect(A[x - 1], A[x], B[y - 1], B[y])) return true;
    // Overlapping corridors also cover merge/catch-up paths and a stopped car.
    const width = a.hw + b.hw;
    if (distToSegment(A[x - 1], B[y - 1], B[y]) < width || distToSegment(A[x], B[y - 1], B[y]) < width
      || distToSegment(B[y - 1], A[x - 1], A[x]) < width || distToSegment(B[y], A[x - 1], A[x]) < width) return true;
  }
  return false;
}

function contactBetween(ctx: Ctx, a: Info, b: Info): Collision | undefined {
  return ctx.tl.collisions.find(c => c.a === a.a.id && c.b === b.a.id || c.a === b.a.id && c.b === a.a.id);
}

/** Establish approach from common-time motion, rather than a global flag. */
function encounter(ctx: Ctx, special: Info, other: Info): number | null {
  const contact = contactBetween(ctx, special, other);
  if (contact) {
    const k = Math.max(special.k0, other.k0, contact.frame - 1);
    return special.tr.v[k] > STATIONARY_SPEED ? k : null;
  }
  if (!routeConflict(special, other)) return null;
  let previousDistance = Infinity;
  const graphFrames = ctx.priorityGraphs.filter(g => g.participants.some(p => p.actorId === special.a.id)
    && g.participants.some(p => p.actorId === other.a.id)).map(g => g.frame);
  // Yielding changes the arrival time and may remove the pair from a common
  // junction snapshot. Preserve the supplied pair fact only with an observed
  // closing approach and conflicting routes, never from a global checkbox.
  const yielded = other.a.specialInteractions?.find(f => f.otherId === special.a.id)?.yielded === true;
  for (let k = Math.max(special.k0, other.k0); k <= Math.min(special.kEnd, other.kEnd); k += 4) {
    if (!special.tr.present[k] || !other.tr.present[k]) continue;
    const distance = dist(posAt(special, k), posAt(other, k));
    const closing = distance < previousDistance - 0.01;
    previousDistance = distance;
    if (!closing || distance > APPROACH_RANGE || special.tr.v[k] <= STATIONARY_SPEED) continue;
    const sameHeading = Math.abs(angDiff(special.tr.h[k], other.tr.h[k])) < 0.5;
    const local = toLocal(posAt(special, k), { cx: other.tr.x[k], cy: other.tr.y[k], a: other.tr.h[k] });
    const sameLaneBehind = sameHeading && local.x < 0 && Math.abs(local.y) < special.hw + other.hw;
    const junctionEncounter = graphFrames.some(frame => Math.abs(frame - k) * DT <= 3);
    if (sameLaneBehind || junctionEncounter || yielded) return k;
  }
  return null;
}

function checkEncounter(ctx: Ctx, special: Info, other: Info, frame: number, add: Add): void {
  const relation = specialPriority(ctx, special.a.id, other.a.id, frame);
  if (!relation) return;
  const interaction = other.a.specialInteractions?.find(f => f.otherId === special.a.id);
  const use = special.a.specialInteractions?.find(f => f.otherId === other.a.id);
  const contact = contactBetween(ctx, special, other);
  const contactFrame = contact ? Math.max(other.k0, special.k0, contact.frame - 1) : frame;
  // A rear impact does not prove that the leading driver had room to clear a
  // lane. A moving cross-course entry provides a separate observed conflict.
  const observedFailure = !!contact && Math.abs(Math.sin(other.tr.h[contactFrame] - special.tr.h[contactFrame])) > 0.5
    && other.tr.v[contactFrame] > STATIONARY_SPEED;
  const contradictedYield = interaction?.yielded === true && observedFailure;
  const notYielded = interaction?.yielded === false || observedFailure;
  const visible = interaction?.beaconVisible;
  add({ actorId: other.a.id, severity: visible === false || contradictedYield ? 'contributing' : notYielded ? 'violation' : interaction?.yielded === true ? 'info' : 'contributing',
    t: contact?.t ?? tOf(frame), causal: !!contact && notYielded && visible !== false && !contradictedYield,
    title: visible === false ? 'восприятие приближающегося спецтранспорта не установлено'
      : contradictedYield ? 'заданный факт уступания противоречит наблюдаемому контакту'
        : notYielded ? 'не обеспечен беспрепятственный проезд спецтранспорта' : interaction?.yielded === true ? 'спецтранспорту уступлена дорога' : 'выполнение обязанности уступить спецтранспорту не установлено',
    detail: `${relation.explain}${visible === false ? ' Задано отсутствие видимости маячка; слышимость и момент обнаружения не моделируются, нарушение не назначается.' : ''}${contradictedYield ? ' Факт уступания нужно согласовать с движением в момент контакта.' : ''}`,
    refs: ['pdd:3.2', ...(!contradictedYield && visible !== false && notYielded ? qualification(special.a) : [])],
    trace: { ...relation.trace, observationRangeMeters: APPROACH_RANGE, observedFailure, contradictedYield,
      compliance: !notYielded && interaction?.yielded === true ? 'выполнено' : 'не определить' } });
  const attemptedUse = special.tr.v[frame] > STATIONARY_SPEED && (contact || interaction?.yielded === false || use?.yieldingVerified !== undefined);
  if (!attemptedUse) return;
  const safety = special.a.specialSignals?.safetyEnsured;
  const unsafe = use?.yieldingVerified === false || safety === false;
  const unknown = use?.yieldingVerified === undefined || safety === undefined || !!contact && safety === true;
  add({ actorId: special.a.id, severity: unsafe ? 'violation' : unknown ? 'contributing' : 'info', t: contact?.t ?? tOf(frame), causal: !!contact && unsafe,
    title: unsafe ? 'специальный приоритет использован без установленных условий безопасности'
      : unknown ? 'проверка уступания и безопасность использования приоритета не подтверждены' : 'уступание проверено перед использованием приоритета',
    detail: unsafe ? 'Пункт 3.1 разрешает воспользоваться приоритетом только убедившись, что дорогу уступают. Явно задано отсутствие такой проверки или обеспечения безопасности. Обязанность другого водителя по п. 3.2 сохраняется.'
      : unknown ? 'Проверка уступания относится к конкретному другому участнику. Неизвестный факт или контакт при заявленной безопасности требует уточнения; субъективная проверка не выводится из одной траектории.'
        : 'Для этой пары заданы проверка уступания и обеспечение безопасности; наблюдаемого контакта нет.',
    refs: ['pdd:3.1'], trace: { ...relation.trace, yieldingVerified: use?.yieldingVerified, safetyEnsured: safety,
      contactObserved: !!contact, compliance: !unsafe && !unknown ? 'выполнено' : 'не определить' } });
}

function stationaryBeacon(ctx: Ctx, special: Info, other: Info, add: Add): void {
  const facts = other.a.specialInteractions?.find(f => f.otherId === special.a.id);
  let previousDistance = Infinity;
  for (let k = Math.max(special.k0, other.k0); k <= Math.min(special.kEnd, other.kEnd); k += 4) {
    if (!special.tr.present[k] || !other.tr.present[k]) continue;
    const distance = dist(posAt(special, k), posAt(other, k));
    const closing = distance < previousDistance - 0.01;
    previousDistance = distance;
    if (!closing || distance > APPROACH_RANGE || special.tr.v[k] > STATIONARY_SPEED || other.tr.v[k] <= STATIONARY_SPEED) continue;
    const known = facts?.beaconVisible === true && facts.immediateStopPossible !== undefined;
    add({ actorId: other.a.id, severity: known ? facts?.immediateStopPossible ? 'info' : 'violation' : 'contributing', t: tOf(k),
      title: known && facts?.immediateStopPossible ? 'готовность остановиться у стоящего спецтранспорта установлена'
        : known ? 'не обеспечена возможность немедленно остановиться у стоящего спецтранспорта' : 'данных для проверки снижения скорости у стоящего спецтранспорта недостаточно',
      detail: 'По п. 3.3 при приближении к стоящему ТС с синим или сине-красным маячком нужно снизить скорость для возможности немедленной остановки. Численный предел скорости пунктом не установлен; состояние освещения и видимость не выводятся из расстояния.',
      refs: ['pdd:3.3'], trace: { ...sampleTrace(ctx, other, k), stationaryVehicleId: special.a.id,
        interaction: structuredClone(facts), observationRangeMeters: APPROACH_RANGE, compliance: known && facts?.immediateStopPossible ? 'выполнено' : 'не определить' } });
    return;
  }
}

function commonRoad(ctx: Ctx, a: Info, b: Info, frame: number) {
  const A = roadsAt(ctx.geo, posAt(a, frame));
  const B = roadsAt(ctx.geo, posAt(b, frame));
  for (const first of A) {
    const second = B.find(hit => hit.rg.road.id === first.rg.road.id);
    if (second) return { first, second };
  }
  return null;
}

/** A geometric pass is an overtake only if opposing-lane travel is observed.
 * No fixed lateral distance cuts off lawful-width multilane carriageways; the
 * pair must occupy the same explicitly modelled road instead. */
function specialPassing(ctx: Ctx, add: Add): void {
  const list = [...ctx.infos.values()].filter(i => i.isVeh && !i.a.railwayTrain);
  for (const special of list) {
    if (prioritySignals(special.a) !== true) continue;
    for (const other of list) {
      // Section 3 is not among the exceptions listed in 3.1: another special
      // vehicle is also subject to this independent passing prohibition.
      if (other === special) continue;
      let behind = -1, passed = -1, firstOpposing = -1, lastObserved = -1;
      let initialLongitudinal = 0, maximumLongitudinal = -Infinity;
      const opposingFrames = new Set(ctx.onc.get(other.a.id)?.frames ?? []);
      const end = Math.min(special.kEnd, other.kEnd);
      for (let k = Math.max(special.k0, other.k0); k <= end; k++) {
        if (!special.tr.present[k] || !other.tr.present[k] || special.tr.reversing?.[k] || other.tr.reversing?.[k]
          || Math.abs(angDiff(special.tr.h[k], other.tr.h[k])) > 0.6 || !commonRoad(ctx, special, other, k)) continue;
        const p = toLocal(posAt(other, k), { cx: special.tr.x[k], cy: special.tr.y[k], a: special.tr.h[k] });
        if (behind < 0 && p.x < -special.hl - other.hl && p.x > -100 && special.tr.v[k] > STATIONARY_SPEED) {
          behind = k;
          initialLongitudinal = p.x;
        }
        if (behind < 0) continue;
        lastObserved = k;
        maximumLongitudinal = Math.max(maximumLongitudinal, p.x);
        if (firstOpposing < 0 && opposingFrames.has(k)) firstOpposing = k;
        if (p.x > special.hl + other.hl && other.tr.v[k] > special.tr.v[k]) { passed = k; break; }
      }
      if (behind < 0 || lastObserved < 0) continue;
      const opposing = firstOpposing >= 0;
      const completed = passed >= 0;
      if (!completed) {
        // A turn away from the leader is not an attempted overtake. For an
        // unfinished pass require actual opposing travel, a planned return to
        // the same road/heading, and observed longitudinal gain on the leader.
        const last = other.a.path.at(-1), previous = other.a.path.at(-2) ?? other.a;
        const road = commonRoad(ctx, special, other, firstOpposing >= 0 ? firstOpposing : behind)?.first.rg.road;
        const returnHit = last && road && roadsAt(ctx.geo, last).find(hit => hit.rg.road.id === road.id);
        const plannedReturn = last && returnHit && !road.oneWay
          && Math.abs(angDiff(special.tr.h[behind], Math.atan2(last.y - previous.y, last.x - previous.x))) < 0.35
          && lateralFor(returnHit.near, special.tr.h[behind]).lat >= other.hw;
        if (!opposing || !plannedReturn || maximumLongitudinal - initialLongitudinal < 1) continue;
      }
      const red = special.a.specialSignals!.beacon === 'blue-red';
      const marked = special.a.specialSignals!.colorScheme;
      const start = opposing ? firstOpposing : behind;
      const visible = other.a.specialInteractions?.find(f => f.otherId === special.a.id)?.beaconVisible;
      const trace = { startFrame: start, passFrame: completed ? passed : null, completedPass: completed,
        observedEndFrame: lastObserved, opposingLaneObserved: opposing, priorityVehicleId: special.a.id,
        prioritySignals: structuredClone(special.a.specialSignals), beaconVisible: visible,
        standaloneQualification: 'TODO(legal-check): самостоятельный запрет обгона/опережения не приравнивается к непредоставлению преимущества' };
      if (red || opposing && marked === true) add({ actorId: other.a.id, severity: visible === false ? 'contributing' : 'violation', t: tOf(start),
          title: opposing ? 'обгон спецтранспорта при включённых специальных сигналах' : 'опережение спецтранспорта с сине-красными маячками',
          detail: red ? 'Пункт 3.2 запрещает обгон и опережение ТС с сине-красными маячками и специальным звуковым сигналом.'
            : 'Пункт 3.2 запрещает обгон ТС со специальными цветографическими схемами, синим маячком и специальным звуковым сигналом. Наблюдается использование встречной полосы.',
          refs: ['pdd:3.2'], trace: { ...trace, ...(visible === false ? { compliance: 'не определить' } : {}) } });
      else if (opposing && marked === undefined) add({ actorId: other.a.id, severity: 'contributing', t: tOf(start),
          title: 'цветографические схемы для проверки запрета обгона не установлены', detail: 'Для отдельного запрета обгона ТС с синим маячком и звуком п. 3.2 требует специальные цветографические схемы.',
          refs: ['pdd:3.2'], trace: { ...trace, compliance: 'не определить' } });
    }
  }
}

function organizedMovement(ctx: Ctx, special: Info, other: Info, add: Add): void {
  if (special.a.specialSignals?.beacon !== 'blue-red' || prioritySignals(special.a) !== true) return;
  const facts = other.a.specialInteractions?.find(f => f.otherId === special.a.id);
  if (!facts || facts.organizedMovementObstructed === undefined) return;
  let first = -1, run = 0;
  for (let k = Math.max(special.k0, other.k0); k <= Math.min(special.kEnd, other.kEnd); k++) {
    const road = commonRoad(ctx, special, other, k);
    const local = toLocal(posAt(other, k), { cx: special.tr.x[k], cy: special.tr.y[k], a: special.tr.h[k] });
    const adjacent = road && Math.abs(Math.floor(road.first.near.d / LANE_WIDTH) - Math.floor(road.second.near.d / LANE_WIDTH)) === 1;
    if (special.tr.present[k] && other.tr.present[k] && special.tr.v[k] > STATIONARY_SPEED
      && Math.abs(angDiff(special.tr.h[k], other.tr.h[k])) < 0.35 && adjacent
      && Math.abs(local.x) <= special.hl + other.hl && Math.abs(special.tr.v[k] - other.tr.v[k]) <= EQUAL_SPEED_TOLERANCE) {
      if (!run) first = k;
      run++;
    } else { run = 0; first = -1; }
    if (run * DT < ALONGSIDE_OBSERVATION_SECONDS) continue;
    const uncertain = facts.beaconVisible === false;
    add({ actorId: other.a.id, severity: uncertain ? 'contributing' : facts.organizedMovementObstructed ? 'violation' : 'info', t: tOf(first),
      title: facts.organizedMovementObstructed ? 'движение рядом препятствует организованному проезду спецтранспорта' : 'помеха организованному движению рядом не установлена',
      detail: 'Наблюдается движение по соседнему ряду с той же скоростью рядом с ТС с сине-красными маячками и специальным звуковым сигналом. Запрет п. 3.2 требует также установленной помехи организованному движению; она не выводится из одного параллельного движения.',
      refs: ['pdd:3.2'], trace: { ...sampleTrace(ctx, other, first), priorityVehicleId: special.a.id,
        interaction: structuredClone(facts), equalSpeedToleranceMs: EQUAL_SPEED_TOLERANCE,
        observationSeconds: ALONGSIDE_OBSERVATION_SECONDS, standaloneQualification: 'TODO(legal-check): самостоятельный запрет движения рядом не приравнивается к непредоставлению преимущества',
        compliance: !uncertain && facts.organizedMovementObstructed === false ? 'выполнено' : 'не определить' } });
    return;
  }
}

export function checkSpecialSignals(ctx: Ctx, add: Add): void {
  const list = [...ctx.infos.values()].filter(i => i.isVeh && !i.a.railwayTrain && i.k0 < ctx.tl.n);
  for (const special of list) {
    const signals = special.a.specialSignals;
    if (!signals) continue;
    if (signals.warningReason) {
      const on = signals.beacon === 'yellow' || signals.beacon === 'orange';
      const unknown = signals.beacon === 'unknown';
      add({ actorId: special.a.id, severity: unknown ? 'contributing' : on ? 'info' : 'violation', t: tOf(special.k0),
        title: unknown ? 'включение обязательного предупреждающего маячка не установлено'
          : on ? 'предупреждающий маячок при установленном основании включён' : 'при установленном основании не включён жёлтый или оранжевый маячок',
        detail: 'Для указанного в исходных данных случая п. 3.4 требует включённый жёлтый или оранжевый маячок. Основание не выводится только из типа ТС или общего флага опасного груза.',
        refs: ['pdd:3.4'], trace: { specialSignals: structuredClone(signals), warningReason: signals.warningReason,
          standaloneQualification: 'TODO(legal-check): отдельная административная квалификация отсутствующего предупреждающего маячка требует проверки',
          compliance: on ? 'выполнено' : 'не определить' } });
    }
    if (signals.beacon === 'yellow' || signals.beacon === 'orange' || signals.beacon === 'white') add({ actorId: special.a.id, severity: 'info', t: tOf(special.k0),
      title: 'предупреждающий маячок не даёт преимущества', detail: signals.beacon === 'white'
        ? 'Бело-лунный маячок служит для привлечения внимания и не даёт преимущества в движении (п. 3.6).'
        : 'Жёлтый или оранжевый маячок предупреждает об опасности и не даёт преимущества (п. 3.4). Основания специальных отступлений при дорожных работах по п. 3.5 отдельно не установлены.',
      refs: [signals.beacon === 'white' ? 'pdd:3.6' : 'pdd:3.4'], trace: { specialSignals: structuredClone(signals), compliance: 'выполнено' } });
    if (!blueBeacon(special.a)) continue;
    for (const other of list) {
      if (other === special) continue;
      organizedMovement(ctx, special, other, add);
      stationaryBeacon(ctx, special, other, add);
      const state = specialPairState(special.a, other.a);
      const frame = encounter(ctx, special, other);
      if (frame === null) continue;
      if (state === 'both' || state === 'unknown') {
        add({ actorId: other.a.id, severity: 'contributing', t: tOf(frame), title: state === 'both' ? 'очерёдность двух ТС со специальными сигналами не установлена' : 'включение специального звукового сигнала не установлено',
          detail: state === 'both' ? 'Наличие специальных сигналов у обоих участников само по себе не устанавливает преимущество одного перед другим.' : 'Один синий маячок не создаёт преимущество по п. 3.2; неизвестный звуковой сигнал не считается включённым или выключенным.',
          refs: ['pdd:3.1', 'pdd:3.2'], trace: { otherActorId: special.a.id, compliance: 'не определить' } });
      } else if (state === 'a') checkEncounter(ctx, special, other, frame, add);
    }
  }
  specialPassing(ctx, add);
}
