import { classifyStop, stopIntervals } from './stopping';
import { obbContact, obbCorners, pointInObb, segIntersect, toLocal, type OBB, type Vec } from '../geom';
import type { RailwayCrossing } from '../scene';
import { DT, type Collision } from '../sim';
import type { Ctx, Info } from './context';
import { boxAt, posAt, sampleTrace, tOf } from './technical';
import type { FindingInput, Trace } from './types';

type Add = (finding: FindingInput) => unknown;
const SPEED_EPSILON = 0.1;
// Observation tolerance only; neither value is a statutory stopping duration.
const STOP_OBSERVATION_SECONDS = 0.5;
const DISTANCE_EPSILON = 0.05;
export const railwayBox = (c: RailwayCrossing): OBB => ({ cx: c.x, cy: c.y, a: c.angle, hl: c.length / 2, hw: c.width / 2 });

interface Entry { frame: number; side: -1 | 1 }
interface Prohibition { text: string; code?: 'rule:railway-prohibited-entry' | 'rule:railway-other' }

/** State is a snapshot supplied by the author, not an inferred light schedule. */
export function railwayProhibitions(c: RailwayCrossing): Prohibition[] {
  const reasons: Prohibition[] = [];
  if (c.barrier === 'closed' || c.barrier === 'closing') reasons.push({ text: c.barrier === 'closed' ? 'шлагбаум закрыт' : 'шлагбаум начал закрываться', code: 'rule:railway-prohibited-entry' });
  if (c.signal === 'red') reasons.push({ text: 'горит запрещающий красный сигнал', code: 'rule:railway-prohibited-entry' });
  if (c.attendantStop === true) reasons.push({ text: 'дежурный подаёт запрещающий сигнал', code: 'rule:railway-prohibited-entry' });
  if (c.exitBlocked === true) reasons.push({ text: 'за переездом затор, который вынудит остановиться на путях', code: 'rule:railway-other' });
  if (c.visibleTrainApproaching === true) reasons.push({ text: 'в пределах видимости приближается поезд', code: c.regulated === false ? 'rule:railway-prohibited-entry' : c.regulated === true ? 'rule:railway-other' : undefined });
  return reasons;
}

function unknownControls(c: RailwayCrossing): string[] {
  return [c.barrier === undefined ? 'положение шлагбаума' : '', c.signal === undefined ? 'сигнал светофора' : '',
    c.attendantStop === undefined ? 'указания дежурного' : '', c.exitBlocked === undefined ? 'возможность освободить переезд' : '',
    c.visibleTrainApproaching === undefined ? 'наличие видимого приближающегося поезда' : ''].filter(Boolean);
}

/** Distance from the frontmost body projection to the nearest outer rail.
 * Side is the approach side and stays fixed when the front enters the crossing. */
export function railwayFrontDistance(c: RailwayCrossing, i: Info, frame: number, side: -1 | 1): number {
  const projected = obbCorners(boxAt(i, frame)).map(p => toLocal(p, railwayBox(c)).x * side);
  return Math.min(...projected) - c.length / 2;
}

function entries(c: RailwayCrossing, i: Info): Entry[] {
  const out: Entry[] = [], region = railwayBox(c);
  for (let k = Math.max(1, i.k0 + 1); k <= i.kEnd; k++) {
    if (!i.tr.present[k - 1] || !i.tr.present[k]) continue;
    const before = toLocal(posAt(i, k - 1), region);
    const side: -1 | 1 = before.x < 0 ? -1 : 1;
    const a = railwayFrontDistance(c, i, k - 1, side), b = railwayFrontDistance(c, i, k, side);
    // Starting inside, touching the side of the road or driving away is not an observed entry.
    if (a >= 0 && b < 0 && obbContact(boxAt(i, k), region)) out.push({ frame: k, side });
  }
  return out;
}

/** Measured scalar distances are symmetric facts for the two approaches.
 * Missing geometry never means a missing stop-line, light or barrier. */
