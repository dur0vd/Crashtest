import { classifyIntersectionMovement, intersectionAt, inIntersectionBoundary, lateralFor, roadsAt, type RoadHit } from '../geo';
import { angDiff, angleOf, dist, dot, fromAngle, pointInObb, obbCorners, toLocal, nearestOnPolyline } from '../geom';
import { type Movement, type Road, LANE_WIDTH, dimsOf } from '../scene';
import { DT, type Collision } from '../sim';
import { SIGNAL_CANCEL_SECONDS, SIGNAL_LEAD_METERS, SIGNAL_LEAD_SECONDS, vehicleSignalAt } from '../maneuver-signals';
import type { Ctx, Info } from './context';
import { boxAt, posAt, tOf } from './technical';
import type { FindingInput, Trace } from './types';

/** Observation tolerances, not statutory dimensions or times. */
const TURN_START_ANGLE = 0.12;
const TURN_ANGLE = 0.55;
const UTURN_ANGLE = 2.3;
const LANE_CHANGE_METERS = 0.8;
const STABLE_SECONDS = 0.4;

type Add = (finding: FindingInput) => unknown;
export interface ObservedManeuver {
  kind: Exclude<Movement, 'straight'> | 'lane-change' | 'start' | 'stop';
  direction: 'left' | 'right' | null;
  frame: number;
  endFrame: number;
  heading: number;
  roadId?: string;
  intersectionId?: string;
  trace: Trace;
}
interface Passage { A: Info; B: Info; start: number; pass: number; end: number; opposing: boolean; returned: boolean; completed: boolean }
export interface ManeuverPriority { from: string; to: string; refs: string[]; explain: string; trace: Trace }

const clampFrame = (ctx: Ctx, k: number) => Math.max(0, Math.min(ctx.tl.n - 1, k));
const reverseAt = (i: Info, k: number) => !!i.tr.reversing?.[k];
const hasContact = (ctx: Ctx, a: string, b?: string, first = 0, last = ctx.tl.n - 1) => ctx.tl.collisions.some(c => c.frame >= first && c.frame <= last && (b
  ? c.a === a && c.b === b || c.b === a && c.a === b : c.a === a || c.b === a));
const feature = (road: Road | undefined, key: NonNullable<Road['features']>[number]) => !!road?.features?.includes(key);
const atRoad = (ctx: Ctx, i: Info, k: number): RoadHit | undefined => roadsAt(ctx.geo, posAt(i, clampFrame(ctx, k)), 0.25)[0];
const localLat = (i: Info, k: number, hit: RoadHit) => lateralFor(hit.near, i.tr.h[k]).lat;
const direction = (angle: number): 'left' | 'right' => angle < 0 ? 'left' : 'right';

function observedTurn(ctx: Ctx, i: Info, start: number, end: number, heading: number, roadId?: string, intersectionId?: string): ObservedManeuver | null {
  const delta = angDiff(heading, i.tr.h[end]);
  const startHit = atRoad(ctx, i, start), endHit = atRoad(ctx, i, end);
  // A parallel acceleration lane may be authored as its own road strip. Its
  // local centre line differs, so measure the observed displacement in the
  // incoming vehicle frame rather than subtracting two unrelated road offsets.
  const parallelTransition = startHit && endHit
    && Math.abs(Math.sin(angDiff(angleOf(startHit.near.tangent), angleOf(endHit.near.tangent)))) < Math.sin(0.2);
  const latChange = startHit && endHit && startHit.rg.road.id === endHit.rg.road.id
    ? localLat(i, end, endHit) - localLat(i, start, startHit)
    : parallelTransition ? toLocal(posAt(i, end), { cx: i.tr.x[start], cy: i.tr.y[start], a: heading }).y : 0;
  const kind = Math.abs(delta) > UTURN_ANGLE ? 'uturn' : Math.abs(delta) > TURN_ANGLE ? delta < 0 ? 'left' : 'right'
    : Math.abs(latChange) >= LANE_CHANGE_METERS ? 'lane-change' : null;
  if (!kind) return null;
  return { kind, direction: kind === 'lane-change' ? direction(latChange) : direction(delta), frame: start, endFrame: end,
    heading, roadId, intersectionId, trace: { delta, lateralChange: latChange, turnStartAngle: TURN_START_ANGLE,
      turnAngle: TURN_ANGLE, uturnAngle: UTURN_ANGLE, laneChangeMeters: LANE_CHANGE_METERS } };
}

