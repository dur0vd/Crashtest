import { intersectionAt, roadsAt, widthsAt, type RoadGeo } from '../geo';
import { angDiff, dist, distToSegment, dot, fromAngle, nearestOnPolyline, obbCorners, segIntersect, toLocal, type NearestInfo } from '../geom';
import type { Actor, RouteLane, RouteStop, Sign } from '../scene';
import { DT, type Collision } from '../sim';
import { movementPermission } from '../traffic-control';
import type { Ctx, Info } from './context';
import { boxAt, posAt, sampleTrace, tOf } from './technical';
import type { FindingInput, Trace } from './types';
import { specialPairState, specialPriority } from './special-signals';
import { dm } from '../dmath';

type Add = (finding: FindingInput) => unknown;
// Detection settings, not statutory dimensions or times for yielding.
const REST_SPEED = 0.1;
const REST_OBSERVATION_SECONDS = 0.5;
const APPROACH_RANGE = 45;
const DEPARTURE_OBSERVATION_METERS = 35;
const DEPARTURE_OBSERVATION_SECONDS = 8;
const LANE_OBSERVATION_SECONDS = 0.25;
const ENTRY_CLEARANCE_EXTRA_METERS = 8;
const LATERAL_OBSERVATION_METERS = 0.02;
const INTERFERENCE_WINDOW_SECONDS = 0.5;
const INTERFERENCE_DECELERATION = 1.5;
const ROUTE_SIGNS = new Set(['5.11.1', '5.13.1', '5.13.2', '5.14', '5.14.1']);
const REGULAR_TYPES = new Set(['bus', 'trolleybus', 'tram']);

export interface RouteLaneHit {
  road: RoadGeo;
  lane: RouteLane;
  near: NearestInfo;
  /** Course relative to the authored road axis. */
  forward: boolean;
  signs: Sign[];
}

export function regularRoute(a: Actor): boolean | null {
  if (a.kind !== 'vehicle' || a.railwayTrain || !REGULAR_TYPES.has(a.type)) return false;
  return a.routeContext?.regularService ?? null;
}

function laneSigns(ctx: Ctx, lane: RouteLane): Sign[] {
  return lane.signIds.map(id => ctx.scene.signs.find(sign => sign.id === id)).filter((sign): sign is Sign => !!sign);
}

/** Shared analysis/render geometry; only explicitly linked, oriented end signs
 * shorten the authored lane interval. */
export function effectiveRouteLaneStations(sceneSigns: Sign[], road: RoadGeo, lane: RouteLane): { from: number; to: number } {
  let from = lane.fromS, to = lane.toS;
  for (const sign of sceneSigns.filter(sign => lane.signIds.includes(sign.id) && sign.kind === '5.14.3')) {
    const stop = nearestOnPolyline(road.pts, sign);
    if (stop.s < from || stop.s > to || stop.beyond) continue;
    const course = dm.atan2(stop.tangent.y, stop.tangent.x) + (lane.direction === 'reverse' ? Math.PI : 0);
    if (Math.abs(angDiff(sign.angle, course)) > 0.6) continue;
    if (lane.direction === 'forward') to = Math.min(to, stop.s);
    else from = Math.max(from, stop.s);
  }
  return { from, to };
}

/** Explicit lane geometry is not inferred from a painted bus symbol alone. */
export function routeLaneAt(ctx: Ctx, i: Info, frame: number): RouteLaneHit | null {
  const k = Math.max(i.k0, Math.min(i.kEnd, frame));
  if (k >= ctx.tl.n || !i.tr.present[k]) return null;
  for (const road of ctx.geo.roads) {
    if (!road.road.routeLanes?.length || road.pts.length < 2) continue;
    const near = nearestOnPolyline(road.pts, posAt(i, k));
    if (near.beyond) continue;
    const corners = obbCorners(boxAt(i, k)).map(point => nearestOnPolyline(road.pts, point));
    for (const lane of road.road.routeLanes) {
      const signs = laneSigns(ctx, lane);
      const forward = dot(fromAngle(i.tr.h[k]), near.tangent) >= 0;
      const { from, to } = effectiveRouteLaneStations(ctx.scene.signs, road, lane);
      // TODO(legal-check): point 18.2 still names 5.14, while the sign corpus
      // uses 5.14.1. Both are accepted, without inventing a historical edition.
      const dMin = Math.min(...corners.map(corner => corner.d)), dMax = Math.max(...corners.map(corner => corner.d));
      const sMin = Math.min(...corners.map(corner => corner.s)), sMax = Math.max(...corners.map(corner => corner.s));
      if (sMax <= from || sMin >= to || dMax <= lane.offset - lane.width / 2 + 0.05
        || dMin >= lane.offset + lane.width / 2 - 0.05) continue;
      return { road, lane, near, forward, signs };
    }
  }
  return null;
}

