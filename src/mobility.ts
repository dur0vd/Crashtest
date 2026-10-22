import type { Actor, MobilitySurface } from './scene';
import type { Geo, RoadHit } from './geo';
import { roadsAt, widthsAt } from './geo';
import { dot, fromAngle, nearestOnPolyline, type Vec } from './geom';

export type Known = boolean | null;
export const all = (...facts: (boolean | null | undefined)[]): Known => facts.includes(false) ? false : facts.some(f => f == null) ? null : true;
export const any = (...facts: (boolean | null | undefined)[]): Known => facts.includes(true) ? true : facts.some(f => f == null) ? null : false;
export const isCycleRider = (a: Actor): boolean => a.kind === 'vehicle' && ['bicycle', 'sim'].includes(a.type);
export const isSmallRider = (a: Actor): boolean => a.kind === 'vehicle' && ['bicycle', 'sim', 'moped'].includes(a.type);
export interface MobilityPlace {
  surface: MobilitySurface | 'carriageway' | 'unknown';
  corridorId?: string;
  source?: string;
  road?: RoadHit;
  cycleZone: boolean;
  pedestrianZone: boolean;
  rightEdge: boolean | null;
  laneDirectionAllowed: Known;
}

/** Corridors have butt ends, as drawn. Signs or symbol artwork never create a zone. */
export function mobilityPlaceAt(geo: Geo, p: Vec, heading: number, width = 0): MobilityPlace {
  const corridors = geo.sidewalks.filter(s => {
    if (s.pts.length < 2) return false;
    const near = nearestOnPolyline(s.pts, p);
    return !near.beyond && near.dist <= s.item.width / 2;
  });
  const cycleZone = corridors.some(s => s.item.mobilityKind === 'cycle-zone' && !!s.item.source?.trim());
  const pedestrianZone = corridors.some(s => s.item.mobilityKind === 'pedestrian-zone');
  const corridor = corridors.find(s => !['cycle-zone', 'pedestrian-zone'].includes(s.item.mobilityKind ?? '')) ?? corridors[0];
  const road = roadsAt(geo, p)[0];
  let rightEdge: Known = null;
  if (road) {
    const forward = dot(fromAngle(heading), road.near.tangent) >= 0;
    const widths = widthsAt(road.rg, road.near.s);
    const edge = forward ? widths.r : widths.l;
    const lateral = forward ? road.near.d : -road.near.d;
    // Explicit model tolerance, not a numeric requirement of 24.2/24.7.
    const gap = edge - lateral - width / 2;
    rightEdge = (road.rg.road.oneWay ? forward : lateral >= 0) && gap >= -0.15 && gap <= 0.75;
  }
  let laneDirectionAllowed: Known = true;
  if (corridor?.item.mobilityKind === 'cycle-lane') {
    const direction = corridor.item.travelDirection;
    const near = nearestOnPolyline(corridor.pts, p);
    const alignment = dot(fromAngle(heading), near.tangent);
    laneDirectionAllowed = direction === 'both' ? true : !direction || Math.abs(alignment) < 0.5 ? null
      : direction === 'forward' ? alignment > 0 : alignment < 0;
  }
  return { surface: corridor?.item.mobilityKind ?? (corridor ? 'sidewalk' : road ? 'carriageway' : 'unknown'),
    corridorId: corridor?.item.id, source: corridor?.item.source, road, cycleZone, pedestrianZone, rightEdge, laneDirectionAllowed };
}

export function actorAtMobilityPlace(geo: Geo, a: Actor, p: Vec, heading: number) {
  return { ...a, x: p.x, y: p.y, heading, signalSurface: mobilityPlaceAt(geo, p, heading).surface };
}

