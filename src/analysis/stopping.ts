import { lawRef } from '../law';
import { inIntersectionBoundary, sidewalkAt, widthsAt } from '../geo';
import { angDiff, dist, distToSegment, dot, fromAngle, nearestOnPolyline, obbCorners, pointInObb, segIntersect, type Vec } from '../geom';
import { vehicleSignalAt } from '../maneuver-signals';
import type { Actor, Scene, Sign, StopContext } from '../scene';
import { DT } from '../sim';
import type { Ctx, Info } from './context';
import { regularRoute, routeSignException } from './route-transport';
import { boxAt, posAt, sampleTrace, tOf } from './technical';
import type { FindingInput, Trace } from './types';
import { dm } from '../dmath';

export type Known = boolean | null;
type Add = (f: FindingInput) => unknown;
export type StopKind = 'stop' | 'parking' | 'forced' | 'traffic' | 'unknown';
export interface StopInterval { from: number; to: number }
export interface StopClassification { kind: StopKind; voluntary: Known; duration: number | null; minimumDuration: number; reason?: StopContext['reason'] }
// Observation tolerances, not legal definitions of stopping or grace periods.
export const REST_SPEED = 0.1;
export const REST_DISPLACEMENT = 0.05;
export const REST_OBSERVATION_SECONDS = 0.5;
const EPS = 1e-6;
const PARKING_SIGNS = ['3.27', '3.28', '3.29', '3.30'];
const and = (...values: Known[]): Known => values.includes(false) ? false : values.includes(null) ? null : true;
const or = (...values: Known[]): Known => values.includes(true) ? true : values.includes(null) ? null : false;
const known = (v: boolean | undefined): Known => v ?? null;
const not = (v: Known): Known => v === null ? null : !v;
const less = (a: number, b: number) => a < b - EPS;

/** A rest interval also requires position stability; creeping is not parking. */
export function stopIntervals(i: Info): StopInterval[] {
  const intervals: StopInterval[] = [];
  let from = -1;
  const flush = (to: number) => {
    if (from >= 0 && (to - from) * DT >= REST_OBSERVATION_SECONDS - EPS) intervals.push({ from, to });
    from = -1;
  };
  for (let k = i.k0; k <= i.kEnd; k++) {
    if (!i.tr.present[k] || Math.abs(i.tr.v[k]) > REST_SPEED) { flush(k - 1); continue; }
    if (from >= 0 && dist(posAt(i, from), posAt(i, k)) > REST_DISPLACEMENT) flush(k - 1);
    if (from < 0) from = k;
  }
  flush(i.kEnd);
  return intervals;
}

/** Exactly 300 seconds is a stop. Unknown earlier duration is an open lower
 * bound, never zero; traffic and forced stops do not become voluntary parking. */
export function classifyStop(a: Actor, interval: StopInterval, frame: number, firstFrame: number): StopClassification {
  const c = a.stopContext, elapsed = Math.max(0, frame - interval.from) * DT;
  const prior = interval.from === firstFrame ? c?.durationBeforeStart : 0;
  const duration = prior === undefined ? null : prior + elapsed;
  const minimumDuration = (prior ?? 0) + elapsed;
  const reason = c?.reason ?? (a.railwayContext?.forcedStop === true ? 'forced' : undefined);
  const result = { duration, minimumDuration, reason };
  if (reason === 'forced' || reason === 'traffic') return { ...result, kind: reason, voluntary: false };
  const voluntary = reason && c?.intentional === true ? true : c?.intentional === false ? false : null;
  if (voluntary !== true) return { ...result, kind: 'unknown', voluntary };
  if (reason === 'passengers' || reason === 'cargo') return { ...result, kind: 'stop', voluntary };
  return { ...result, voluntary, kind: minimumDuration > 300 + EPS ? 'parking' : duration === null ? 'unknown' : 'stop' };
}

/** Minimum planar distance between body and polygon/line, including edge
 * crossings and containment. Distances are from the envelope, never centre. */
export function bodyDistance(i: Info, frame: number, points: Vec[], closed = points.length > 2): number {
  if (!points.length) return Infinity;
  const body = obbCorners(boxAt(i, frame));
  if (points.some(p => pointInObb(p, boxAt(i, frame))) || closed && body.some(p => inIntersectionBoundary(p, points))) return 0;
  let result = Infinity;
  for (let b = 0; b < body.length; b++) {
    const a = body[b], end = body[(b + 1) % body.length];
    if (points.length === 1) result = Math.min(result, distToSegment(points[0], a, end));
    for (let p = 0; p < (closed ? points.length : points.length - 1); p++) {
      const q = points[p], r = points[(p + 1) % points.length];
      if (segIntersect(a, end, q, r)) return 0;
      result = Math.min(result, distToSegment(q, a, end), distToSegment(r, a, end), distToSegment(a, q, r), distToSegment(end, q, r));
    }
  }
  return result;
}

/** UTC arithmetic represents a wall clock supplied as datetime-local. No host
 * timezone, holiday calendar or place timezone is inferred. */