export function routeLaneDirectionMatches(hit: RouteLaneHit): boolean {
  return hit.forward === (hit.lane.direction === 'forward');
}

function rightmost(hit: RouteLaneHit): boolean {
  if (hit.lane.rightmost !== undefined) return hit.lane.rightmost;
  const width = widthsAt(hit.road, hit.near.s);
  const outer = hit.lane.direction === 'forward' ? hit.lane.offset + hit.lane.width / 2
    : -hit.lane.offset + hit.lane.width / 2;
  const edge = hit.lane.direction === 'forward' ? width.r : width.l;
  return Math.abs(outer - edge) <= 0.15;
}

/** Admission is a legal fact; catalogue 'route' is only a vehicle class. */
export function routeLanePermission(ctx: Ctx, i: Info, hit: RouteLaneHit): boolean | null {
  if (!hit.signs.some(sign => ROUTE_SIGNS.has(sign.kind))) return null;
  if (!i.isVeh || i.a.railwayTrain) return false;
  const a = i.a, facts = a.routeContext;
  if (a.type === 'bicycle') return rightmost(hit);
  const regular = regularRoute(a);
  const school = a.type === 'bus' || a.type === 'van' ? facts?.schoolBus ?? null : false;
  const taxi = ['car', 'suv', 'van'].includes(a.type) ? facts?.taxi ?? null : false;
  const regional = ['bus', 'van', 'trolleybus'].includes(a.type) ? facts?.regionalBusLaneEligible ?? null : false;
  if (regular === true || school === true || taxi === true) return true;
  const federal = ctx.scene.env.federalCity;
  if (regional === true && federal && federal !== 'other') return true;
  const regionalUnknown = regional === true ? federal === undefined : regional === null && federal !== 'other';
  if (regular === null || school === null || taxi === null || regionalUnknown) return null;
  return false;
}

/** true/null suppress the ordinary wrong-way claim while the dedicated lane
 * admission is established/unknown; false leaves the ordinary restriction. */
export function admittedRouteDirection(ctx: Ctx, i: Info, frame: number): boolean | null {
  const hit = routeLaneAt(ctx, i, frame);
  if (!hit || !routeLaneDirectionMatches(hit) || !hit.signs.some(sign => ROUTE_SIGNS.has(sign.kind))) return false;
  // Touching a permitted lane with one corner does not legalise the rest of
  // the vehicle occupying another opposing lane.
  if (!containsBody(i, hit, frame)) return false;
  return routeLanePermission(ctx, i, hit);
}

function containsBody(i: Info, hit: RouteLaneHit, frame: number): boolean {
  return obbCorners(boxAt(i, frame)).every(point => {
    const near = nearestOnPolyline(hit.road.pts, point);
    return !near.beyond && near.s >= hit.lane.fromS - 0.05 && near.s <= hit.lane.toS + 0.05
      && Math.abs(near.d - hit.lane.offset) <= hit.lane.width / 2 + 0.05;
  });
}

function markerMatches(ctx: Ctx, stop: RouteStop, purpose: 'bus' | 'tram' | 'taxi'): boolean {
  const sign = ctx.scene.signs.find(item => item.id === stop.signId);
  const marking = ctx.scene.markings.find(item => item.id === stop.markingId);
  if (purpose === 'taxi') return sign?.kind === '5.18' || marking?.kind === '1.17.1';
  if (purpose === 'tram') return sign?.kind === '5.17' || marking?.kind === '1.17.1' || marking?.kind === '1.17.2';
  return sign?.kind === '5.16' || marking?.kind === '1.17.1';
}

function nearStop(ctx: Ctx, i: Info, stop: RouteStop, frame: number): boolean {
  if (Math.abs(angDiff(i.tr.h[frame], stop.heading)) > 0.6 || dist(posAt(i, frame), stop) > i.hl + 4) return false;
  return ctx.geo.roads.some(road => road.road.id === stop.roadId && nearestOnPolyline(road.pts, posAt(i, frame)).dist <= Math.max(road.half, Math.abs(nearestOnPolyline(road.pts, stop).d)) + i.hw);
}