/** Uses observed steering and lane displacement; road curvature itself is not a turn instruction. */
export function observedManeuvers(ctx: Ctx, i: Info): ObservedManeuver[] {
  if (i.k0 >= ctx.tl.n) return [];
  const events: ObservedManeuver[] = [];
  for (const junction of ctx.geo.intersections) {
    const movement = classifyIntersectionMovement(ctx.geo, i.a, junction);
    if (movement.maneuver === 'unknown' || movement.maneuver === 'straight') continue;
    const radius = Math.max(...junction.boundary.map(p => dist(p, junction.center))) + 12;
    let first = -1, last = -1;
    for (let k = i.k0; k <= i.kEnd; k++) if (i.tr.present[k] && !reverseAt(i, k) && dist(posAt(i, k), junction.center) < radius) {
      if (first < 0) first = k;
      last = k;
    }
    if (first < 0) continue;
    let onset = first;
    while (onset <= last && Math.abs(angDiff(movement.entryHeading, i.tr.h[onset])) < TURN_START_ANGLE) onset++;
    if (onset > last) continue;
    let finish = onset;
    while (finish < last && Math.abs(angDiff(movement.exitHeading, i.tr.h[finish])) > TURN_START_ANGLE) finish++;
    events.push({ kind: movement.maneuver, direction: movement.maneuver === 'right' ? 'right' : 'left', frame: onset,
      endFrame: finish, heading: movement.entryHeading, roadId: movement.entryRoadId, intersectionId: junction.id,
      trace: { movement, boundarySource: junction.boundarySource, turnStartAngle: TURN_START_ANGLE } });
  }
  // Detect a deviation from the local road course, then follow that deviation until
  // the course settles. This also observes a lane change whose final heading is unchanged.
  const stableFrames = Math.max(1, Math.round(STABLE_SECONDS / DT));
  let k = i.k0 + 1;
  while (k <= i.kEnd) {
    if (!i.tr.present[k] || reverseAt(i, k) || i.tr.v[k] < 0.3 || events.some(e => k >= e.frame - stableFrames && k <= e.endFrame + stableFrames)) { k++; continue; }
    const hit = atRoad(ctx, i, k);
    if (!hit) { k++; continue; }
    const bearing = angleOf(hit.near.tangent);
    const roadHeading = dot(fromAngle(i.tr.h[k]), hit.near.tangent) >= 0 ? bearing : bearing + Math.PI;
    if (Math.abs(angDiff(roadHeading, i.tr.h[k])) < TURN_START_ANGLE) { k++; continue; }
    const start = Math.max(i.k0, k - stableFrames);
    const initialHit = atRoad(ctx, i, start);
    const initialHeading = initialHit ? angleOf(initialHit.near.tangent) + (dot(fromAngle(i.tr.h[start]), initialHit.near.tangent) < 0 ? Math.PI : 0) : i.tr.h[start];
    let end = k;
    let stable = 0;
    for (; end < i.kEnd; end++) {
      if (reverseAt(i, end + 1)) break;
      const currentHit = atRoad(ctx, i, end);
      const aligned = !currentHit || Math.abs(Math.sin(angDiff(angleOf(currentHit.near.tangent), i.tr.h[end]))) < Math.sin(TURN_START_ANGLE);
      stable = aligned && Math.abs(angDiff(i.tr.h[end], i.tr.h[end + 1])) < 0.003 ? stable + 1 : 0;
      if (stable >= stableFrames) break;
    }
    let event = observedTurn(ctx, i, start, end, initialHeading, initialHit?.rg.road.id);
    const target = i.a.path.at(-1), penultimate = i.a.path.at(-2) ?? i.a;
    const targetHit = target && initialHit ? roadsAt(ctx.geo, target).find(r => r.rg.road.id === initialHit.rg.road.id) : undefined;
    if (event && target && targetHit && initialHit && Math.abs(angDiff(initialHeading, angleOf({ x: target.x - penultimate.x, y: target.y - penultimate.y }))) < 0.35) {
      const targetLat = lateralFor(targetHit.near, initialHeading).lat;
      const initialLat = lateralFor(initialHit.near, initialHeading).lat;
      if (Math.abs(targetLat - initialLat) >= LANE_CHANGE_METERS) event = { ...event, kind: 'lane-change', direction: direction(targetLat - initialLat),
        trace: { ...event.trace, intendedLateralChange: targetLat - initialLat, classification: 'planned-return-to-road-course' } };
    }
    if (event && !events.some(e => Math.abs(e.frame - event.frame) < 2 / DT)) events.push(event);
    k = Math.max(k + 1, end + 1);
  }
  if (i.tr.v[i.k0] < 0.3 && Math.abs(i.a.speed) < 0.3) {
    let start = i.k0;
    while (start <= i.kEnd && i.tr.v[start] <= 0.5) start++;
    if (start <= i.kEnd) events.push({ kind: 'start', direction: null, frame: start, endFrame: start,
      heading: i.tr.h[start], roadId: atRoad(ctx, i, start)?.rg.road.id, trace: { speedThresholdMs: 0.5 } });
  }
  for (let stop = i.k0 + 1; stop <= i.kEnd; stop++) {
    if (i.tr.v[stop - 1] > 0.3 && i.tr.v[stop] <= 0.3 && !i.tr.free[stop]) {
      events.push({ kind: 'stop', direction: null, frame: stop, endFrame: stop, heading: i.tr.h[stop],
        roadId: atRoad(ctx, i, stop)?.rg.road.id, trace: { speedThresholdMs: 0.3 } });
    }
  }
  return events.sort((a, b) => a.frame - b.frame);
}