function stoppingBoundary(c: RailwayCrossing): { distance: number; basis: string } | null {
  if (c.stopLineDistance !== undefined) return { distance: c.stopLineDistance, basis: 'заданная стоп-линия / знак 6.16 / знак 2.5' };
  if (c.stopLinePresent !== false) return null;
  if (c.controlDistance !== undefined) return { distance: c.controlDistance + 5, basis: 'не ближе 5 м до заданного светофора или шлагбаума' };
  if (c.lightPresent === false && c.barrier === 'none') return { distance: 10, basis: 'не ближе 10 м до ближайшего рельса при отсутствии светофора и шлагбаума' };
  return null;
}

function traceAt(ctx: Ctx, c: RailwayCrossing, i: Info, k: number): Trace {
  return { ...sampleTrace(ctx, i, k), crossingId: c.id, crossing: structuredClone(c), railwayContext: structuredClone(i.a.railwayContext),
    stateAssumption: 'Указанное состояние переезда постоянно в пределах прогона; неизвестные поля не считаются отрицательными фактами.' };
}

function stopFrame(c: RailwayCrossing, i: Info, start = i.k0, end = i.kEnd): number | null {
  const hold = Math.ceil(STOP_OBSERVATION_SECONDS / DT);
  let run = 0, first = -1;
  for (let k = start; k <= end; k++) {
    if (i.tr.present[k] && i.tr.v[k] < SPEED_EPSILON && obbContact(boxAt(i, k), railwayBox(c))) {
      if (run++ === 0) first = k;
      if (run >= hold) return first;
    } else { run = 0; first = -1; }
  }
  return null;
}

function nonForcedStopAfterEntry(c: RailwayCrossing, i: Info, entry: Entry): boolean {
  const r = i.a.railwayContext;
  if (r?.crossingId !== undefined && r.crossingId !== c.id) return false;
  let end = entry.frame;
  while (end < i.kEnd && obbContact(boxAt(i, end + 1), railwayBox(c))) end++;
  const frame = stopFrame(c, i, entry.frame, end);
  const interval = stopIntervals(i).find(rest => frame !== null && rest.from <= frame && rest.to >= frame);
  return frame !== null && !!interval && classifyStop(i.a, interval, frame, i.k0).voluntary === true;
}

function entryChecks(ctx: Ctx, c: RailwayCrossing, i: Info, entry: Entry, add: Add): void {
  const reasons = railwayProhibitions(c), trace = traceAt(ctx, c, i, entry.frame);
  if (reasons.length) {
    // Part 1 is selected only by an established special condition, not by the whole list of 15.3.
    const special = reasons.some(r => r.code === 'rule:railway-prohibited-entry');
    const stopCoversConduct = nonForcedStopAfterEntry(c, i, entry);
    const code = special ? 'rule:railway-prohibited-entry' : !stopCoversConduct && reasons.some(r => r.code === 'rule:railway-other') ? 'rule:railway-other' : undefined;
    add({ actorId: i.a.id, severity: 'violation', t: tOf(entry.frame), title: 'въезд на железнодорожный переезд запрещён',
      detail: `В момент пересечения передней границей кузова ближайшего рельса: ${reasons.map(r => r.text).join('; ')}.`,
      refs: ['pdd:15.2', 'pdd:15.3', ...(c.signal === 'red' ? ['pdd:6.9'] : []), ...(code ? [code] : [])],
      trace: { ...trace, reasons, approachSide: entry.side, frontDistance: railwayFrontDistance(c, i, entry.frame, entry.side), stopCoversConduct,
        visibleTrainQualificationUnknown: c.visibleTrainApproaching === true && c.regulated === undefined } });
  } else {
    const unknown = unknownControls(c);
    add({ actorId: i.a.id, severity: unknown.length ? 'contributing' : 'info', t: tOf(entry.frame),
      title: unknown.length ? 'условия проезда переезда установлены не полностью' : 'запрещающих условий въезда на переезд не установлено',
      detail: unknown.length ? `Не заданы: ${unknown.join(', ')}. Въезд не признаётся разрешённым только по отсутствию этих данных.`
        : c.signal === 'white' ? 'Лунно-белый мигающий сигнал разрешает движение; отдельно проверены запреты п. 15.3.'
          : c.signal === 'off' ? 'При выключенных сигналах задано отсутствие приближающегося в пределах видимости поезда; отдельно проверены запреты п. 15.3.'
            : 'По заданным фактам запреты п. 15.3 отсутствуют; водитель обязан убедиться в безопасности.',
      refs: ['pdd:15.1', 'pdd:15.2', ...(c.signal === 'white' || c.signal === 'off' ? ['pdd:6.9'] : [])],
      trace: { ...trace, unknown, compliance: unknown.length ? 'не определить' : 'выполнено' } });
  }
}