export function routeSignException(ctx: Ctx, i: Info, sign: Sign, frame: number): boolean | null {
  if (!i.isVeh || i.a.railwayTrain) return false;
  const regular = regularRoute(i.a);
  if (['3.1', '3.2', '3.3', '3.18.1', '3.18.2', '3.19', '3.34', '5.15.1', '5.15.2'].includes(sign.kind)) {
    if (sign.kind === '3.34' && i.a.routeContext?.schoolBus === true) return true;
    if (regular === true) return true;
    if (regular === null || sign.kind === '3.34' && i.a.routeContext?.schoolBus === undefined && i.a.type === 'bus') return null;
    if (sign.kind === '5.15.1' || sign.kind === '5.15.2') return continuesRouteLane(ctx, i, frame);
    return false;
  }
  if (/^4\.1\.[1-6]$/.test(sign.kind)) {
    // Group 4 expressly exempts regular route vehicles independently of 18.2.
    if (regular === true) return true;
    const continuing = continuesRouteLane(ctx, i, frame);
    return continuing === true ? true : regular === null ? null : continuing;
  }
  if (sign.kind !== '3.27') return false;
  const kind = i.a.type === 'tram' ? 'tram' : 'bus';
  const stops = (ctx.scene.routeStops ?? []).filter(stop => nearStop(ctx, i, stop, frame));
  // The 3.27 note specifically lists 1.17.1 and signs 5.16–5.18. The separate
  // tram-stop marking 1.17.2 in section 12 does not expand this sign exception.
  const routePlace = stops.some(stop => markerMatches(ctx, stop, kind)
    && (ctx.scene.markings.some(marking => marking.id === stop.markingId && marking.kind === '1.17.1')
      || ctx.scene.signs.some(marker => marker.id === stop.signId && (kind === 'tram' ? marker.kind === '5.17' : marker.kind === '5.16'))));
  const taxiPlace = stops.some(stop => markerMatches(ctx, stop, 'taxi'));
  const taxi = ['car', 'suv', 'van'].includes(i.a.type) ? i.a.routeContext?.taxi ?? null : false;
  if (routePlace && regular === true || taxiPlace && taxi === true) return true;
  return routePlace && regular === null || taxiPlace && taxi === null ? null : false;
}

export function continuesRouteLane(ctx: Ctx, i: Info, frame: number): boolean | null {
  const hit = routeLaneAt(ctx, i, frame);
  if (!hit || !routeLaneDirectionMatches(hit)) return false;
  const admitted = routeLanePermission(ctx, i, hit);
  if (admitted === false) return false;
  // The exception requires entry into a junction and continuing on this lane,
  // not an arbitrary turn by any admitted vehicle anywhere on the road.
  let junctionId: string | undefined, lastInside = -1;
  for (let k = Math.max(i.k0, frame); k <= i.kEnd; k += 4) {
    if (!i.tr.present[k]) continue;
    const junction = intersectionAt(ctx.geo, posAt(i, k));
    if (!junctionId && junction) junctionId = junction.id;
    if (!junctionId) continue;
    if (junction?.id === junctionId) { lastInside = k; continue; }
    if (lastInside < 0) continue;
    const then = routeLaneAt(ctx, i, k);
    if (!then || then.road.road.id !== hit.road.road.id || then.lane.id !== hit.lane.id
      || !routeLaneDirectionMatches(then) || !containsBody(i, then, k)) return false;
    // Progress on the approach cannot establish continuation after the junction.
    if (i.trav[k] - i.trav[lastInside] > 4) return admitted;
  }
  return false;
}

interface Departure { stop: RouteStop; road: RoadGeo; restFrame: number; startFrame: number; endFrame: number }
const departureCache = new WeakMap<Ctx, Map<string, Departure | null>>();