function signalChecks(ctx: Ctx, i: Info, events: ObservedManeuver[], add: Add): void {
  const context = i.a.maneuverContext;
  for (const event of events) {
    const t = tOf(event.frame);
    const leadSeconds = ctx.scene.env.signalLeadSeconds ?? SIGNAL_LEAD_SECONDS;
    const leadMeters = ctx.scene.env.signalLeadMeters ?? SIGNAL_LEAD_METERS;
    const signal = vehicleSignalAt(i.a, Math.max(0, t - DT / 2), i.tr.waypointTimes);
    const handRequired = context?.indicatorsUnavailable === true || i.a.type === 'bicycle' && context?.indicatorsUnavailable !== false;
    const hand = context?.handSignal;
    const handKnown = handRequired && hand !== undefined;
    const handMatches = handKnown && (event.kind === 'stop' ? hand === 'stop' : event.direction ? hand === event.direction : hand === 'left' || hand === 'right');
    const lightMatches = event.direction ? signal.signal === event.direction : signal.signal === 'left' || signal.signal === 'right';
    // Brake lamps are outside this indicator model; a normal service stop is not
    // proof that its legally prescribed braking signal was absent.
    if (event.kind === 'stop' && !handRequired) {
      add({ actorId: i.a.id, severity: 'info', t, title: 'сигнал торможения отдельно не установлен',
        detail: 'Наблюдалась остановка; отсутствие данных о стоп-сигналах не доказывает нарушение п. 8.1.', refs: ['pdd:8.1'], trace: { maneuver: event, compliance: 'не определить' } });
      continue;
    }
    if (handRequired && !handKnown) {
      add({ actorId: i.a.id, severity: 'contributing', t, title: 'нет данных о сигнале рукой перед манёвром',
        detail: 'При отсутствующих или неисправных указателях допустим сигнал рукой; его отсутствие по этим данным не установлено.',
        refs: ['pdd:8.1', 'pdd:8.2'], trace: { maneuver: event, indicatorsUnavailable: context?.indicatorsUnavailable, handSignal: null } });
      continue;
    }
    const matches = handRequired ? handMatches : lightMatches;
    if (!matches) {
      const other = ctx.tl.collisions.flatMap(c => c.a === i.a.id ? [c.b] : c.b === i.a.id ? [c.a] : [])
        .map(id => ctx.infos.get(id)).find(o => o?.a.maneuverContext?.expectedStraight);
      add({ actorId: i.a.id, severity: 'violation', t, title: 'не подан соответствующий сигнал перед манёвром',
        detail: 'Перед наблюдаемым манёвром соответствующий сигнал не установлен.' + (other ? ' Другой участник указал, что исходил из движения прямо; это может иметь значение для причинной связи, но не создаёт ему преимущество.' : ''),
        refs: ['pdd:8.1', 'pdd:8.2', 'rule:indicator'],
        trace: { maneuver: event, signal, handSignal: hand, handRequired, lightIndicatorsAssumed: context?.indicatorsUnavailable === undefined && !handRequired,
          otherExpectedStraight: other?.a.id, causalUncertainty: other ? 'Отдельная контрфактическая оценка восприятия сигнала не выполнена' : null } });
    } else if (handRequired) {
      add({ actorId: i.a.id, severity: 'info', t, title: 'соответствующий сигнал рукой задан', detail: 'Сигнал рукой соответствует манёвру; его заблаговременность и прекращение из статического флага не устанавливаются.', refs: ['pdd:8.1', 'pdd:8.2'], trace: { maneuver: event, handSignal: hand, compliance: 'выполнено' } });
    } else {
      const lead = signal.since === null ? null : t - signal.since;
      const signalFrame = clampFrame(ctx, Math.round((signal.since ?? t) / DT));
      const distance = i.trav[event.frame] - i.trav[signalFrame];
      const withinModel = lead !== null && lead >= leadSeconds || distance >= leadMeters;
      add({ actorId: i.a.id, severity: withinModel ? 'info' : 'contributing', t,
        title: withinModel ? 'сигнал подан до манёвра' : 'сигнал подан позднее ориентира модели',
        detail: withinModel ? 'Наблюдаемый сигнал соответствует манёвру. Он не даёт преимущества.'
          : 'Заблаговременность меньше выбранного ориентира модели; ПДД не задают количества секунд или метров, поэтому это само по себе не доказывает состав нарушения.',
        refs: ['pdd:8.1', 'pdd:8.2'], trace: { maneuver: event, signal, leadSeconds: lead, distanceMeters: distance,
          leadSecondsParameter: leadSeconds, leadMetersParameter: leadMeters, compliance: withinModel ? 'выполнено' : 'не определить' } });
    }
    // TODO(legal-check): самостоятельный состав за невыключенный сигнал и
    // опоздание только относительно численного ориентира модели не установлен.
    if (!handRequired && event.direction && event.endFrame < i.kEnd - SIGNAL_CANCEL_SECONDS / DT) {
      const after = event.endFrame + Math.ceil(SIGNAL_CANCEL_SECONDS / DT);
      const next = events.find(e => e.frame > event.frame && e.frame <= after + SIGNAL_LEAD_SECONDS / DT && e.direction === event.direction);
      const then = vehicleSignalAt(i.a, tOf(after), i.tr.waypointTimes);
      if (!next && then.signal === event.direction) add({ actorId: i.a.id, severity: 'violation', t: tOf(after),
        title: 'сигнал продолжает действовать после завершения манёвра',
        detail: 'После завершённого манёвра продолжает подаваться прежний сигнал. Численный интервал наблюдения — параметр модели, а не разрешённая ПДД задержка.',
        refs: ['pdd:8.2'], trace: { maneuver: event, signal: then, observationDelaySeconds: SIGNAL_CANCEL_SECONDS } });
    }
  }
}

function forbiddenPlace(ctx: Ctx, i: Info, frame: number): { refs: string[]; road?: Road; reasons: string[] } {
  const hit = atRoad(ctx, i, frame);
  const road = hit?.rg.road;
  const reasons = (['bridge', 'tunnel', 'railway-crossing', 'stop-area'] as const).filter(f => feature(road, f));
  if (feature(road, 'limited-visibility') || road?.visibility !== undefined && road.visibility < 100) reasons.push('limited-visibility' as never);
  const crossing = ctx.geo.crosswalks.some(c => pointInObb(c.item, boxAt(i, frame)) || obbCorners(boxAt(i, frame)).some(p => pointInObb(p, c.box)));
  return { refs: crossing ? ['pdd:8.11', 'pdd:14.1'] : ['pdd:8.11'], road,
    reasons: [...reasons, ...(crossing ? ['pedestrian-crossing'] : [])] };
}