function stopBoundaryChecks(ctx: Ctx, c: RailwayCrossing, i: Info, add: Add): void {
  if (!railwayProhibitions(c).length) return;
  const boundary = stoppingBoundary(c);
  if (!boundary) return;
  const observedEntries = entries(c, i);
  const specialEntry = observedEntries.length > 0 && (railwayProhibitions(c).some(reason => reason.code === 'rule:railway-prohibited-entry')
    || observedEntries.some(entry => nonForcedStopAfterEntry(c, i, entry)));
  for (let k = Math.max(1, i.k0 + 1); k <= i.kEnd; k++) {
    if (!i.tr.present[k - 1] || !i.tr.present[k]) continue;
    const local = toLocal(posAt(i, k - 1), railwayBox(c)), side: -1 | 1 = local.x < 0 ? -1 : 1;
    const before = railwayFrontDistance(c, i, k - 1, side), after = railwayFrontDistance(c, i, k, side);
    const lateral = obbCorners(boxAt(i, k)).map(p => toLocal(p, railwayBox(c)).y);
    if (Math.min(...lateral) > c.width / 2 || Math.max(...lateral) < -c.width / 2) continue;
    if (before >= boundary.distance - DISTANCE_EPSILON && after < boundary.distance - DISTANCE_EPSILON && after < before) {
      add({ actorId: i.a.id, severity: 'violation', t: tOf(k), title: 'не соблюдено место остановки перед переездом',
        detail: `Проезд запрещён. Требуется остановиться: ${boundary.basis}; передняя граница кузова пересекла эту границу.`,
        refs: ['pdd:15.4', ...(specialEntry ? [] : ['rule:railway-other'])], trace: { ...traceAt(ctx, c, i, k), boundary,
          approachSide: side, distanceBeforeRail: after, observationToleranceMeters: DISTANCE_EPSILON } });
      return;
    }
  }
}

function specialContextChecks(ctx: Ctx, c: RailwayCrossing, i: Info, entered: Entry[], add: Add): void {
  const r = i.a.railwayContext;
  if (!r || r.crossingId !== c.id && (r.crossingId !== undefined || !entered.length)) return;
  const frame = entered[0]?.frame ?? i.k0, trace = traceAt(ctx, c, i, frame);
  const violations: string[] = [];
  if (r.bypassingWaitingQueue === true) violations.push('задан объезд стоящих перед переездом ТС с выездом на встречную полосу');
  if (r.openedBarrier === true) violations.push('задано самовольное открытие шлагбаума');
  if (entered.length && r.machineryTransportPosition === false) violations.push('машина перевозится в нетранспортном положении');
  const slow = r.slowMachinery === true || r.tractorSledge === true;
  if (entered.length && slow && r.trackAuthorityPermission === false) violations.push('тихоходная машина (по её характеристикам менее 8 км/ч) или тракторные сани следуют без разрешения начальника дистанции пути');
  if (violations.length) add({ actorId: i.a.id, severity: 'violation', t: tOf(frame), title: 'нарушен дополнительный запрет при проезде железнодорожных путей',
    detail: violations.join('; '), refs: ['pdd:15.3', 'rule:railway-other'], trace });
  if (entered.length && slow && r.trackAuthorityPermission === undefined) add({ actorId: i.a.id, severity: 'contributing', t: tOf(frame),
    title: 'неизвестно разрешение на проезд тихоходной машины или тракторных саней', detail: 'Наличие разрешения начальника дистанции пути не задано. Низкая текущая скорость обычного автомобиля сама по себе не устанавливает этот запрет.',
    refs: ['pdd:15.3'], trace: { ...trace, compliance: 'не определить' } });
}