export function routeDeparture(ctx: Ctx, i: Info): Departure | null {
  let cache = departureCache.get(ctx);
  if (!cache) { cache = new Map(); departureCache.set(ctx, cache); }
  if (cache.has(i.a.id)) return cache.get(i.a.id)!;
  cache.set(i.a.id, null);
  if (!i.isVeh || !['bus', 'trolleybus'].includes(i.a.type) || i.a.railwayTrain) return null;
  const selected = i.a.routeContext?.departureStopId;
  const stops = (ctx.scene.routeStops ?? []).filter(stop => (!selected || stop.id === selected) && markerMatches(ctx, stop, 'bus'));
  for (const stop of stops) {
    const road = ctx.geo.roads.find(road => road.road.id === stop.roadId);
    if (!road || road.road.zone === 'outside') continue;
    let rest = -1, count = 0;
    for (let k = i.k0; k <= i.kEnd; k++) {
      if (!i.tr.present[k]) { count = 0; rest = -1; continue; }
      if (i.tr.v[k] <= REST_SPEED && nearStop(ctx, i, stop, k)) {
        if (!count) rest = k;
        count++;
      } else if (count * DT >= REST_OBSERVATION_SECONDS && i.tr.v[k] > REST_SPEED && !i.tr.reversing?.[k]) {
        let endFrame = k;
        while (endFrame < i.kEnd && (endFrame - k) * DT < DEPARTURE_OBSERVATION_SECONDS
          && i.trav[endFrame] - i.trav[k] < DEPARTURE_OBSERVATION_METERS) endFrame++;
        const departure = { stop, road, restFrame: rest, startFrame: k, endFrame };
        cache.set(i.a.id, departure);
        return departure;
      } else { count = 0; rest = -1; }
    }
  }
  return null;
}

function routeConflict(a: Info, b: Info): boolean {
  const A = [{ x: a.a.x, y: a.a.y }, ...a.a.path], B = [{ x: b.a.x, y: b.a.y }, ...b.a.path];
  for (let x = 1; x < A.length; x++) for (let y = 1; y < B.length; y++) {
    if (segIntersect(A[x - 1], A[x], B[y - 1], B[y])) return true;
    if (distToSegment(A[x], B[y - 1], B[y]) < a.hw + b.hw || distToSegment(B[y], A[x - 1], A[x]) < a.hw + b.hw) return true;
  }
  return false;
}

function contactBetween(ctx: Ctx, a: Info, b: Info): Collision | undefined {
  return ctx.tl.collisions.find(c => c.a === a.a.id && c.b === b.a.id || c.a === b.a.id && c.b === a.a.id);
}

function departureEncounter(ctx: Ctx, bus: Info, other: Info, departure: Departure): number | null {
  const contact = contactBetween(ctx, bus, other);
  if (contact && contact.frame >= departure.startFrame && contact.frame <= departure.endFrame) return Math.max(bus.k0, other.k0, contact.frame - 1);
  if (!routeConflict(bus, other)) return null;
  let previous = Infinity;
  for (let k = Math.max(bus.k0, other.k0, departure.restFrame); k <= Math.min(bus.kEnd, other.kEnd, departure.endFrame); k += 4) {
    if (!bus.tr.present[k] || !other.tr.present[k]) continue;
    const distance = dist(posAt(bus, k), posAt(other, k)), closing = distance < previous - 0.01;
    previous = distance;
    const sameRoad = roadsAt(ctx.geo, posAt(other, k), other.hw).some(hit => hit.rg.road.id === departure.road.road.id);
    if (sameRoad && closing && distance <= APPROACH_RANGE && other.tr.v[k] > REST_SPEED) return k;
  }
  return null;
}

export interface RoutePriority {
  from: string; to: string; refs: string[]; explain: string; trace: Trace; failureEstablished: boolean;
}