function positionChecks(ctx: Ctx, i: Info, events: ObservedManeuver[], add: Add): void {
  for (const event of events.filter(e => ['left', 'right', 'uturn'].includes(e.kind))) {
    const before = Math.max(i.k0, event.frame - Math.ceil(0.5 / DT));
    const hit = atRoad(ctx, i, before);
    if (!hit) continue;
    const road = hit.rg.road;
    const width = road.lanes * LANE_WIDTH;
    const lat = localLat(i, before, hit) + (road.oneWay ? width / 2 : 0);
    const roundaboutEntry = !!event.intersectionId && !!ctx.geo.intersections.find(j => j.id === event.intersectionId)?.roundabout && road.role !== 'roundabout';
    const right = event.direction === 'right';
    const inExtremeLane = right ? lat >= width - LANE_WIDTH - 0.15 : lat >= -0.15 && lat <= LANE_WIDTH + 0.15;
    const context = i.a.maneuverContext;
    const narrowUturn = event.kind === 'uturn' && !event.intersectionId && context?.cannotKeepExtreme === true;
    // 8.7 includes dimensions and other established reasons, not the vehicle
    // class alone. 8.8 has its own narrow-road U-turn exception.
    const exception = context?.cannotKeepExtreme === true;
    const safe = !hasContact(ctx, i.a.id, undefined, event.frame, event.endFrame + Math.ceil(0.5 / DT));
    const directedOrder = ctx.scene.signs.some(sign => ['5.15.1', '5.15.2'].includes(sign.kind)
      && dist(sign, posAt(i, before)) < 40 && Math.abs(angDiff(sign.angle, event.heading)) < 0.5)
      || ctx.scene.markings.some(mark => mark.kind === '1.18' && mark.pts.some(point => dist(point, posAt(i, before)) < 25));
    const tram = !right && !directedOrder ? ctx.geo.tracks.map(track => ({ track, near: nearestOnPolyline(track.pts, posAt(i, before)) }))
      .filter(item => !item.track.item.separated && !item.near.beyond && item.near.dist <= width + 1.5
        && dot(item.near.tangent, fromAngle(event.heading)) > 0.7
        && toLocal(item.near.point, { cx: i.tr.x[before], cy: i.tr.y[before], a: event.heading }).y <= 0.6)
      .sort((a,b) => a.near.dist - b.near.dist)[0] : undefined;
    const onTramTrack = !!tram && tram.near.dist <= 0.6;
    const positionComplies = tram ? onTramTrack : inExtremeLane;
    if (roundaboutEntry || positionComplies || exception && safe) add({ actorId: i.a.id, severity: 'info', t: tOf(before),
      title: exception && safe && !positionComplies ? 'отступление от крайнего положения по установленной причине' : 'положение перед поворотом соответствует наблюдаемому требованию',
      detail: roundaboutEntry ? 'Для въезда на круг п. 8.5 устанавливает исключение.' : exception && !positionComplies
        ? 'Задана невозможность соблюсти крайнее положение; наблюдаемой помехи нет.' : onTramTrack ? 'Поворот начинается с попутных путей на одном уровне с проезжей частью.' : 'Перед поворотом занята соответствующая крайняя полоса.',
      refs: ['pdd:8.5', ...(exception && !positionComplies ? [narrowUturn ? 'pdd:8.8' : 'pdd:8.7'] : [])], trace: { maneuver: event, lateral: lat, width, laneWidth: LANE_WIDTH, exception, tramTrackId: tram?.track.item.id, onTramTrack, directedOrder, safetyObserved: safe, compliance: 'выполнено' } });
    else add({ actorId: i.a.id, severity: 'violation', t: tOf(before), title: 'перед поворотом не занято соответствующее крайнее положение',
      detail: exception ? 'Исключение не освобождает от безопасности: имеется контакт во время манёвра.' : tram ? 'Слева имеются попутные трамвайные пути на одном уровне; иного порядка направлениями полос не задано. Поворот начат не с этих путей.' : 'Манёвр начат вне соответствующей крайней полосы; установленного исключения нет.',
      refs: ['pdd:8.5', ...(exception ? ['pdd:8.7'] : []), 'rule:extreme-position'], trace: { maneuver: event, lateral: lat, width, laneWidth: LANE_WIDTH, exception, tramTrackId: tram?.track.item.id, onTramTrack, directedOrder } });
    // 8.6 concerns leaving the carriageway crossing. Merely matching the
    // outgoing heading while the body is still inside is not an observed exit.
    let exitFrame = event.endFrame;
    const junction = ctx.geo.intersections.find(j => j.id === event.intersectionId);
    if (junction) while (exitFrame <= i.kEnd && (inIntersectionBoundary(posAt(i, exitFrame), junction.boundary)
      || obbCorners(boxAt(i, exitFrame)).some(point => inIntersectionBoundary(point, junction.boundary)))) exitFrame++;
    const exitHit = exitFrame <= i.kEnd ? atRoad(ctx, i, exitFrame) : undefined;
    const exitMinimumLat = exitHit ? Math.min(...obbCorners(boxAt(i, exitFrame)).map(point =>
      lateralFor(nearestOnPolyline(exitHit.rg.pts, point), i.tr.h[exitFrame]).lat)) : 0;
    if (exitHit && exitMinimumLat < -0.2 && !exitHit.rg.road.oneWay) add({ actorId: i.a.id, severity: 'violation', t: tOf(exitFrame),
      title: 'выезд из поворота на встречную сторону', detail: 'При выезде с пересечения кузов оказался на стороне встречного направления.',
      refs: ['pdd:8.6', 'rule:opposing-lane'], trace: { maneuver: event, exitFrame, lateral: localLat(i, exitFrame, exitHit), bodyMinimumLateral: exitMinimumLat, opposingToleranceMeters: 0.2 } });
    else if (exitHit) add({ actorId: i.a.id, severity: 'info', t: tOf(exitFrame), title: 'выезд после поворота на своей стороне',
      detail: 'В наблюдаемой точке завершения манёвра встречная сторона не занята.', refs: ['pdd:8.6'], trace: { maneuver: event, exitFrame, compliance: 'выполнено' } });
    if (event.kind === 'right' && exitHit) {
      const exitRoad = exitHit.rg.road;
      const exitWidth = exitRoad.lanes * LANE_WIDTH;
      const exitLateral = localLat(i, exitFrame, exitHit) + (exitRoad.oneWay ? exitWidth / 2 : 0);
      if (exitLateral < exitWidth - LANE_WIDTH - 0.15 && context?.cannotKeepExtreme !== true) add({ actorId: i.a.id,
        severity: context?.cannotKeepExtreme === false ? 'violation' : 'contributing', t: tOf(exitFrame), title: 'правый поворот завершён вдали от правого края',
        detail: context?.cannotKeepExtreme === false ? 'Выезд наблюдался во внутреннюю полосу при явно заданной возможности занять правое положение.' : 'Выезд наблюдался во внутреннюю полосу; возможность держаться ближе к правому краю требует установления исходных условий.',
        refs: ['pdd:8.6', ...(context?.cannotKeepExtreme === false ? ['rule:road-position'] : [])], trace: { maneuver: event, exitFrame, exitLateral, exitWidth, laneWidth: LANE_WIDTH, cannotKeepExtreme: context?.cannotKeepExtreme } });
    }
    if (event.kind === 'uturn') {
      const place = forbiddenPlace(ctx, i, event.frame);
      if (place.reasons.length || feature(road, 'motorway')) add({ actorId: i.a.id, severity: 'violation', t: tOf(event.frame),
        title: 'разворот в запрещённом месте', detail: `Наблюдаемый разворот выполнен в месте: ${[...place.reasons, ...(feature(road, 'motorway') ? ['motorway'] : [])].join(', ')}.`,
        refs: [...place.refs, feature(road, 'motorway') ? 'pdd:16.1' : 'pdd:8.11', feature(road, 'motorway') ? 'rule:motorway-maneuver' : 'rule:forbidden-maneuver'],
        trace: { maneuver: event, reasons: place.reasons, road } });
      else add({ actorId: i.a.id, severity: 'info', t: tOf(event.frame), title: 'запрет места разворота не установлен по заданным признакам',
        detail: 'В сцене нет наблюдаемого признака запрета п. 8.11; это не подтверждает полноту обследования места.', refs: ['pdd:8.11'], trace: { maneuver: event, compliance: 'выполнено' } });
    }
  }
}