export function stoppingLocalTime(date: string, seconds: number): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(date)) return null;
  const start = new Date(`${date}Z`);
  return Number.isFinite(start.getTime()) ? new Date(start.getTime() + seconds * 1000) : null;
}
function plateSchedule(scene: Scene, sign: Sign, time: Date | null): Known {
  const plates = sign.plates ?? [], p = sign.stopRule;
  if (!plates.some(id => id.startsWith('8.5.'))) return true;
  if (!time) return null;
  const day = time.getUTCDay() || 7, dayStatus = scene.env.dayStatus?.[time.toISOString().slice(0, 10)];
  const results: Known[] = [];
  const composite = plates.some(id => ['8.5.5', '8.5.6', '8.5.7'].includes(id));
  if (composite && !p?.scheduleDays) results.push(null);
  if (plates.includes('8.5.1') || composite && p?.scheduleDays === 'nonworking') results.push(dayStatus ? dayStatus === 'nonworking' : null);
  if (plates.includes('8.5.2') || composite && p?.scheduleDays === 'working') results.push(dayStatus ? dayStatus === 'working' : null);
  if (plates.includes('8.5.3') || composite && p?.scheduleDays === 'weekdays') results.push(p?.weekdays?.length ? p.weekdays.includes(day) : null);
  if (plates.some(id => ['8.5.4', '8.5.5', '8.5.6', '8.5.7'].includes(id))) {
    if (!p?.hours) results.push(null);
    else {
      const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
      const from = minutes(p.hours.from), to = minutes(p.hours.to), now = time.getUTCHours() * 60 + time.getUTCMinutes() + time.getUTCSeconds() / 60;
      results.push(from < to ? now >= from && now < to : now >= from || now < to);
    }
  }
  return and(...results);
}
function signRoad(ctx: Ctx, sign: Sign) {
  return ctx.geo.roads.filter(r => !sign.stopRule?.roadId || sign.stopRule.roadId === r.road.id)
    .map(road => ({ road, near: nearestOnPolyline(road.pts, sign) }))
    .filter(hit => !hit.near.beyond && hit.near.dist < 20).sort((a, b) => a.near.dist - b.near.dist)[0];
}

/** Spatial zones work even when the car starts inside, without a sign gate.
 * A facade plate requires its measured zone; an in-zone repeater alone does
 * not establish the missing beginning of a zone behind it. */
export function parkingSignZone(ctx: Ctx, i: Info, sign: Sign, frame: number, ignoreSide = false): Known {
  const hit = signRoad(ctx, sign);
  if (!hit) return null;
  const { road, near } = hit, body = nearestOnPolyline(road.pts, posAt(i, frame));
  if (body.beyond || Math.abs(body.d) > Math.max(widthsAt(road, body.s).l, widthsAt(road, body.s).r) + i.hw + 5) return false;
  if (Math.abs(near.d) < EPS || Math.abs(body.d) < EPS) return null;
  if (!ignoreSide && near.d * body.d < 0) return false;
  const dir = dot(fromAngle(sign.angle), near.tangent) >= 0 ? 1 : -1;
  if (Math.abs(angDiff(sign.angle, dm.atan2(near.tangent.y, near.tangent.x) + (dir < 0 ? Math.PI : 0))) > 0.6) return null;
  const stations = obbCorners(boxAt(i, frame)).map(point => nearestOnPolyline(road.pts, point).s * dir);
  const station = Math.max(...stations), bodyStart = Math.min(...stations), start = near.s * dir;
  const plates = sign.plates ?? [], custom = sign.stopRule;
  let from = start, to = Infinity;
  if (custom?.fromS !== undefined && custom.toS !== undefined) {
    from = Math.min(custom.fromS * dir, custom.toS * dir); to = Math.max(custom.fromS * dir, custom.toS * dir);
  } else if (plates.some(p => ['8.2.5', '8.2.6'].includes(p))) return null;
  else if (plates.includes('8.2.3')) return false; // The preceding sign is shortened below.
  else if (station < start - EPS && plates.includes('8.2.4')) {
    const earlier = ctx.scene.signs.filter(other => other.id !== sign.id && other.kind === sign.kind
      && !other.plates?.some(p => ['8.2.3', '8.2.4'].includes(p)) && signRoad(ctx, other)?.road === road
      && nearestOnPolyline(road.pts, other).s * dir < start && nearestOnPolyline(road.pts, other).d * near.d > 0);
    return earlier.some(other => parkingSignZone(ctx, i, other, frame) === true) ? true : null;
  }
  if (station < from - EPS) return false;
  if (sign.zoneLen !== undefined && !plates.includes('8.2.4')) to = Math.min(to, from + sign.zoneLen);
  if (plates.some(p => ['8.2.1', '8.2.2'].includes(p)) && sign.zoneLen === undefined && custom?.toS === undefined) return null;
  for (const junction of ctx.geo.intersections) {
    if (!junction.roadIds.includes(road.road.id)) continue;
    const crossingRoads = ctx.geo.roads.filter(other => other !== road && junction.roadIds.includes(other.road.id));
    if (crossingRoads.length && crossingRoads.every(other => other.road.stopZoneJunction === 'nonterminating-minor')) continue;
    const stations = junction.boundary.map(p => nearestOnPolyline(road.pts, p).s * dir);
    const boundary = Math.min(...stations);
    if (boundary > start + EPS) to = Math.min(to, boundary);
  }
  for (const end of ctx.scene.signs) {
    if (end.id === sign.id || !(end.kind === '3.31' || ['5.24.1', '5.24.2'].includes(end.kind)
      || end.kind === sign.kind && end.plates?.includes('8.2.3'))) continue;
    if (signRoad(ctx, end)?.road !== road) continue;
    const e = nearestOnPolyline(road.pts, end);
    if (e.beyond || e.s * dir < start - EPS || Math.abs(e.d) > 20) continue;
    if (Math.abs(angDiff(end.angle, sign.angle)) > 0.6 || end.kind !== '5.24.1' && end.kind !== '5.24.2' && e.d * near.d <= 0) continue;
    to = Math.min(to, e.s * dir);
  }
  return bodyStart < to - EPS;
}