export function routePriority(ctx: Ctx, a: string, b: string, col: Collision): RoutePriority | null {
  const A = ctx.infos.get(a), B = ctx.infos.get(b);
  if (!A || !B || !A.isVeh || !B.isVeh || A.a.railwayTrain || B.a.railwayTrain) return null;
  const DA = routeDeparture(ctx, A), DB = routeDeparture(ctx, B);
  const activeA = DA && col.frame >= DA.startFrame && col.frame <= DA.endFrame;
  const activeB = DB && col.frame >= DB.startFrame && col.frame <= DB.endFrame;
  if (!!activeA !== !!activeB) {
    const [bus, other, departure] = activeA ? [A, B, DA!] : [B, A, DB!];
    const k = Math.max(bus.k0, other.k0, col.frame - 1);
    const behindBus = toLocal(posAt(other, k), { cx: bus.tr.x[k], cy: bus.tr.y[k], a: bus.tr.h[k] }).x < -bus.hl - other.hl;
    const failureEstablished = other.tr.v[k] > REST_SPEED && !other.tr.reversing?.[k] && !behindBus;
    return { from: other.a.id, to: bus.a.id, refs: ['pdd:18.3', 'rule:route-priority'], failureEstablished,
      explain: `${other.label} уступает ${bus.label}, начинающему движение от обозначенной остановки в населённом пункте. Водитель автобуса или троллейбуса отдельно обязан убедиться в уступании.`,
      trace: { frame: k, collisionFrame: col.frame, departure: structuredClone(departure), otherSpeed: other.tr.v[k],
        departureVerification: structuredClone(bus.a.routeContext?.departureChecks?.find(check => check.otherId === other.a.id)),
        observationMeters: DEPARTURE_OBSERVATION_METERS, observationSeconds: DEPARTURE_OBSERVATION_SECONDS } };
  }
  if (intersectionAt(ctx.geo, col.point)) return null;
  const tramA = A.a.type === 'tram', tramB = B.a.type === 'tram';
  if (tramA === tramB) return null;
  const [tram, other] = tramA ? [A, B] : [B, A];
  if (other.rail || tram.a.routeContext?.depotExit === true) return null;
  const k = Math.max(tram.k0, other.k0, col.frame - 1);
  const crosses = Math.abs(dm.sin(tram.tr.h[k] - other.tr.h[k])) > 0.3;
  const rails = ctx.geo.tracks.some(track => track.item.kind !== 'railway' && track.pts.length >= 2
    && nearestOnPolyline(track.pts, col.point).dist <= tram.hw + other.hw + 1);
  if (!crosses || !rails || !roadsAt(ctx.geo, col.point, other.hw).length) return null;
  const known = tram.a.routeContext?.depotExit === false;
  return { from: other.a.id, to: tram.a.id, refs: ['pdd:18.1'], failureEstablished: known && other.tr.v[k] > REST_SPEED && tram.tr.v[k] > REST_SPEED,
    explain: known ? `${other.label} вне перекрёстка уступает трамваю в месте пересечения путей и проезжей части; выезд из депо явно исключён.`
      : 'Для применения преимущества трамвая вне перекрёстка нужно исключить выезд из депо; это обстоятельство не установлено.',
    trace: { frame: k, depotExit: tram.a.routeContext?.depotExit, crossingCourse: crosses,
      standaloneQualification: 'TODO(legal-check): часть КоАП для самостоятельного нарушения 18.1 требует отдельной проверки' } };
}

interface LaneEpisode { first: number; last: number }
const laneEpisodeCache = new WeakMap<Ctx, Map<string, LaneEpisode[]>>();
const laneKey = (hit: RouteLaneHit): string => `${hit.road.road.id}/${hit.lane.id}`;

function laneEpisode(ctx: Ctx, i: Info, hit: RouteLaneHit, frame: number): LaneEpisode {
  let cache = laneEpisodeCache.get(ctx);
  if (!cache) { cache = new Map(); laneEpisodeCache.set(ctx, cache); }
  const key = `${i.a.id}/${laneKey(hit)}`;
  let episodes = cache.get(key);
  if (!episodes) {
    episodes = [];
    let first = -1;
    for (let k = i.k0; k <= i.kEnd + 1; k++) {
      const observed = k <= i.kEnd ? routeLaneAt(ctx, i, k) : null;
      if (observed && laneKey(observed) === laneKey(hit)) {
        if (first < 0) first = k;
      } else if (first >= 0) {
        episodes.push({ first, last: k - 1 });
        first = -1;
      }
    }
    cache.set(key, episodes);
  }
  return episodes.find(episode => episode.first <= frame && episode.last >= frame) ?? { first: frame, last: frame };
}