function reverseChecks(ctx: Ctx, i: Info, add: Add): void {
  const frame = Array.from({ length: Math.max(0, i.kEnd - i.k0 + 1) }, (_, n) => i.k0 + n).find(k => reverseAt(i, k) && i.tr.v[k] > 0.1);
  if (frame === undefined) return;
  let forbidden: { frame: number; place: ReturnType<typeof forbiddenPlace>; intersection: boolean } | undefined;
  for (let k = frame; k <= i.kEnd; k++) if (reverseAt(i, k) && i.tr.v[k] > 0.1) {
    const place = forbiddenPlace(ctx, i, k), intersection = !!intersectionAt(ctx.geo, posAt(i, k));
    if (place.reasons.length || intersection || feature(place.road, 'motorway')) { forbidden = { frame: k, place, intersection }; break; }
  }
  const contact = ctx.tl.collisions.find(c => (c.a === i.a.id || c.b === i.a.id) && reverseAt(i, Math.max(frame, c.frame - 1)) && i.tr.v[Math.max(frame, c.frame - 1)] > 0.1);
  if (forbidden) add({ actorId: i.a.id, severity: 'violation', t: tOf(forbidden.frame), title: 'движение задним ходом в запрещённом месте',
    detail: `Задний ход наблюдался ${forbidden.intersection ? 'на перекрёстке' : 'в месте, где запрещён разворот'}.`,
    refs: ['pdd:8.12', ...(forbidden.place.reasons.length ? ['pdd:8.11'] : []), feature(forbidden.place.road, 'motorway') ? 'pdd:16.1' : 'pdd:8.12',
      feature(forbidden.place.road, 'motorway') ? 'rule:motorway-maneuver' : 'rule:forbidden-maneuver'], trace: { ...forbidden, road: forbidden.place.road } });
  if (contact) add({ actorId: i.a.id, severity: 'violation', causal: true, t: contact.t, title: 'задний ход создал опасность или помеху',
    detail: 'При движении задним ходом произошло столкновение; безопасность этого манёвра не обеспечена.', refs: ['pdd:8.12', 'pdd:8.1'], trace: { collision: contact, reversingFrame: frame } });
  if (!forbidden && !contact) add({ actorId: i.a.id, severity: 'info', t: tOf(frame), title: 'задний ход без наблюдаемого запрета или помехи',
    detail: 'На наблюдавшемся участке нет заданного признака запрещённого места и контакта; необходимость помощи другого лица по сцене не установлена.', refs: ['pdd:8.12'], trace: { frame, compliance: 'выполнено' } });
}

function decelerationLaneChecks(ctx: Ctx, i: Info, events: ObservedManeuver[], add: Add): void {
  for (const event of events.filter(e => e.kind === 'left' || e.kind === 'right')) {
    const lane = ctx.geo.roads.find(r => r.road.laneRole === 'deceleration' && dist(r.pts[0], posAt(i, event.frame)) < 80);
    if (!lane) continue;
    let firstLane = -1, brakeBefore = -1;
    for (let k = Math.max(i.k0, event.frame - 5 / DT); k <= event.endFrame; k++) {
      if (roadsAt(ctx.geo, posAt(i, k)).some(h => h.rg.road.id === lane.road.id) && firstLane < 0) firstLane = k;
      if (firstLane < 0 && k > i.k0 && i.tr.v[k - 1] - i.tr.v[k] > 0.5 * DT) brakeBefore = k;
    }
    add({ actorId: i.a.id, severity: brakeBefore >= 0 ? 'violation' : 'info', t: tOf(brakeBefore >= 0 ? brakeBefore : event.frame),
      title: brakeBefore >= 0 ? 'снижение скорости начато до полосы торможения' : 'снижение скорости вне полосы торможения не установлено',
      detail: 'При заданной полосе торможения п. 8.10 требует перестроиться на неё и снижать скорость на ней.', refs: ['pdd:8.10'],
      trace: { maneuver: event, decelerationLaneId: lane.road.id, firstLaneFrame: firstLane, brakeBeforeFrame: brakeBefore, minimumDecelMs2: 0.5, compliance: brakeBefore < 0 ? 'выполнено' : 'не выполнено' } });
  }
}

function isOpposing(ctx: Ctx, i: Info, k: number): boolean {
  const hit = atRoad(ctx, i, k);
  return !!hit && !hit.rg.road.oneWay && localLat(i, k, hit) < -0.2;
}