function parkingExemption(ctx: Ctx, i: Info, sign: Sign, frame: number): Known {
  const c = i.a.stopContext;
  if (sign.kind === '3.27') return routeSignException(ctx, i, sign, frame);
  const disabled = and(known(c?.disabilityExemptionEligible), known(c?.disabilityBadge));
  const taxi = ['car', 'suv', 'van'].includes(i.a.type) ? and(known(i.a.routeContext?.taxi), known(c?.taxiMeterOn)) : false;
  return or(disabled, known(c?.postalLiveryEligible), taxi);
}
export function parkingSignApplies(ctx: Ctx, i: Info, sign: Sign, frame: number): Known {
  const zone = parkingSignZone(ctx, i, sign, frame);
  if (zone === false) return false;
  const time = stoppingLocalTime(ctx.scene.env.accidentDate, tOf(frame)), plates = sign.plates ?? [];
  let parity: Known = true;
  if (sign.kind === '3.29' || sign.kind === '3.30') {
    if (!time) parity = null;
    else {
      parity = (time.getUTCDate() % 2 === 1) === (sign.kind === '3.29');
      if (time.getUTCHours() >= 21 && parity) {
        const h = signRoad(ctx, sign);
        const paired = ctx.scene.signs.some(other => {
          if (other.kind !== (sign.kind === '3.29' ? '3.30' : '3.29')) return false;
          const o = signRoad(ctx, other);
          if (!h || !o || h.road !== o.road || h.near.d * o.near.d >= 0) return false;
          return parkingSignZone(ctx, i, other, frame, true) === true;
        });
        if (paired) parity = false;
      }
    }
  }
  const vehicle = plates.some(p => p.startsWith('8.4.')) ? known(i.a.stopContext?.signApplicability?.find(pair => pair.signId === sign.id)?.applies) : true;
  const badge = plates.includes('8.18') ? not(known(i.a.stopContext?.disabilityBadge)) : true;
  return and(zone, parity, plateSchedule(ctx.scene, sign, time), vehicle, badge, not(parkingExemption(ctx, i, sign, frame)));
}