function temporaryManeuver(ctx: Ctx, i: Info, hit: RouteLaneHit, frame: number): boolean {
  const use = i.a.routeContext?.laneUse;
  if (!use || use === 'through') return false;
  const episode = laneEpisode(ctx, i, hit, frame);
  if (use === 'enter-road') {
    // Locate a real transition onto this road, then measure clearance from
    // that fixed event. A rolling time window would admit slow transit forever.
    let entry = -1;
    let previouslyOnRoad = roadsAt(ctx.geo, posAt(i, i.k0)).some(road => road.rg.road.id === hit.road.road.id);
    for (let k = i.k0 + 1; k <= Math.min(episode.last, episode.first + Math.ceil(3 / DT)); k++) {
      const nowOnRoad = roadsAt(ctx.geo, posAt(i, k)).some(road => road.rg.road.id === hit.road.road.id);
      if (nowOnRoad && !previouslyOnRoad) entry = k;
      previouslyOnRoad = nowOnRoad;
      if (k >= episode.first && entry >= 0) break;
    }
    if (entry < 0) return false;
    return i.trav[frame] - i.trav[entry] <= 2 * i.hl + ENTRY_CLEARANCE_EXTRA_METERS;
  }
  if (use === 'turn') {
    // Following a bend of the same road changes world heading but is not a
    // turn off that road. Require the observed route to actually leave it.
    const end = Math.min(i.kEnd, episode.last + Math.ceil(3 / DT));
    for (let k = frame; k <= end; k += 4) {
      if (!i.tr.present[k]) continue;
      const near = nearestOnPolyline(hit.road.pts, posAt(i, k));
      const width = widthsAt(hit.road, near.s);
      const outside = near.beyond || near.d < -width.l - i.hw || near.d > width.r + i.hw;
      if (outside && Math.abs(angDiff(i.tr.h[k], dm.atan2(near.tangent.y, near.tangent.x))) > 0.4) return true;
    }
    return false;
  }
  if (use === 'passenger-stop') {
    if (!rightmost(hit)) return false;
    let stopFirst = -1, stopLast = -1;
    for (let k = episode.first; k <= episode.last; k++) {
      if (i.tr.v[k] <= REST_SPEED) {
        if (stopFirst < 0) stopFirst = k;
        stopLast = k;
      } else if (stopFirst >= 0 && (stopLast - stopFirst + 1) * DT >= REST_OBSERVATION_SECONDS) break;
      else { stopFirst = -1; stopLast = -1; }
    }
    if (stopFirst < 0 || (stopLast - stopFirst + 1) * DT < REST_OBSERVATION_SECONDS) return false;
    if (frame <= stopLast) return true;
    // The passenger stop includes its continuous clearance manoeuvre. It does
    // not permit a new trip along the lane after boarding has finished.
    if (episode.last >= i.kEnd) return false;
    let firstMoving = -1, firstLateral = -1;
    const stoppedOffset = nearestOnPolyline(hit.road.pts, posAt(i, stopLast)).d;
    for (let k = stopLast + 1; k <= episode.last; k++) {
      if (firstMoving < 0 && i.tr.v[k] > REST_SPEED) firstMoving = k;
      if (Math.abs(nearestOnPolyline(hit.road.pts, posAt(i, k)).d - stoppedOffset) > LATERAL_OBSERVATION_METERS) {
        firstLateral = k;
        break;
      }
    }
    return firstMoving >= 0 && firstLateral >= firstMoving
      && i.trav[firstLateral] - i.trav[firstMoving] <= Math.max(1, i.hw);
  }
  return false;
}

function temporaryUse(ctx: Ctx, i: Info, hit: RouteLaneHit, frame: number): boolean | null {
  // The label alone cannot make an ordinary through movement uncertain or
  // exempt. First establish the corresponding observed manoeuvre.
  if (!temporaryManeuver(ctx, i, hit, frame)) return false;
  if (hit.lane.boundary !== 'dashed') return hit.lane.boundary === 'unknown' || hit.lane.boundary === undefined ? null : false;
  return i.a.routeContext?.routeVehiclesUnimpeded ?? null;
}