/** A pass is not called an overtake until opposing-lane use is observed. */
function passages(ctx: Ctx): Passage[] {
  const out: Passage[] = [], list = [...ctx.infos.values()].filter(i => i.isVeh && !i.rail);
  for (const A of list) for (const B of list) {
    if (A === B) continue;
    let start = -1, pass = -1;
    const end = Math.min(A.kEnd, B.kEnd);
    for (let k = Math.max(A.k0, B.k0); k <= end; k++) {
      if (!A.tr.present[k] || !B.tr.present[k] || reverseAt(A, k) || reverseAt(B, k) || Math.abs(angDiff(A.tr.h[k], B.tr.h[k])) > 0.6) continue;
      const p = toLocal(posAt(A, k), { cx: B.tr.x[k], cy: B.tr.y[k], a: B.tr.h[k] });
      if (Math.abs(p.y) > LANE_WIDTH * 2.5) continue;
      if (start < 0 && p.x < -(A.hl + B.hl) && p.x > -100) start = k;
      if (start >= 0 && p.x > A.hl + B.hl) { pass = k; break; }
    }
    if (start < 0) continue;
    let firstOpposing = -1;
    for (let k = start; k <= (pass >= 0 ? pass : end); k++) {
      if (isOpposing(ctx, A, k) && Math.abs(angDiff(A.tr.h[k], B.tr.h[k])) < 0.7) { firstOpposing = k; break; }
    }
    const opposing = firstOpposing >= 0;
    let lastOpposing = firstOpposing;
    if (opposing) while (lastOpposing < end && isOpposing(ctx, A, lastOpposing + 1)) lastOpposing++;
    const completed = pass >= 0;
    if (!completed) {
      // A prohibited overtake may be aborted without contact or a completed pass.
      // Distinguish an excursion to pass a leader from a planned turn away.
      const last = A.a.path.at(-1), previous = A.a.path.at(-2) ?? A.a;
      const plannedStraight = last && Math.abs(angDiff(A.tr.h[start], Math.atan2(last.y - previous.y, last.x - previous.x))) < 0.35;
      if (!opposing || !plannedStraight && !hasContact(ctx, A.a.id, B.a.id, start, end)) continue;
      pass = lastOpposing;
    }
    if (A.trav[pass] - A.trav[start] < 1) continue;
    const returned = opposing && lastOpposing < end && !isOpposing(ctx, A, lastOpposing + 1);
    out.push({ A, B, start: opposing ? firstOpposing : start, pass, end: Math.max(pass, lastOpposing), opposing, returned, completed });
  }
  return out;
}