const FORCED_STOP_GUIDANCE = 'Немедленно высадить людей и принять меры к освобождению переезда. При возможности послать двух человек вдоль путей в обе стороны на 1000 м (одного — в сторону худшей видимости), объяснив сигнал остановки. Оставаться у ТС и подавать общую тревогу (один длинный и три коротких звуковых сигнала). При появлении поезда бежать ему навстречу с сигналом остановки: круговое движение руки с яркой тканью днём, с фонарём или факелом ночью.';

function crossingStops(ctx: Ctx, c: RailwayCrossing, i: Info, add: Add): void {
  const frame = stopFrame(c, i);
  if (frame === null) return;
  const r = i.a.railwayContext, applies = !r?.crossingId || r.crossingId === c.id;
  const interval = stopIntervals(i).find(rest => rest.from <= frame && rest.to >= frame);
  const classification = interval ? classifyStop(i.a, interval, frame, i.k0) : null;
  const forced = classification?.kind === 'forced' ? true : applies ? r?.forcedStop : undefined;
  if (classification?.voluntary === true) add({ actorId: i.a.id, severity: 'violation', t: tOf(frame), title: 'остановка на железнодорожном переезде',
    detail: 'Установлена преднамеренная остановка на переезде по известной причине. Повторность из прогона не определяется.',
    refs: ['pdd:12.4', 'rule:railway-stop'], trace: { ...traceAt(ctx, c, i, frame), stopObservationSeconds: STOP_OBSERVATION_SECONDS } });
  else if (forced !== true && classification?.kind !== 'traffic') add({ actorId: i.a.id, severity: 'contributing', t: tOf(frame), title: 'причина остановки на переезде не задана',
    detail: 'Нулевая скорость сама по себе не отличает вынужденную остановку от остановки или стоянки. Административный состав по этому факту не назначается.',
    refs: ['pdd:15.5'], trace: { ...traceAt(ctx, c, i, frame), compliance: 'не определить' } });
  if (forced !== true) return;
  add({ actorId: i.a.id, severity: 'info', t: tOf(frame), title: 'действия при вынужденной остановке на переезде',
    detail: FORCED_STOP_GUIDANCE, refs: ['pdd:15.5'], trace: { ...traceAt(ctx, c, i, frame), compliance: 'не определить' } });
  const missing: string[] = [];
  if (r?.passengersDisembarked === false) missing.push('люди не высажены');
  if (r?.clearingCrossing === false) missing.push('меры к освобождению переезда не приняты');
  if (r?.messengersPossible === true && r.stopMessengers === 'none') missing.push('при установленной возможности люди вдоль путей не направлены');
  if (r?.stayedByVehicle === false && c.visibleTrainApproaching !== true) missing.push('водитель не остался у ТС');
  if (r?.generalAlarm === false) missing.push('сигнал общей тревоги не подавался');
  if (c.visibleTrainApproaching === true && r?.trainStopSignal === false) missing.push('при появлении поезда сигнал остановки ему не подавался');
  if (missing.length) add({ actorId: i.a.id, severity: 'violation', t: tOf(frame), title: 'не выполнены указанные обязанности при вынужденной остановке',
    detail: `${missing.join('; ')}. ${FORCED_STOP_GUIDANCE}`, refs: ['pdd:15.5', 'rule:railway-other'], trace: traceAt(ctx, c, i, frame) });
}

function outsideCrossings(ctx: Ctx, i: Info, add: Add): void {
  // Omitted collection is legacy/unknown geometry, not proof of an absent crossing.
  if (ctx.scene.railwayCrossings === undefined) return;
  for (const track of ctx.geo.tracks.filter(t => t.item.kind === 'railway')) {
    for (let k = Math.max(1, i.k0 + 1); k <= i.kEnd; k++) {
      if (!i.tr.present[k - 1] || !i.tr.present[k]) continue;
      for (let n = 1; n < track.pts.length; n++) {
        const a = posAt(i, k - 1), b = posAt(i, k), hit = segIntersect(a, b, track.pts[n - 1], track.pts[n]);
        if (!hit || hit.t < 1e-8) continue;
        const p: Vec = { x: a.x + (b.x - a.x) * hit.t, y: a.y + (b.y - a.y) * hit.t };
        if (ctx.scene.railwayCrossings.some(c => pointInObb(p, railwayBox(c)))) continue;
        add({ actorId: i.a.id, severity: 'violation', t: tOf(k), title: 'пересечение железнодорожных путей вне переезда',
          detail: 'Наблюдаемая траектория пересекает явно заданный железнодорожный путь за пределами всех заданных переездов.',
          refs: ['pdd:15.1', 'rule:railway-outside'], trace: { ...sampleTrace(ctx, i, k), railwayTrackId: track.item.id, crossingPoint: p, crossingGeometryExplicit: true } });
        return;
      }
    }
  }
}