function laneChecks(ctx: Ctx, i: Info, add: Add): void {
  const seen = new Set<string>();
  for (let k = i.k0; k <= i.kEnd; k++) {
    const hit = routeLaneAt(ctx, i, k);
    if (!hit || seen.has(laneKey(hit))) continue;
    const admitted = routeLanePermission(ctx, i, hit);
    const matches = routeLaneDirectionMatches(hit);
    const temporary = admitted === false && matches ? temporaryUse(ctx, i, hit, k) : false;
    if (admitted === true && matches || temporary === true) continue;
    let run = 0;
    for (let next = k; next <= i.kEnd && next < k + Math.ceil(LANE_OBSERVATION_SECONDS / DT); next++) {
      if (routeLaneAt(ctx, i, next)?.lane.id !== hit.lane.id) break;
      run++;
    }
    if (run * DT < LANE_OBSERVATION_SECONDS) continue;
    seen.add(laneKey(hit));
    const signed = hit.signs.some(sign => ROUTE_SIGNS.has(sign.kind));
    const movingObserved = Array.from({ length: i.kEnd - i.k0 + 1 }, (_, index) => index + i.k0)
      .some(frame => i.tr.present[frame] && i.tr.v[frame] > REST_SPEED && routeLaneAt(ctx, i, frame)?.lane.id === hit.lane.id);
    const stopCauseUnknown = !movingObserved && i.a.routeContext?.laneUse !== 'passenger-stop';
    const unknown = !signed || admitted === null || temporary === null || stopCauseUnknown;
    const generalOpposing = !matches || hit.road.road.oneWay && hit.lane.direction === 'reverse'
      || !hit.road.road.oneWay && (hit.forward ? hit.near.d < -0.1 : hit.near.d > 0.1);
    const city = ctx.scene.env.federalCity;
    const code = unknown ? [] : i.a.type === 'bicycle' ? ['rule:nonmotor-road'] : generalOpposing ? ['rule:opposing-lane'] : city === undefined ? []
      : [city === 'moscow' || city === 'saint-petersburg' ? 'rule:route-lane-capital' : 'rule:route-lane'];
    add({ actorId: i.a.id, severity: unknown ? 'contributing' : 'violation', t: tOf(k),
      title: unknown ? 'условия движения по выделенной полосе установлены не полностью' : generalOpposing
        ? 'движение по выделенной полосе во встречном для общего потока направлении' : 'движение или остановка на полосе для маршрутных ТС без установленного допуска',
      detail: unknown ? 'Нужны установленные обозначение полосы, допуск участника и условия временного заезда. Неизвестные обстоятельства не считаются отсутствующими.'
        : 'Наблюдается движение или остановка на явно заданной полосе для маршрутных ТС. Допуска по установленным фактам нет; временные исключения проверены отдельно.',
      refs: ['pdd:18.2', ...hit.signs.filter(sign => ROUTE_SIGNS.has(sign.kind)).map(sign => `sign:${sign.kind}`), ...code],
      trace: { ...sampleTrace(ctx, i, k), routeLane: structuredClone(hit.lane), roadId: hit.road.road.id,
        routeContext: structuredClone(i.a.routeContext), admission: admitted, temporaryAdmission: temporary,
        directionMatches: matches, generalOpposing, federalCity: city, qualificationUnknown: !unknown && !generalOpposing && city === undefined,
        stopCauseUnknown,
        observationSeconds: LANE_OBSERVATION_SECONDS, compliance: 'не определить' } });
  }
}

function stopReasonAhead(ctx: Ctx, bus: Info, frame: number): boolean {
  const here = { cx: bus.tr.x[frame], cy: bus.tr.y[frame], a: bus.tr.h[frame] };
  if (ctx.scene.lights.some(light => {
    const local = toLocal(light, here);
    if (local.x < 0 || local.x > 25 || Math.abs(local.y) > bus.hw + 4) return false;
    if (light.kind === 'controller') return true;
    if (Math.abs(angDiff(light.angle, bus.tr.h[frame])) > 0.5) return false;
    const permission = movementPermission(light, { ...bus.a, heading: bus.tr.h[frame] }, 'unknown', tOf(frame));
    return permission.regulated && permission.allowed !== true;
  })) return true;
  return ctx.scene.signs.some(sign => {
    const local = toLocal(sign, here);
    return sign.kind === '2.5' && local.x >= 0 && local.x < 15 && Math.abs(local.y) < bus.hw + 4
      && Math.abs(angDiff(sign.angle, bus.tr.h[frame])) < 0.5;
  });
}

function departureObservations(ctx: Ctx, bus: Info, other: Info, departure: Departure): { interference: number; yielding: number } {
  const window = Math.ceil(INTERFERENCE_WINDOW_SECONDS / DT);
  let yielding = -1, resting = 0;
  for (let k = Math.max(bus.k0, other.k0, departure.startFrame); k <= Math.min(bus.kEnd, other.kEnd, departure.endFrame); k++) {
    if (!bus.tr.present[k] || !other.tr.present[k]) { resting = 0; continue; }
    const ahead = toLocal(posAt(other, k), { cx: bus.tr.x[k], cy: bus.tr.y[k], a: bus.tr.h[k] });
    const forwardCorridor = ahead.x > bus.hl + other.hl && ahead.x < 25 && Math.abs(ahead.y) <= bus.hw + other.hw + 0.5;
    if (k >= Math.max(bus.k0, other.k0) + window && bus.tr.v[k - window] > 2
      && (bus.tr.v[k - window] - bus.tr.v[k]) / (window * DT) >= INTERFERENCE_DECELERATION
      && forwardCorridor && !stopReasonAhead(ctx, bus, k)) return { interference: k, yielding: -1 };
    const nearby = dist(posAt(bus, k), posAt(other, k)) <= APPROACH_RANGE;
    if (nearby && !forwardCorridor && other.tr.v[k] <= REST_SPEED) {
      resting++;
      if (resting * DT >= REST_OBSERVATION_SECONDS) yielding = k;
    } else resting = 0;
  }
  return { interference: -1, yielding };
}