interface PlaceRule { basis: string; ref: string; title: string; prohibited: Known; parkingOnly?: boolean; trace?: Trace }
function placeRules(ctx: Ctx, i: Info, frame: number): PlaceRule[] {
  const c = i.a.stopContext, rules: PlaceRule[] = [], body = obbCorners(boxAt(i, frame)), p = posAt(i, frame);
  const road = ctx.geo.roads.map(r => ({ r, n: nearestOnPolyline(r.pts, p) }))
    .filter(h => !h.n.beyond && h.n.dist <= Math.max(widthsAt(h.r, h.n.s).l, widthsAt(h.r, h.n.s).r) + i.hw)
    .sort((a, b) => a.n.dist - b.n.dist)[0];
  const onRoad = c?.onCarriageway ?? (road ? body.some(q => {
    const n = nearestOnPolyline(road.r.pts, q), w = widthsAt(road.r, n.s);
    return !n.beyond && n.d >= -w.l && n.d <= w.r;
  }) : undefined);
  const add = (basis: string, title: string, prohibited: Known, ref = '12.4', trace?: Trace, parkingOnly = false) => rules.push({ basis, title, prohibited, ref: `pdd:${ref}`, trace, parkingOnly });
  for (const cross of ctx.geo.crosswalks) {
    const d = bodyDistance(i, frame, obbCorners(cross.box));
    const direction = fromAngle(i.tr.h[frame]);
    const forward = dot({ x: cross.box.cx - p.x, y: cross.box.cy - p.y }, direction) > 0;
    if (d <= EPS || forward && less(d, 5)) add('crosswalk', 'переход или ближе 5 м перед ним', true, '12.4', { crosswalkId: cross.item.id, distanceMeters: d, forward });
  }
  for (const cross of ctx.scene.railwayCrossings ?? []) {
    const points = obbCorners({ cx: cross.x, cy: cross.y, a: cross.angle, hl: cross.length / 2, hw: cross.width / 2 });
    const d = bodyDistance(i, frame, points);
    // On-crossing stops remain exclusively with 06.1 / 12.10.
    if (d <= EPS) { add('railway', 'железнодорожный переезд: специальная проверка 06.1', true, '12.4', { crossingId: cross.id, railwayDelegated: true }); continue; }
    if (less(d, 50)) add('railway-near', 'стоянка ближе 50 м от переезда', true, '12.5', { crossingId: cross.id, distanceMeters: d }, true);
  }
  for (const track of ctx.geo.tracks) {
    if (track.item.kind === 'railway') continue;
    const d = bodyDistance(i, frame, track.pts, false);
    if (less(d, 0.76)) add('tram', 'остановка на трамвайных путях', true, '12.4', { trackId: track.item.id, distanceToAxisMeters: d });
  }
  if (c?.tramObstructed !== undefined) add('tram', 'остановка создаёт помеху трамваю', c.tramObstructed);
  for (const stop of ctx.scene.routeStops ?? []) {
    const marker = ctx.scene.signs.find(s => s.id === stop.signId), marking = ctx.scene.markings.find(m => m.id === stop.markingId);
    const hasMarking = marking && ['1.17.1', '1.17.2'].includes(marking.kind) && marking.pts.length;
    if (!hasMarking && (!marker || !['5.16', '5.17', '5.18'].includes(marker.kind))) continue;
    const r = ctx.geo.roads.find(r => r.road.id === stop.roadId);
    if (!r) continue;
    const b = nearestOnPolyline(r.pts, p), s = nearestOnPolyline(r.pts, stop);
    if (b.beyond || s.d * b.d < 0 || b.dist > Math.max(r.half, Math.abs(s.d)) + i.hw + 2) continue;
    const d = bodyDistance(i, frame, hasMarking ? marking!.pts : [marker!], false);
    // Signs sit outside the carriageway: the statutory longitudinal distance
    // is measured from the section through the marker, not across the verge.
    const longitudinal = hasMarking ? d : Math.max(0, Math.abs(b.s - nearestOnPolyline(r.pts, marker!).s) - i.hl);
    if (!less(longitudinal, 15)) continue;
    const regular = regularRoute(i.a), taxi = known(i.a.routeContext?.taxi);
    const designated = hasMarking ? marking!.kind === '1.17.2' ? i.a.type === 'tram' ? regular : false
      : i.a.type === 'tram' || ['bus', 'trolleybus'].includes(i.a.type) ? regular : taxi
      : marker!.kind === '5.18' ? taxi : marker!.kind === '5.17' ? i.a.type === 'tram' ? regular : false
        : ['bus', 'trolleybus'].includes(i.a.type) ? regular : false;
    const passenger = c?.reason === 'passengers' ? known(c.routeTaxiUnimpeded) : false;
    add('route-stop', 'место остановки маршрутных ТС/такси или ближе 15 м', not(or(designated, passenger)), '12.4', { stopId: stop.id, distanceMeters: longitudinal, markingPrimary: !!hasMarking, designatedException: designated, passengerException: passenger });
  }
  const places = (ctx.scene.stopPlaces ?? []).filter(place => place.source.trim() && bodyDistance(i, frame, place.boundary) <= EPS);
  for (const place of places) {
    const trace = { place: structuredClone(place) };
    switch (place.kind) {
      case 'tunnel': add('tunnel', 'остановка в тоннеле', true, '12.4', trace); break;
      case 'under-bridge': add('general', 'остановка под мостом/эстакадой', true, '12.4', trace); break;
      case 'bridge': add('general', 'остановка на мосту при числе полос менее трёх', road ? road.r.road.lanes < 3 : null, '12.4', trace); break;
      case 'dangerous-bend': case 'crest': {
        const sight = c?.visibilityForward !== undefined && c.visibilityForward < 100 || c?.visibilityBackward !== undefined && c.visibilityBackward < 100 ? true
          : c?.visibilityForward !== undefined && c.visibilityBackward !== undefined ? false : null;
        add('general', 'проезжая часть у опасного поворота/перелома при видимости менее 100 м', and(known(onRoad), sight), '12.4', trace); break;
      }
      case 'bicycle-lane': case 'safety-island': add('general', 'остановка на велополосе или островке', true, '12.4', trace); break;
      case 'bicycle-path': case 'pedestrian-ramp': add('general', 'помеха на велодорожке/сопряжении тротуара', place.kind === 'pedestrian-ramp' ? known(c?.pedestriansObstructed) : known(c?.otherAccessBlocked), '12.4', trace); break;
      case 'disabled-parking': add('disabled', 'занятие места для инвалидов без установленного права', not(and(known(c?.disabledParkingEligible), known(c?.disabilityBadge))), '12.2', trace); break;
    }
  }
  for (const place of ctx.scene.stopPlaces ?? []) {
    const d = bodyDistance(i, frame, place.boundary);
    if (place.kind === 'intersection-carriageways' && less(d, 5)) add('general', 'пересечение проезжих частей или ближе 5 м от его края', not(known(c?.tIntersectionOppositeException)), '12.4', { place, distanceMeters: d });
    if (place.kind === 'bicycle-crossing' && less(d, 5)) add('general', 'ближе 5 м до пересечения велодорожки', true, '12.4', { place, distanceMeters: d });
  }
  if (!(ctx.scene.stopPlaces ?? []).some(place => place.kind === 'intersection-carriageways')) {
    const nearby = ctx.geo.intersections.find(junction => bodyDistance(i, frame, junction.boundary) < 5);
    if (nearby) add('general', 'не установлена граница пересекаемой проезжей части для проверки 5 м', null, '12.4', { intersectionId: nearby.id, missingCarriagewayBoundary: true });
  }
  for (const m of ctx.scene.markings.filter(m => ['1.4', '1.10'].includes(m.kind))) {
    // Painted edge proximity is a declared drawing association, not 15 m stop geometry.
    const d = bodyDistance(i, frame, m.pts, false);
    if (d <= 0.5 + EPS) add('sign', `разметка ${m.kind}: ${m.kind === '1.4' ? 'остановка' : 'стоянка'} запрещена`, true, m.kind === '1.4' ? '12.4' : '12.5', { markingId: m.id, markingKind: m.kind, distanceMeters: d, associationToleranceMeters: 0.5 }, m.kind === '1.10');
  }
  for (const m of ctx.scene.markings.filter(m => /^1\.16\./.test(m.kind))) if (m.pts.length >= 3 && bodyDistance(i, frame, m.pts) <= EPS) add('general', 'остановка на направляющем островке/островке безопасности', true, '12.4', { markingId: m.id });
  if (c?.clearanceMeters !== undefined) add('general', 'свободный зазор до сплошной/разделителя/противоположного края менее 3 м', less(c.clearanceMeters, 3), '12.4', { clearanceMeters: c.clearanceMeters, measured: true });
  if (c?.clearanceMeters === undefined && road && onRoad === true) {
    const heading = dm.atan2(road.n.tangent.y, road.n.tangent.x);
    if (Math.abs(dm.sin(i.tr.h[frame] - heading)) < 0.15) {
      const candidates: { basis: string; distance: number }[] = [];
      if (!road.r.road.oneWay && ['solid', 'double'].includes(road.r.road.center)) candidates.push({ basis: `road:${road.r.road.id}:solid-axis`, distance: bodyDistance(i, frame, road.r.pts, false) });
      for (const m of ctx.scene.markings.filter(m => ['1.1', '1.3', '1.11'].includes(m.kind) && m.pts.length >= 2)) {
        const n = nearestOnPolyline(m.pts, p);
        if (!n.beyond && Math.abs(dm.sin(dm.atan2(n.tangent.y, n.tangent.x) - heading)) < 0.15) candidates.push({ basis: `marking:${m.id}`, distance: bodyDistance(i, frame, m.pts, false) });
      }
      if (Math.abs(road.n.d) > EPS) candidates.push({ basis: 'opposite-carriageway-edge', distance: bodyDistance(i, frame, road.n.d > 0 ? road.r.left : road.r.right, false) });
      if (candidates.length) {
        const clearance = candidates.reduce((a, b) => a.distance < b.distance ? a : b);
        add('general', 'свободный зазор до сплошной/разделителя/противоположного края менее 3 м', less(clearance.distance, 3), '12.4', { clearanceMeters: clearance.distance, clearanceGeometry: clearance.basis, candidates, formula: 'minimum planar distance(vehicle envelope, solid line / opposite edge); parallel placement observation' });
      }
    }
  }
  for (const [key, title] of [['signsSignalsBlocked', 'закрыты знаки или сигналы'], ['otherAccessBlocked', 'невозможен проезд, въезд или выезд'], ['pedestriansObstructed', 'создана помеха пешеходам']] as const) if (c?.[key] !== undefined) add(key === 'otherAccessBlocked' && onRoad === true ? 'obstruction' : 'general', title, c[key]!);
  const onSidewalk = body.some(q => sidewalkAt(ctx.geo, q)) || places.some(place => place.kind === 'sidewalk-edge');
  const parkingPlaces = places.filter(place => ['parking', 'sidewalk-edge', 'disabled-parking'].includes(place.kind));
  const parkingSigns = parkingPlaces.flatMap(place => (place.signIds ?? []).map(id => ctx.scene.signs.find(s => s.id === id))).filter((s): s is Sign => !!s && s.kind === '6.4');
  if (!places.some(place => place.kind === 'disabled-parking') && parkingSigns.some(sign => sign.plates?.includes('8.17'))) add('disabled', 'занятие места 6.4 + 8.17 без установленного права', not(and(known(c?.disabledParkingEligible), known(c?.disabilityBadge))), '12.2', { linkedSigns: parkingSigns });
  if (onSidewalk) {
    const cls = c?.registeredClass ?? (i.a.type === 'car' || i.a.type === 'suv' ? 'passenger-car' : i.a.type === 'motorcycle' || i.a.type === 'moped' ? i.a.type : i.a.type === 'van' ? undefined : 'other');
    const eligible = cls === undefined ? null : ['passenger-car', 'motorcycle', 'moped'].includes(cls);
    const arrangement = parkingSigns.some(s => s.plates?.some(p => ['8.6.2', '8.6.3', '8.6.6', '8.6.7', '8.6.8', '8.6.9'].includes(p)));
    // Missing installation evidence is unknown, not proof of absence.
    const allowed = and(eligible, arrangement ? known(c?.parkingArrangementComplied) : c?.parkingArrangementComplied === false ? false : null);
    add('sidewalk', 'постановка на краю тротуара по 6.4 и разрешённой табличке', not(allowed), '12.2', { eligibleClass: cls, linkedSigns: parkingSigns });
  }
  if (c?.rowFromEdge !== undefined) add('row', 'постановка далее первого ряда', c.rowFromEdge <= 1 ? false : c.rowFromEdge === 2 ? not(['car', 'suv', 'van', 'truck', 'bus', 'trolleybus', 'tram', 'cart'].includes(i.a.type) ? false : known(c.twoWheelsWithoutSidecar)) : true, '12.2');
  if (c?.parallelToEdge === false) {
    const angular = parkingSigns.some(s => s.plates?.some(p => /^8\.6\.[4-9]$/.test(p)));
    add('general', 'постановка под углом к краю', not(and(angular ? true : null, known(c.angularParkingGeometrySuitable), known(c.parkingArrangementComplied))), '12.2');
  }
  if (c?.parkingArrangementComplied !== undefined && parkingSigns.length) add('general', 'соблюдение способа постановки по знаку 6.4/табличке/разметке', !c.parkingArrangementComplied, '12.2');
  if (c?.side === 'left') {
    const allowed = road ? road.r.road.zone !== 'outside' && (road.r.road.oneWay || road.r.road.lanes === 1) ? true : false : null;
    const middleTracks = ctx.geo.tracks.some(track => track.item.kind !== 'railway' && road && nearestOnPolyline(road.r.pts, track.pts[0]).dist < 1.5);
    let permitted = and(allowed, road?.r.road.oneWay ? true : !middleTracks);
    if (i.a.type === 'truck' && road?.r.road.oneWay) permitted = and(permitted, c.permissibleMaxMass === undefined ? null : c.permissibleMaxMass > 3500 ? c.reason === 'cargo' : true);
    add('general', 'условия остановки на левой стороне дороги', not(permitted), '12.1');
  }
  if (c?.side === 'right') {
    const permitted = or(known(c.onShoulder), and(not(known(c.shoulderPresent)), known(c.atCarriagewayEdge)), onSidewalk ? null : false);
    add('general', 'правая сторона: обочина либо край при отсутствии обочины', not(permitted), '12.1');
  }
  if (road?.r.road.zone === 'outside') {
    if (c?.reason === 'rest') add('general', 'длительный отдых вне дороги либо на предусмотренной площадке', not(or(known(c.designatedRestArea), known(c.outsideRoad))), '12.3', undefined, true);
    const main = ctx.scene.signs.some(sign => {
      if (sign.kind !== '2.1' || signRoad(ctx, sign)?.road !== road.r) return false;
      const start = nearestOnPolyline(road.r.pts, sign), dir = dot(fromAngle(sign.angle), start.tangent) >= 0 ? 1 : -1;
      if (road.n.s * dir < start.s * dir) return false;
      return !ctx.scene.signs.some(end => end.kind === '2.2' && signRoad(ctx, end)?.road === road.r
        && Math.abs(angDiff(sign.angle, end.angle)) < 0.6 && nearestOnPolyline(road.r.pts, end).s * dir >= start.s * dir
        && nearestOnPolyline(road.r.pts, end).s * dir <= road.n.s * dir);
    });
    if (main) add('general', 'стоянка вне населённого пункта на проезжей части дороги 2.1', known(onRoad), '12.5', undefined, true);
  }
  return rules;
}