export function checkRailway(ctx: Ctx, add: Add): void {
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || i.a.railwayTrain || i.k0 >= ctx.tl.n) continue;
    outsideCrossings(ctx, i, add);
    for (const crossing of ctx.scene.railwayCrossings ?? []) {
      const entered = entries(crossing, i);
      for (const entry of entered) entryChecks(ctx, crossing, i, entry, add);
      if (entered.length && railwayProhibitions(crossing).length && !stoppingBoundary(crossing)) add({ actorId: i.a.id, severity: 'contributing', t: tOf(entered[0].frame),
        title: 'место обязательной остановки перед переездом не установлено',
        detail: 'Для проверки п. 15.4 нужны измеренная стоп-линия либо подтверждённое её отсутствие и геометрия светофора/шлагбаума. Отсутствующие измерения не заменяются вымышленными расстояниями.',
        refs: ['pdd:15.4'], trace: { ...traceAt(ctx, crossing, i, entered[0].frame), compliance: 'не определить' } });
      stopBoundaryChecks(ctx, crossing, i, add);
      specialContextChecks(ctx, crossing, i, entered, add);
      crossingStops(ctx, crossing, i, add);
    }
  }
}

export interface RailwayPriority { from: string; to: string; refs: string[]; explain: string; trace: Trace; failureEstablished: boolean }
/** Trains never receive tram/right-hand priority from ordinary road junctions. */
export function railwayPriority(ctx: Ctx, a: string, b: string, collision: Collision): RailwayPriority | null {
  const A = ctx.infos.get(a), B = ctx.infos.get(b);
  if (!A || !B || !A.isVeh || !B.isVeh || !!A.a.railwayTrain === !!B.a.railwayTrain) return null;
  const [train, road] = A.a.railwayTrain ? [A, B] : [B, A];
  const k = Math.max(road.k0, train.k0, collision.frame - 1);
  const crossingCourse = Math.abs(Math.sin(road.tr.h[k] - train.tr.h[k])) > 0.3;
  const failureEstablished = crossingCourse && road.tr.v[k] > SPEED_EPSILON && train.tr.v[k] > SPEED_EPSILON && road.a.railwayContext?.forcedStop !== true;
  const crossingIds = (ctx.scene.railwayCrossings ?? []).filter(c => pointInObb(collision.point, railwayBox(c))).map(c => c.id);
  const specialConduct = ctx.findings.some(f => f.actorId === road.a.id && f.t !== undefined && f.t <= collision.t
    && (f.refs.includes('rule:railway-prohibited-entry') || f.refs.includes('rule:railway-stop') || f.refs.includes('rule:railway-outside'))
    && (crossingIds.includes(String(f.trace?.crossingId)) || f.refs.includes('rule:railway-outside') && f.trace?.railwayTrackId === train.a.railwayTrain?.trackId));
  return { from: road.a.id, to: train.a.id, refs: ['pdd:15.1', ...(specialConduct ? [] : ['rule:railway-other'])], failureEstablished,
    explain: failureEstablished ? `${road.label} пересекает железнодорожные пути перед движущимся поездом и обязан уступить ему по п. 15.1.`
      : 'При пересечении железнодорожных путей уступают поезду (п. 15.1). Данные о пересечении или причине неподвижного положения ТС не позволяют установить нарушение этой обязанности только по столкновению.',
    trace: { frame: k, collisionFrame: collision.frame, trainActorId: train.a.id, roadActorId: road.a.id,
      trainParameters: structuredClone(train.a.railwayTrain), crossingCourse, failureEstablished,
      roadSpeed: road.tr.v[k], trainSpeed: train.tr.v[k], forcedStop: road.a.railwayContext?.forcedStop,
      courseObservationSineThreshold: 0.3, specialConductCoversQualification: specialConduct } };
}