function overtakeChecks(ctx: Ctx, add: Add): void {
  const passes = passages(ctx);
  for (const pass of passes) {
    const { A, B, start, end, opposing } = pass;
    const t = tOf(start), aContext = A.a.maneuverContext;
    const trace = { overtaker: A.a.id, overtaken: B.a.id, startFrame: start, passFrame: pass.completed ? pass.pass : null, endFrame: end, completedPass: pass.completed,
      opposingLane: opposing, returned: pass.returned };
    if (opposing) {
      const left = vehicleSignalAt(B.a, t, B.tr.waypointTimes);
      const leaderPassing = passes.some(p => p.A === B && p.start <= end && p.end >= start && p.opposing);
      const leaderBypassing = B.a.maneuverContext?.opposingObstacle === true && isOpposing(ctx, B, start);
      const followerPassing = passes.some(p => p.B === A && p.A !== B && p.start <= start && p.end >= start && p.opposing);
      const cannotReturn = aContext?.overtakeReturnClear === false;
      const danger = hasContact(ctx, A.a.id, undefined, start, end + Math.ceil(0.5 / DT)) || aContext?.oncomingClear === false;
      add({ actorId: A.a.id, severity: danger ? 'violation' : aContext?.oncomingClear === true ? 'info' : 'contributing', t,
        title: danger ? 'обгон при установленной опасности или помехе' : aContext?.oncomingClear === true ? 'свободная полоса для обгона подтверждена исходными данными' : 'достаточная свободная полоса для обгона не установлена',
        detail: 'Для обгона требуется свободная полоса достаточной длины и отсутствие опасности; отсутствие встречного ТС в неполной сцене само по себе этого не доказывает.',
        refs: ['pdd:11.1', ...(danger ? ['rule:opposing-lane'] : [])], trace: { ...trace, oncomingClear: aContext?.oncomingClear, compliance: !danger && aContext?.oncomingClear === true ? 'выполнено' : 'не определить' } });
      const badReasons = [...(left.signal === 'left' ? ['left-signal'] : []), ...(leaderPassing ? ['leader-overtaking'] : []), ...(leaderBypassing ? ['leader-bypassing-obstacle'] : []), ...(followerPassing ? ['following-overtaker'] : []), ...(cannotReturn ? ['return-blocked'] : [])];
      if (badReasons.length) add({ actorId: A.a.id, severity: 'violation', t, title: 'обгон при запрещающих условиях',
        detail: 'Установлено одно из запрещающих условий п. 11.2: ' + badReasons.join(', ') + '.', refs: ['pdd:11.2', 'rule:opposing-lane'], trace: { ...trace, leaderSignal: left, leaderBypassingObstacle: leaderBypassing, reasons: badReasons } });
      else add({ actorId: A.a.id, severity: aContext?.overtakeReturnClear === undefined ? 'contributing' : 'info', t, title: 'запрещающие условия обгона проверены в пределах исходных данных',
        detail: 'Сигнала налево и одновременного обгона не наблюдалось; возможность безопасного возврата должна быть установлена отдельно.', refs: ['pdd:11.2'], trace: { ...trace, returnClear: aContext?.overtakeReturnClear, compliance: aContext?.overtakeReturnClear === true ? 'выполнено' : 'не определить' } });
      const forbidden: { frame: number; reasons: string[] }[] = [];
      for (let k = start; k <= end; k++) {
        const hit = atRoad(ctx, A, k), road = hit?.rg.road, reasons: string[] = [];
        for (const name of ['bridge', 'tunnel', 'railway-crossing', 'limited-visibility'] as const) if (feature(road, name)) reasons.push(name);
        const crossing = ctx.geo.crosswalks.some(c => pointInObb(posAt(A, k), c.box, A.hl));
        if (crossing) reasons.push('pedestrian-crossing');
        const j = intersectionAt(ctx.geo, posAt(A, k));
        if (j) {
          const p = ctx.priorityGraphs.flatMap(g => g.intersectionId === j.id ? g.participants : []).find(p => p.actorId === A.a.id);
          if (p?.regulated || p && p.priority < 1) reasons.push(p?.regulated ? 'regulated-intersection' : 'secondary-road');
        }
        const beforeRail = ctx.geo.roads.some(r => feature(r.road, 'railway-crossing') && r.pts.some(point => {
          const l = toLocal(point, { cx: A.tr.x[k], cy: A.tr.y[k], a: A.tr.h[k] });
          return l.x > 0 && l.x <= 100 && Math.abs(l.y) < 10;
        }));
        if (beforeRail) reasons.push('less-than-100m-before-railway');
        if (reasons.length) { forbidden.push({ frame: k, reasons }); break; }
      }
      const ban = ctx.gates.find(g => g.actorId === A.a.id && g.sign?.kind === '3.20' && g.frame <= end && (g.until === undefined || g.until > start));
      if (forbidden.length || ban) add({ actorId: A.a.id, severity: 'violation', t: tOf(forbidden[0]?.frame ?? start), title: 'обгон в запрещённом месте',
        detail: 'Обгон с выездом на встречную полосу наблюдался в месте запрета п. 11.4 или знака 3.20.', refs: ['pdd:11.4', ...(ban ? ['sign:3.20'] : []), 'rule:opposing-lane'], trace: { ...trace, forbidden, signId: ban?.sign?.id } });
      else add({ actorId: A.a.id, severity: 'info', t, title: 'запрет места обгона не установлен', detail: 'По заданным признакам места запрет п. 11.4 не обнаружен; сведения об обзорности должны быть подтверждены.', refs: ['pdd:11.4'], trace: { ...trace, compliance: 'выполнено' } });
      const raised = B.a.maneuverContext?.overtakenAccelerates === true || B.tr.v[Math.min(B.kEnd, end)] - B.tr.v[start] > 1;
      add({ actorId: B.a.id, severity: raised ? 'violation' : 'info', t, title: raised ? 'повышение скорости при обгоне' : 'повышение скорости обгоняемым не наблюдалось',
        detail: raised ? 'Установлено повышение скорости или задано препятствование обгону. TODO(legal-check): точный самостоятельный состав КоАП для этого действия требует проверки; ч. 3 ст. 12.15 относится к объезду препятствия.' : 'В наблюдаемом интервале повышение скорости не установлено.',
        refs: ['pdd:11.3'], trace: { ...trace, speedAtStart: B.tr.v[start], speedAtEnd: B.tr.v[Math.min(B.kEnd, end)], explicitObstruction: B.a.maneuverContext?.overtakenAccelerates, compliance: raised ? 'не выполнено' : 'выполнено' } });
    } else {
      const haltedAtCrossing = ctx.geo.crosswalks.find(c => pointInObb(posAt(A, pass.pass), c.box, A.hl + 8) && dist(posAt(B, pass.pass), c.item) < 30 && B.tr.v[pass.pass] < 0.3);
      if (haltedAtCrossing) {
        const near = Math.max(start, pass.pass - Math.round(1 / DT));
        const reduced = A.tr.v[near] < 0.3 || A.tr.v[start] - A.tr.v[near] > 0.5;
        add({ actorId: A.a.id, severity: reduced ? 'info' : 'violation', t: tOf(pass.pass), title: reduced ? 'снижение скорости у остановившегося перед переходом ТС' : 'опережение у перехода без снижения скорости',
          detail: 'Проверяется п. 11.5 со ссылкой на 14.2: необходимо снизить скорость или остановиться перед продолжением движения рядом с остановившимся ТС.',
          refs: ['pdd:11.5', 'pdd:14.2'], trace: { ...trace, crosswalkId: haltedAtCrossing.item.id, speedBefore: A.tr.v[start], speedNear: A.tr.v[near], compliance: reduced ? 'выполнено' : 'не выполнено' } });
      }
    }
  }
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || !i.a.maneuverContext?.overtakingDifficult) continue;
    const hit = atRoad(ctx, i, i.k0);
    if (!hit || hit.rg.road.zone !== 'outside') continue;
    const dimensions = dimsOf(i.a);
    const oversized = dimensions.width > 2.55 || dimensions.length > 20 || (i.a.cargo?.height ?? 0) > 4;
    const slow = i.tr.v[i.k0] * 3.6 <= 30 || oversized || i.a.type === 'cart';
    if (!slow) continue;
    const context = i.a.maneuverContext;
    const yielded = context.keptRight === true && (context.yieldedByStop !== false);
    add({ actorId: i.a.id, severity: yielded ? 'info' : context.keptRight === false || context.yieldedByStop === false ? 'violation' : 'contributing', t: tOf(i.k0),
      title: yielded ? 'затруднённый обгон или опережение пропущены' : 'обязанность пропустить следующие ТС при затруднённом обгоне',
      detail: 'Вне населённого пункта для указанного медленного или крупногабаритного ТС задано затруднение обгона; требуется принять правее, при необходимости остановиться.', refs: ['pdd:11.6', ...(!yielded && (context.keptRight === false || context.yieldedByStop === false) ? ['rule:slow-vehicle-yield'] : [])],
      trace: { context, speedKmh: i.tr.v[i.k0] * 3.6, roadZone: hit.rg.road.zone, compliance: yielded ? 'выполнено' : 'не определить' } });
  }
}