function parkingState(c: StopClassification): Known { return c.kind === 'parking' ? true : c.kind === 'unknown' ? null : false; }
function traceFor(ctx: Ctx, i: Info, interval: StopInterval, frame: number, classification: StopClassification): Trace {
  return { ...sampleTrace(ctx, i, frame), stopping: true, stopInterval: interval, classification,
    stopContext: structuredClone(i.a.stopContext), units: { distance: 'm', duration: 's', speed: 'm/s' },
    formula: 'duration = established durationBeforeStart (only initial rest interval) + (frame - from) × DT; parking > 300 s for voluntary non-passenger/non-cargo reason',
    observation: { restSpeed: REST_SPEED, restDisplacement: REST_DISPLACEMENT, restObservationSeconds: REST_OBSERVATION_SECONDS },
    causalAssessment: { status: 'unknown', reason: 'Удар в неподвижное ТС не доказывает причинность остановки. Нужны механизм помехи/закрытия обзора и возможность предотвращения другим участником.' } };
}

function warningChecks(ctx: Ctx, i: Info, frame: number, forbidden: Known, forced: boolean, add: Add): void {
  const w = i.a.warningContext;
  const collision = ctx.tl.collisions.find(c => c.a === i.a.id || c.b === i.a.id);
  const accident = w?.accident === true || !!collision && frame >= collision.frame;
  const hazardRequired = or(accident, w?.dazzled === true, w?.towedMechanical === true, w?.childrenBoardingWithSign === true, w?.otherDanger === true, forced ? forbidden : false);
  const triangleRequired = or(accident, forced ? or(forbidden, w?.timelyVisibleToOthers === false ? true : w?.timelyVisibleToOthers === undefined ? null : false) : false);
  const state = vehicleSignalAt(i.a, tOf(frame), i.tr.waypointTimes ?? []);
  const hazard = w?.hazardAvailable === false ? false : state.source === 'none' ? null : state.signal === 'hazard';
  const trace: Trace = { stopping: true, warningOnly: true, warningContext: structuredClone(w), vehicleSignal: state,
    hazardRequired, triangleRequired, forbiddenPlace: forbidden, forced, accident,
    timingLimit: 'ПДД не задают числового срока «незамедлительно»; оценивается только установленный факт', units: { distance: 'm' } };
  const emit = (ref: string, title: string, complied: Known, extra: Trace = {}) => add({ actorId: i.a.id, t: tOf(frame), causal: false,
    severity: complied === false ? 'violation' : complied === true ? 'info' : 'contributing', title,
    detail: 'Проверка по установленным фактам. Минимальное расстояние не заменяет своевременного предупреждения. Неизвестное не считается невыполнением.',
    refs: [`pdd:${ref}`], trace: { ...trace, ...extra, warningOffence: complied === false, compliance: complied === true ? 'выполнено' : complied === false ? 'не выполнено' : 'не определить' } });
  if (hazardRequired === true) emit('7.1', 'аварийная сигнализация при ДТП/опасности/вынужденной остановке', hazard);
  else if (hazardRequired === null && forced) emit('7.1', 'не установлена обязательность аварийной сигнализации в этом месте', null);
  if (triangleRequired === false) return;
  if (triangleRequired === null) { emit('7.2', 'не установлены условия обязательного треугольника', null); return; }
  const roads = ctx.geo.roads.filter(r => !nearestOnPolyline(r.pts, posAt(i, frame)).beyond && nearestOnPolyline(r.pts, posAt(i, frame)).dist < r.half + i.hw + 5);
  const outside = roads.length && roads.every(r => r.road.zone === 'outside') ? true : roads.some(r => r.road.zone !== 'outside') ? false : null;
  const minimum = outside === null ? null : outside ? 30 : 15;
  const distance = w?.triangle ? bodyDistance(i, frame, [w.triangle]) : w?.triangleDistance;
  const distanceOK: Known = distance === undefined || minimum === null ? null : distance + EPS >= minimum;
  const complied = and(known(w?.trianglePlaced), distanceOK, known(w?.trianglePromptly), known(w?.timelyWarningEnsured));
  emit('7.2', 'знак аварийной остановки: наличие, незамедлительность и расстояние 15/30 м', complied,
    { triangleDistanceMeters: distance, minimumMeters: minimum, distanceOK, distanceFormula: w?.triangle ? 'min distance(point, vehicle envelope)' : 'established measured distance from vehicle envelope' });
}