export function checkRouteTransport(ctx: Ctx, add: Add): void {
  const infos = [...ctx.infos.values()].filter(i => i.isVeh && !i.a.railwayTrain && i.k0 < ctx.tl.n);
  for (const i of infos) laneChecks(ctx, i, add);
  for (const bus of infos) {
    const departure = routeDeparture(ctx, bus);
    if (!departure) continue;
    for (const other of infos) {
      if (bus === other) continue;
      const frame = departureEncounter(ctx, bus, other, departure);
      if (frame === null) continue;
      const contact = contactBetween(ctx, bus, other);
      const check = bus.a.routeContext?.departureChecks?.find(check => check.otherId === other.a.id);
      const known = check?.yieldingVerified;
      const higherPriority = specialPriority(ctx, bus.a.id, other.a.id, frame);
      const specialState = specialPairState(bus.a, other.a);
      const priorityUncertain = specialState === 'both' || specialState === 'unknown';
      const observed = contact || higherPriority || priorityUncertain
        ? { interference: -1, yielding: -1 } : departureObservations(ctx, bus, other, departure);
      const clear = !contact && observed.interference < 0;
      add({ actorId: bus.a.id, severity: known === false ? 'violation' : known === true && clear ? 'info' : 'contributing',
        t: contact?.t ?? tOf(departure.startFrame), causal: !!contact && known === false,
        title: known === false ? 'автобус начал движение без проверки уступания' : known === true && clear
          ? 'уступание проверено перед выездом от остановки' : 'проверка уступания перед выездом от остановки не подтверждена',
        detail: 'По п. 18.3 автобус или троллейбус начинает движение от обозначенной остановки в населённом пункте лишь после проверки уступания. Эта обязанность не отменяет обязанности других водителей уступить.',
        refs: ['pdd:18.3'], trace: { ...sampleTrace(ctx, bus, departure.startFrame), otherActorId: other.a.id,
          departure: structuredClone(departure), verification: structuredClone(check), observationRangeMeters: APPROACH_RANGE,
          standaloneQualification: 'TODO(legal-check): самостоятельная квалификация начала движения без проверки уступания',
          observedInterferenceFrame: observed.interference, compliance: known === true && clear ? 'выполнено' : 'не определить' } });
      // The bus driver's independent departure check does not create an
      // ordinary duty for a priority special vehicle to yield to this bus.
      // Section 3 is assessed earlier by the same hierarchy as collisions.
      if (higherPriority || priorityUncertain) continue;
      if (!contact && observed.interference >= 0) add({ actorId: other.a.id, severity: 'violation', t: tOf(observed.interference),
        title: 'создана помеха начинающему движение автобусу или троллейбусу',
        detail: 'Другой участник занял передний коридор начинающего движение автобуса или троллейбуса; тот фактически тормозил. Отсутствие контакта не означает выполнения обязанности уступить. Отдельное подтверждение водителя автобуса не отменяет наблюдаемую помеху.',
        refs: ['pdd:18.3', 'rule:route-priority'], trace: { otherActorId: bus.a.id, departure: structuredClone(departure),
          interferenceFrame: observed.interference, observationWindowSeconds: INTERFERENCE_WINDOW_SECONDS,
          minimumDeceleration: INTERFERENCE_DECELERATION, maximumForwardDistance: 25, compliance: 'не выполнено' } });
      else if (!contact && observed.yielding >= 0) add({ actorId: other.a.id, severity: 'info', t: tOf(observed.yielding),
        title: 'автобусу или троллейбусу уступлен выезд от остановки', detail: 'Другой участник фактически ожидал вне переднего коридора начинающего движение автобуса или троллейбуса; конфликт не наблюдается.',
        refs: ['pdd:18.3'], trace: { otherActorId: bus.a.id, departure: structuredClone(departure),
          yieldingFrame: observed.yielding, observationSeconds: REST_OBSERVATION_SECONDS, compliance: 'выполнено' } });
    }
  }
}