export function maneuverPriority(ctx: Ctx, a: string, b: string, col: Collision): ManeuverPriority | null {
  const A = ctx.infos.get(a), B = ctx.infos.get(b);
  if (!A || !B || !A.isVeh || !B.isVeh || intersectionAt(ctx.geo, col.point)) return null;
  const k = Math.max(A.k0, B.k0, col.frame - Math.round(1.5 / DT));
  const opposite = Math.abs(angDiff(A.tr.h[k], B.tr.h[k])) > 2.2;
  const pair = (Y: Info, P: Info, refs: string[], explain: string): ManeuverPriority => ({ from: Y.a.id, to: P.a.id, refs,
    explain, trace: { frame: k, collisionFrame: col.frame, otherActorId: P.a.id, a: posAt(Y, k), b: posAt(P, k) } });
  const movingBackA = reverseAt(A, col.frame - 1) && A.tr.v[col.frame - 1] > 0.1;
  const movingBackB = reverseAt(B, col.frame - 1) && B.tr.v[col.frame - 1] > 0.1;
  if (movingBackA !== movingBackB) return movingBackA
    ? pair(A, B, ['pdd:8.12'], 'Движущийся задним ходом обязан обеспечить безопасность и не создавать помех.')
    : pair(B, A, ['pdd:8.12'], 'Движущийся задним ходом обязан обеспечить безопасность и не создавать помех.');
  const initialA = atRoad(ctx, A, A.k0), initialB = atRoad(ctx, B, B.k0);
  const adjacentA = !initialA || initialA.rg.road.role === 'adjacent', adjacentB = !initialB || initialB.rg.road.role === 'adjacent';
  if (adjacentA !== adjacentB) return adjacentA
    ? pair(A, B, ['pdd:8.3', 'rule:maneuver-priority'], 'При выезде с прилегающей территории необходимо уступить движущимся по дороге.')
    : pair(B, A, ['pdd:8.3', 'rule:maneuver-priority'], 'При выезде с прилегающей территории необходимо уступить движущимся по дороге.');
  const eventsA = observedManeuvers(ctx, A), eventsB = observedManeuvers(ctx, B);
  const near = (events: ObservedManeuver[]) => events.find(e => e.frame <= col.frame && col.frame - e.frame < 6 / DT);
  const ea = near(eventsA), eb = near(eventsB);
  if (opposite) {
    const slope = ctx.scene.signs.some(s => ['1.13', '1.14'].includes(s.kind) && dist(s, col.point) < 120);
    const aObstacle = A.a.maneuverContext?.opposingObstacle === true, bObstacle = B.a.maneuverContext?.opposingObstacle === true;
    const aDownhill = A.a.maneuverContext?.slopeDownhill === true, bDownhill = B.a.maneuverContext?.slopeDownhill === true;
    const downhill = slope && (aObstacle || bObstacle) && aDownhill !== bDownhill ? aDownhill ? A : B : null;
    const obstacle = aObstacle !== bObstacle ? aObstacle ? A : B : null;
    const Y = downhill ?? obstacle;
    if (Y) return pair(Y, Y === A ? B : A, ['pdd:11.7', 'rule:meeting-priority'], downhill
      ? 'При затруднённом встречном разъезде на обозначенном уклоне уступает движущийся на спуск.' : 'При затруднённом встречном разъезде уступает водитель, на стороне которого препятствие.');
  }
  for (const [Y, P, e] of [[A, B, ea], [B, A, eb]] as const) {
    if (e?.kind === 'uturn' && Y.a.maneuverContext?.cannotKeepExtreme === true)
      return pair(Y, P, ['pdd:8.8', 'rule:maneuver-priority'], 'При развороте вне перекрёстка от правого края из-за недостаточной ширины уступают попутным и встречным ТС.');
  }
  for (const [Y, P, e] of [[A, B, ea], [B, A, eb]] as const) if (e && ['left', 'uturn'].includes(e.kind) && (opposite || P.rail && Math.abs(angDiff(Y.tr.h[k], P.tr.h[k])) < 0.5)) return pair(Y, P, ['pdd:8.8', 'rule:maneuver-priority'], 'При повороте налево или развороте вне перекрёстка уступают встречному ТС и трамваю попутного направления.');
  if (Math.abs(angDiff(A.tr.h[k], B.tr.h[k])) < 0.7 && (ea?.kind === 'lane-change' || eb?.kind === 'lane-change')) {
    let Y: Info;
    if (ea?.kind === 'lane-change' && eb?.kind === 'lane-change') {
      const side = toLocal(posAt(B, k), { cx: A.tr.x[k], cy: A.tr.y[k], a: A.tr.h[k] }).y;
      Y = side > 0 ? A : B;
    } else Y = ea?.kind === 'lane-change' ? A : B;
    const accelerationLane = (Y === A ? initialA : initialB)?.rg.road.laneRole === 'acceleration';
    return pair(Y, Y === A ? B : A, ['pdd:8.4', ...(accelerationLane ? ['pdd:8.10'] : []), 'rule:maneuver-priority'], 'При перестроении уступают попутному ТС без изменения направления, при одновременном перестроении — находящемуся справа.');
  }
  const dh = Math.abs(angDiff(A.tr.h[k], B.tr.h[k]));
  if (dh > 0.7 && dh < 2.2) {
    const rightB = toLocal(posAt(B, k), { cx: A.tr.x[k], cy: A.tr.y[k], a: A.tr.h[k] }).y > 0.5;
    const rightA = toLocal(posAt(A, k), { cx: B.tr.x[k], cy: B.tr.y[k], a: B.tr.h[k] }).y > 0.5;
    if (rightA !== rightB) return rightB ? pair(A, B, ['pdd:8.9', 'rule:maneuver-priority'], 'Вне перекрёстка при неоговорённой очерёдности уступают приближающемуся справа.') : pair(B, A, ['pdd:8.9', 'rule:maneuver-priority'], 'Вне перекрёстка при неоговорённой очерёдности уступают приближающемуся справа.');
  }
  return null;
}

/** Requirements and causal observations; never mutates the immutable technical stage. */
export function checkManeuvers(ctx: Ctx, add: Add): void {
  for (const i of ctx.infos.values()) if (i.isVeh && i.k0 < ctx.tl.n) {
    const events = observedManeuvers(ctx, i);
    signalChecks(ctx, i, events, add);
    positionChecks(ctx, i, events, add);
    reverseChecks(ctx, i, add);
    decelerationLaneChecks(ctx, i, events, add);
  }
  overtakeChecks(ctx, add);
  for (const collision of ctx.tl.collisions) {
    const duty = maneuverPriority(ctx, collision.a, collision.b, collision);
    if (duty && !ctx.findings.some(f => f.actorId === duty.from && f.causal && f.refs.some(ref => duty.refs.includes(ref)))) add({ actorId: duty.from, severity: 'violation', causal: true, t: collision.t,
      title: 'манёвр создал помеху имеющему преимущество', detail: duty.explain, refs: duty.refs, trace: duty.trace });
  }
}