function personalChecks(i: Info, parked: Known, frame: number, add: Add): void {
  const d = i.a.doorContext, c = i.a.stopContext;
  const emit = (ref: string, title: string, complied: Known, trace: Trace) => add({ actorId: i.a.id, severity: complied === true ? 'info' : complied === false ? 'violation' : 'contributing', t: tOf(frame), causal: false,
    title, detail: 'Оцениваются явно установленные обстоятельства. Отдельная геометрия двери и контакт с ней не моделируются. Субъект и состав ответственности требуют юридической проверки.', refs: [`pdd:${ref}`],
    trace: { stopping: true, personalDuty: true, ...trace, compliance: complied === true ? 'выполнено' : complied === false ? 'не выполнено' : 'не определить', legalCheck: 'TODO(legal-check): субъект и состав за дверь/уход водителя/оставление ребёнка; водительская 12.19 автоматически не назначается', doorGeometryModeled: false } });
  if (d?.opened === true) emit('12.7', 'открывание двери с учётом помехи другим участникам', not(known(d.createsObstruction)), { personalDutyKind: 'door', doorContext: structuredClone(d), contactProven: false });
  if (c?.driverLeft === true) {
    emit('12.8', 'меры против самопроизвольного движения и использования без водителя', and(known(c.rollawaySecured), known(c.unauthorizedUsePrevented)), { personalDutyKind: 'driver-left', stopContext: structuredClone(c) });
    if (c.childUnder7Present === true) emit('12.8', 'ребёнок младше 7 лет при стоянке остаётся со взрослым', parked === true ? known(c.adultPresent) : parked === null ? null : true, { personalDutyKind: 'child-left', parked, stopContext: structuredClone(c) });
  }
}