export interface PlacePermission { allowed: Known; refs: string[]; reason: string }
export function mobilityPlacePermission(a: Actor, place: MobilityPlace): PlacePermission {
  const c = a.mobilityContext ?? {};
  const s = place.surface;
  const sim = a.type === 'sim';
  const answer = (allowed: Known, ref: string, reason: string): PlacePermission => ({ allowed, refs: [ref], reason });
  if (a.type === 'moped') return answer(s === 'cycle-lane' ? place.laneDirectionAllowed : s === 'carriageway' ? place.rightEdge
    : s === 'shoulder' ? (c.pedestrianObstruction === undefined ? null : !c.pedestrianObstruction) : s === 'unknown' ? null : false,
    'pdd:24.7', 'Мопед: правая кромка, велополоса либо обочина без помех пешеходам.');
  if (s === 'unknown') return answer(null, 'pdd:24.1', 'Назначение места движения не установлено.');
  if (a.age === undefined) return answer(null, 'pdd:24.1', 'Возраст ездока не установлен.');
  if (a.age < 7) {
    const permitted = ['sidewalk', 'footpath', 'sharedpath', 'pedestrian-side', 'pedestrian-zone'].includes(s) || place.pedestrianZone;
    return answer(all(permitted, sim ? c.adultAccompanied : true), 'pdd:24.4', 'До 7 лет: пешеходные места и пешеходная сторона велопешеходной дорожки; СИМ — со взрослым.');
  }
  if (a.age < 14) return answer(['sidewalk', 'footpath', 'cyclepath', 'sharedpath', 'pedestrian-side', 'cycle-side', 'pedestrian-zone'].includes(s)
    || place.pedestrianZone, 'pdd:24.3', 'От 7 до 14 лет: тротуары и дорожки, пешеходные зоны; не велополоса проезжей части.');
  // Completed years: the 14+ group follows the traffic police's published
  // interpretation, not a synthetic extra one-year restriction. Evidence:
  // https://www.admsurgut.ru/novosti/detail.php?ID=493459 (15.07.2026),
  // and the Bryansk traffic police explanation, linked in RULES-MOBILITY.md.
  if (['cyclepath', 'sharedpath', 'cycle-side', 'cycle-lane'].includes(s) || place.cycleZone && ['cycle-zone', 'carriageway'].includes(s)) return answer(place.laneDirectionAllowed, 'pdd:24.1', 'Велосипедная инфраструктура или подтверждённая геометрия велосипедной зоны.');
  const unavailable = c.cycleInfrastructureUnavailable;
  if (sim) {
    const mass = a.simParameters?.deviceMass;
    const light = mass === undefined ? null : mass <= 35;
    const walkway = all(light, any(unavailable, c.accompaniesChildUnder14));
    const allowed = s === 'pedestrian-zone' ? light
      : ['sidewalk', 'footpath', 'pedestrian-side'].includes(s) ? walkway
      : s === 'shoulder' ? all(unavailable, c.pedestrianInfrastructureUnavailable)
      : s === 'carriageway' ? all(unavailable, c.pedestrianInfrastructureUnavailable, c.shoulderUnavailable,
        c.roadAllowsCycling, c.roadSpeedLimit === undefined ? null : c.roadSpeedLimit <= 60, c.roadEquipmentComplete, place.rightEdge) : false;
    return answer(allowed, 'pdd:24.2(1)', 'СИМ: масса устройства ≤35 кг для пешеходных мест; альтернативы, оборудование и дорожный предел проверяются отдельно.');
  }
  const wide = a.cargo ? 0.6 + a.cargo.left + a.cargo.right > 1 : false;
  const allowed = s === 'carriageway' ? all(place.rightEdge, any(unavailable, wide, c.column))
    : s === 'shoulder' ? all(unavailable, c.carriagewayUnavailable)
    : ['sidewalk', 'footpath', 'pedestrian-side'].includes(s) ? any(all(unavailable, c.carriagewayUnavailable, c.shoulderUnavailable), c.accompaniesChildUnder14, c.carriesChildUnder7) : false;
  return answer(allowed, 'pdd:24.2', 'Велосипед: правая кромка, обочина, тротуар разрешены только при установленных условиях 24.2.');
}