/** Entry point: no dependency on crossing a sign during the simulated time. */
export function checkStopping(ctx: Ctx, add: Add): void {
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || i.a.railwayTrain || i.k0 > i.kEnd) continue;
    const emitted = new Set<string>();
    const emit: Add = f => {
      const key = JSON.stringify([f.title, f.severity, f.trace?.stoppingBasis, f.trace?.signId, f.trace?.placeId, f.trace?.minimumMeters]);
      if (emitted.has(key)) return;
      emitted.add(key); add(f);
    };
    let lastParked: Known = null;
    for (const interval of stopIntervals(i)) {
      // Evaluate each minute boundary, classification threshold and both ends.
      // Schedules and odd/even dates use local time, including midnight.
      const frames = new Set([interval.from, interval.to]);
      const prior = interval.from === i.k0 ? i.a.stopContext?.durationBeforeStart ?? 0 : 0;
      const threshold = interval.from + Math.floor((300 - prior) / DT) + 1;
      if (threshold >= interval.from && threshold <= interval.to) frames.add(threshold);
      const local = stoppingLocalTime(ctx.scene.env.accidentDate, tOf(interval.from));
      if (local) {
        const nextMinute = 60 - local.getUTCSeconds() - local.getUTCMilliseconds() / 1000;
        for (let k = interval.from + Math.ceil(nextMinute / DT); k <= interval.to; k += Math.round(60 / DT)) frames.add(k);
      }
      for (const frame of [...frames].sort((a, b) => a - b)) {
        const classification = classifyStop(i.a, interval, frame, i.k0), trace = traceFor(ctx, i, interval, frame, classification);
        lastParked = parkingState(classification);
        emit({ actorId: i.a.id, severity: classification.kind === 'unknown' ? 'contributing' : 'info', t: tOf(frame),
          title: `прекращение движения: ${classification.kind}`, detail: 'Причина и преднамеренность устанавливаются по исходным материалам. Стоянка — более 5 минут по причинам, не связанным с посадкой/высадкой или грузом; время до начала включается только при его известности.', refs: ['pdd:1.2'], trace });
        const rules = placeRules(ctx, i, frame);
        for (const sign of ctx.scene.signs.filter(s => PARKING_SIGNS.includes(s.kind))) {
          const applies = parkingSignApplies(ctx, i, sign, frame);
          if (parkingSignZone(ctx, i, sign, frame) === false) continue;
          rules.push({ basis: 'sign', title: `зона знака ${sign.kind}`, ref: `sign:${sign.kind}`, prohibited: applies, parkingOnly: sign.kind !== '3.27', trace: { signId: sign.id, sign: structuredClone(sign), signApplies: applies, localTime: stoppingLocalTime(ctx.scene.env.accidentDate, tOf(frame))?.toISOString().replace('Z', '') } });
        }
        for (const rule of rules) {
          if (rule.trace?.railwayDelegated) continue;
          if (classification.kind === 'traffic') continue;
          const applicable = rule.parkingOnly ? lastParked : classification.voluntary;
          const prohibited = and(rule.prohibited, applicable);
          const forced = classification.kind === 'forced';
          if (forced) continue; // Separate 12.6, 7.1, 7.2; no automatic absolution of those duties.
          const complied = not(prohibited);
          emit({ actorId: i.a.id, severity: complied === false ? 'violation' : complied === true ? 'info' : 'contributing', t: tOf(frame), causal: false,
            title: rule.title, detail: 'Проверка места остановки/стоянки по габариту ТС и установленным обстоятельствам. Причинность ДТП оценивается отдельно; контакт сам по себе её не устанавливает.', refs: [rule.ref, ...(rule.trace?.markingKind ? [`marking:${rule.trace.markingKind}`] : [])],
            trace: { ...trace, ...rule.trace, norm: lawRef(rule.ref, ctx.scene.env.accidentDate), stoppingBasis: rule.basis, parkingOnly: !!rule.parkingOnly, compliance: complied === true ? 'выполнено' : complied === false ? 'не выполнено' : 'не определить' } });
        }
        // The sign's geometric prohibition remains relevant to a forced stop
        // even though no voluntary-parking offence is inferred.
        const detected = rules.filter(rule => !rule.parkingOnly).map(rule => rule.prohibited);
        const forbidden = i.a.stopContext?.stoppingProhibited ?? (detected.includes(true) ? true : null);
        if (classification.kind === 'forced') {
          const c = i.a.stopContext;
          const measures = known(c?.relocationMeasuresTaken);
          const required = forbidden;
          if (required !== false) emit({ actorId: i.a.id, severity: required === true && c?.relocationPossible === true && measures === false ? 'violation' : required === true && measures === true ? 'info' : 'contributing', t: tOf(frame), causal: false,
            title: 'меры для отвода ТС из запрещённого места', detail: 'Необходимость мер по п. 12.6 не означает установленной возможности эвакуации; нулевая скорость не доказывает бездействие.', refs: ['pdd:12.6'], trace: { ...trace, forbidden, relocationPossible: c?.relocationPossible, relocationMeasuresTaken: c?.relocationMeasuresTaken, compliance: measures === true ? 'выполнено' : 'не определить', legalCheck: 'TODO(legal-check): квалификация невыполнения 12.6' } });
        }
        if (frame === interval.to && (classification.kind === 'forced' || i.a.warningContext)) warningChecks(ctx, i, frame, forbidden, classification.kind === 'forced', emit);
      }
    }
    personalChecks(i, lastParked, i.k0, emit);
    const collision = ctx.tl.collisions.find(c => c.a === i.a.id || c.b === i.a.id);
    if (collision) warningChecks(ctx, i, i.kEnd, null, false, emit);
    else if (i.a.warningContext && !stopIntervals(i).length) warningChecks(ctx, i, i.k0, null, false, emit);
  }
}

