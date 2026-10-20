import { classifyIntersectionMovement, intersectionAt, roadsAt, type IntersectionGeo } from '../geo';
import { angDiff, dist, distToSegment, obbCorners, segIntersect, toLocal, type Vec } from '../geom';
import { type Movement, type Sign, type TrafficLight } from '../scene';
import { DT } from '../sim';
import { movementPermission } from '../traffic-control';
import type { Ctx, Info } from './context';
import type { FindingInput, Trace } from './types';
import { boxAt, posAt, tOf } from './technical';

/** These are observation windows, not numerical requirements imposed by the PDD. */
const APPROACH_WINDOW_SECONDS = 6;
const QUEUE_STOP_SECONDS = 0.5;

export interface IntersectionParticipant {
  actorId: string;
  entryFrame: number;
  exitFrame: number;
  gateFrame: number;
  entered: boolean;
  entryHeading: number;
  exitHeading: number;
  maneuver: Movement | 'unknown';
  roadId?: string;
  exitRoadId?: string;
  regulated: boolean;
  allowed: boolean | null;
  yieldToAll: boolean;
  priority: number;
  signs: string[];
  onCircle: boolean;
  lightId?: string;
  trace: Trace;
}
export interface PriorityEdge {
  from: string;
  to: string;
  refs: string[];
  explain: string;
  trace: Trace;
}
export interface PriorityGraph {
  intersectionId: string;
  frame: number;
  participants: IntersectionParticipant[];
  edges: PriorityEdge[];
  cycles: string[][];
  agreementRequired: boolean;
  trace: Trace;
}

export function insideBoundary(p: Vec, boundary: Vec[]): boolean {
  let inside = false;
  for (let a = boundary.length - 1, b = 0; b < boundary.length; a = b++) {
    const u = boundary[a], v = boundary[b];
    const cross = (p.x - u.x) * (v.y - u.y) - (p.y - u.y) * (v.x - u.x);
    if (Math.abs(cross) < 1e-7 && p.x >= Math.min(u.x, v.x) - 1e-7 && p.x <= Math.max(u.x, v.x) + 1e-7 && p.y >= Math.min(u.y, v.y) - 1e-7 && p.y <= Math.max(u.y, v.y) + 1e-7) return true;
    if ((u.y > p.y) !== (v.y > p.y) && p.x < (v.x - u.x) * (p.y - u.y) / (v.y - u.y) + u.x) inside = !inside;
  }
  return inside;
}

function routePoints(i: Info): Vec[] {
  const points: Vec[] = [{ x: i.a.x, y: i.a.y }, ...i.a.path];
  if (points.length === 1 && i.a.speed > 0) points.push({ x: i.a.x + Math.cos(i.a.heading) * i.a.speed / 3.6 * 30, y: i.a.y + Math.sin(i.a.heading) * i.a.speed / 3.6 * 30 });
  return points;
}

function routeTouches(i: Info, intersection: IntersectionGeo, ctx?: Ctx): boolean {
  const pts: Vec[] = routePoints(i);
  if (pts.some(p => insideBoundary(p, intersection.boundary))) return true;
  for (let k = 1; k < pts.length; k++) {
    for (let j = 0; j < intersection.boundary.length; j++) {
      if (segIntersect(pts[k - 1], pts[k], intersection.boundary[j], intersection.boundary[(j + 1) % intersection.boundary.length])) return true;
    }
  }
  if (ctx && intersection.boundarySource === 'automatic-estimate') {
    const startRoads = roadsAt(ctx.geo, pts[0], 1).map(h => h.rg.road.id).filter(id => intersection.roadIds.includes(id));
    const endRoads = roadsAt(ctx.geo, pts.at(-1)!, 1).map(h => h.rg.road.id).filter(id => intersection.roadIds.includes(id));
    const changesRoad = startRoads.some(a => endRoads.some(b => a !== b));
    const radius = Math.max(...ctx.geo.roads.filter(r => intersection.roadIds.includes(r.road.id)).map(r => r.half), 3.5) * 3;
    if (changesRoad && pts.some((p, k) => k > 0 && distToSegment(intersection.center, pts[k - 1], p) <= radius)) return true;
  }
  return false;
}

/** The same controller wins over lights, signs and markings (6.15). */
export function controllerAt(ctx: Ctx, intersection: IntersectionGeo | null, heading?: number): TrafficLight | undefined {
  if (!intersection) return undefined;
  return ctx.scene.lights.find(l => l.kind === 'controller' && l.mode !== 'off' && dist(l, intersection.center) < 35 && (l.controllerGesture !== 'stop' || heading !== undefined && l.controllerTargetHeading !== undefined && Math.abs(angDiff(l.controllerTargetHeading, heading)) < 0.5));
}

export function movementFor(ctx: Ctx, i: Info, frame: number, light?: TrafficLight) {
  const p = posAt(i, Math.min(ctx.tl.n - 1, Math.max(0, frame)));
  const intersection = intersectionAt(ctx.geo, p) ?? ctx.geo.intersections
    .filter(j => (!light || dist(light, j.center) < 60) && routeTouches(i, j, ctx))
    .sort((a, b) => dist(p, a.center) - dist(p, b.center))[0];
  return { intersection: intersection ?? null,
    movement: intersection ? classifyIntersectionMovement(ctx.geo, i.a, intersection) : null };
}

function approachSigns(ctx: Ctx, i: Info, j: IntersectionGeo, heading: number, entryFrame: number): Sign[] {
  const crossed = ctx.gates.filter(g => g.actorId === i.a.id && g.sign && g.frame <= entryFrame && i.trav[entryFrame] - g.dist <= 120).map(g => g.sign!);
  const nearby = ctx.scene.signs.filter(s => ['2.1', '2.2', '2.4', '2.5', '4.3'].includes(s.kind)
    && Math.abs(angDiff(heading, s.angle)) < 0.5
    && dist(s, j.center) < 60
    && toLocal(s, { cx: j.center.x, cy: j.center.y, a: heading }).x < 2);
  return [...new Map([...crossed, ...nearby].map(s => [s.id, s])).values()];
}

function participant(ctx: Ctx, i: Info, j: IntersectionGeo): IntersectionParticipant | null {
  if (i.k0 >= ctx.tl.n) return null;
  const vulnerable = !i.isVeh || i.a.type === 'bicycle' || String(i.a.type) === 'sim';
  const pts = routePoints(i);
  const nearbyDestinationCrossing = vulnerable && pts.some((p, k) => k > 0 && distToSegment(j.center, pts[k - 1], p) < 25);
  if (!routeTouches(i, j, ctx) && !nearbyDestinationCrossing) return null;
  const movement = classifyIntersectionMovement(ctx.geo, i.a, j);
  let entryFrame = -1, exitFrame = -1, closest = Infinity, closestFrame = i.k0;
  for (let k = i.k0; k <= i.kEnd; k++) {
    const p = posAt(i, k);
    const d = dist(p, j.center);
    if (d < closest) { closest = d; closestFrame = k; }
    if (insideBoundary(p, j.boundary) || i.isVeh && obbCorners(boxAt(i, k)).some(c => insideBoundary(c, j.boundary))) {
      if (entryFrame < 0) entryFrame = k;
      exitFrame = k;
    }
  }
  const entered = entryFrame >= 0;
  if (!entered) {
    if (closest > 45) return null;
    entryFrame = closestFrame;
    exitFrame = vulnerable ? closestFrame : i.kEnd;
  }
  const entryGates = ctx.gates.filter(g => g.actorId === i.a.id && g.light && g.frame <= entryFrame
    && dist(g.light, j.center) < 60 && Math.abs(angDiff(movement.entryHeading, g.light.angle)) < 0.7);
  const gate = entryGates.at(-1);
  const controller = controllerAt(ctx, j, movement.entryHeading);
  const light = controller ?? gate?.light ?? ctx.scene.lights
    .filter(l => l.kind !== 'controller' && l.kind !== 'reversible' && dist(l, j.center) < 45
      && Math.abs(angDiff(movement.entryHeading, l.angle)) < 0.5
      && toLocal(l, { cx: j.center.x, cy: j.center.y, a: movement.entryHeading }).x <= 0)
    .sort((a, b) => dist(a, j.center) - dist(b, j.center))[0];
  const gateFrame = gate?.frame ?? entryFrame;
  const control = light ? movementPermission(light, { ...i.a, heading: movement.entryHeading }, movement.maneuver, tOf(gateFrame))
    : { regulated: false, allowed: null, yieldToAll: false, refs: [], reason: 'Нерегулируемый подход' };
  const signs = approachSigns(ctx, i, j, movement.entryHeading, entryFrame);
  let priority = signs.some(s => s.kind === '2.1') ? 1 : signs.some(s => s.kind === '2.4' || s.kind === '2.5') ? -1 : 0;
  const main = ctx.scene.signs.find(s => s.mainDirections?.length && dist(s, j.center) < 60);
  if (main?.mainDirections?.length) priority = main.mainDirections.some(h => Math.abs(angDiff(h, movement.entryHeading)) < 0.5) ? 1 : -1;
  const road = ctx.scene.roads.find(r => r.id === movement.entryRoadId);
  if (!signs.some(s => ['2.1', '2.4', '2.5'].includes(s.kind)) && !main) {
    if (i.a.coveringUnknown || road?.surfacePriority === 'unknown') priority = -1;
    else if (road?.surfacePriority === 'unpaved' && j.roadIds.some(id => ctx.scene.roads.find(r => r.id === id)?.surfacePriority !== 'unpaved')) priority = -1;
  }
  const onCircle = road?.role === 'roundabout' || roadsAt(ctx.geo, { x: i.a.x, y: i.a.y }).some(h => h.rg.road.role === 'roundabout');
  return { actorId: i.a.id, entryFrame, exitFrame, gateFrame, entered, entryHeading: movement.entryHeading,
    exitHeading: movement.exitHeading, maneuver: movement.maneuver, roadId: movement.entryRoadId,
    exitRoadId: movement.exitRoadId, regulated: control.regulated, allowed: control.allowed === false && ctx.findings.some(f => f.actorId === i.a.id && f.refs.includes('pdd:6.14') && f.severity === 'info' && Math.abs((f.t ?? -100) - tOf(gateFrame)) < DT) ? true : control.allowed,
    yieldToAll: control.yieldToAll, priority, signs: signs.map(s => s.kind), onCircle, lightId: light?.id,
    trace: { movement, control, light: light ? structuredClone(light) : null, signs: structuredClone(signs), road: road ? structuredClone(road) : null, entered, entryFrame, exitFrame, gateFrame } };
}

/** A turn crosses the pedestrian/cycle route on its destination carriageway, not just any nearby path. */
function crossesDestination(ctx: Ctx, turning: IntersectionParticipant, other: IntersectionParticipant): boolean {
  if (!['left', 'right'].includes(turning.maneuver)) return false;
  const o = ctx.infos.get(other.actorId)!;
  if (o.isVeh && o.a.type !== 'bicycle' && String(o.a.type) !== 'sim') return false;
  const road = ctx.geo.roads.find(r => r.road.id === turning.exitRoadId);
  const route = routePoints(o);
  const crossesAxis = road?.pts.some((r, k) => k > 0 && route.some((p, n) => n > 0 && !!segIntersect(route[n - 1], p, road.pts[k - 1], r)));
  return !!turning.exitRoadId && !!crossesAxis
    && Math.abs(Math.sin(angDiff(turning.exitHeading, other.entryHeading))) > 0.5;
}

function edge(ctx: Ctx, a: IntersectionParticipant, b: IntersectionParticipant, refs: string[], explain: string): PriorityEdge {
  return { from: a.actorId, to: b.actorId, refs, explain,
    trace: { from: a.trace, to: b.trace, labels: [ctx.infos.get(a.actorId)!.label, ctx.infos.get(b.actorId)!.label] } };
}

function compare(ctx: Ctx, j: IntersectionGeo, a: IntersectionParticipant, b: IntersectionParticipant): PriorityEdge | null {
  const A = ctx.infos.get(a.actorId)!, B = ctx.infos.get(b.actorId)!;
  const pairs = [[a, b, A, B], [b, a, B, A]] as const;
  for (const [y, p, Y] of pairs) if (crossesDestination(ctx, y, p)) {
    return edge(ctx, y, p, ['pdd:13.1', 'rule:pedestrian-priority'], `${Y.label} при повороте уступает пересекающим проезжую часть дороги, на которую поворачивает (п. 13.1).`);
  }
  for (const [y, p, Y, P] of pairs) {
    const entry = ctx.pedEntry.get(P.a.id);
    if (Y.isVeh && !P.isVeh && y.regulated && y.allowed === true && entry?.pedGreen === true && entry.frame < y.gateFrame && entry.onCrosswalk) {
      return edge(ctx, y, p, ['pdd:13.8', 'rule:pedestrian-priority'], `${Y.label} при разрешающем сигнале уступает пешеходу, не закончившему переход.`);
    }
  }
  if (!A.isVeh || !B.isVeh) return null;
  const regulated = a.regulated || b.regulated;
  if (!regulated && (A.a.coveringUnknown || ctx.scene.roads.find(r => r.id === a.roadId)?.surfacePriority === 'unknown') && (B.a.coveringUnknown || ctx.scene.roads.find(r => r.id === b.roadId)?.surfacePriority === 'unknown') && !a.signs.some(s => ['2.1', '2.4', '2.5'].includes(s)) && !b.signs.some(s => ['2.1', '2.4', '2.5'].includes(s))) return null;
  if (regulated) {
    if (a.allowed === false && b.allowed !== false) return edge(ctx, a, b, ['pdd:6.2', 'pdd:13.3', 'rule:signal'], `${A.label} въезжает при запрещающем сигнале.`);
    if (b.allowed === false && a.allowed !== false) return edge(ctx, b, a, ['pdd:6.2', 'pdd:13.3', 'rule:signal'], `${B.label} въезжает при запрещающем сигнале.`);
    if (a.allowed !== true || b.allowed !== true) return null;
    for (const [y, p, Y, P] of pairs) {
      const light = ctx.scene.lights.find(l => l.id === y.lightId);
      if (light && p.gateFrame < y.gateFrame && movementPermission(light, { ...Y.a, heading: y.entryHeading }, y.maneuver, tOf(p.gateFrame)).allowed === false) {
        return edge(ctx, y, p, ['pdd:13.8', 'rule:intersection-priority'], `${Y.label} при включении разрешающего сигнала уступает ${P.label}, завершающему проезд перекрёстка.`);
      }
    }
    if (a.yieldToAll !== b.yieldToAll) {
      const [y, p, Y] = a.yieldToAll ? [a, b, A] : [b, a, B];
      return edge(ctx, y, p, ['pdd:13.5', ...(Y.rail ? ['pdd:13.6'] : []), 'rule:intersection-priority'], `${Y.label} движется по дополнительной стрелке с красным/жёлтым и уступает другим направлениям.`);
    }
    if (A.rail !== B.rail) return A.rail
      ? edge(ctx, b, a, ['pdd:13.6', 'rule:intersection-priority'], `${A.label}: трамвай имеет преимущество при одновременном разрешении движения.`)
      : edge(ctx, a, b, ['pdd:13.6', 'rule:intersection-priority'], `${B.label}: трамвай имеет преимущество при одновременном разрешении движения.`);
  } else {
    if (j.roundabout && a.onCircle !== b.onCircle) {
      const [entering, circle, entrant] = a.onCircle ? [b, a, B] : [a, b, A];
      if (entering.priority <= 0 && ctx.scene.signs.some(s => s.kind === '4.3' && dist(s, j.center) < 100)) {
        return edge(ctx, entering, circle, ['pdd:13.11(1)', 'sign:4.3', 'rule:intersection-priority'], `${entrant.label} въезжает на обозначенный круг с дороги, не являющейся главной, и уступает движущимся по кругу.`);
      }
    }
    if (a.priority !== b.priority) {
      const [y, p, Y] = a.priority < b.priority ? [a, b, A] : [b, a, B];
      const road = ctx.scene.roads.find(r => r.id === y.roadId);
      const unknown = Y.a.coveringUnknown || road?.surfacePriority === 'unknown';
      return edge(ctx, y, p, ['pdd:13.9', ...(unknown ? ['pdd:13.13'] : []), ...y.signs.filter(s => s === '2.4' || s === '2.5').map(s => `sign:${s}`), 'rule:intersection-priority'], `${Y.label} должен уступить приближающемуся по главной дороге${unknown ? ': покрытие определить невозможно, знаков приоритета нет (п. 13.13)' : ''}.`);
    }
    const mainChanges = ctx.scene.signs.some(s => s.mainDirections?.length && dist(s, j.center) < 60);
    if (A.rail !== B.rail && (j.equal || mainChanges || Math.abs(angDiff(a.entryHeading, b.entryHeading)) > 2.1 || Math.abs(angDiff(a.entryHeading, b.entryHeading)) < 0.5)) {
      const [y, p, P] = A.rail ? [b, a, A] : [a, b, B];
      return edge(ctx, y, p, [...(mainChanges ? ['pdd:13.10'] : []), j.equal || mainChanges ? 'pdd:13.11' : 'pdd:13.9', 'rule:intersection-priority'], `${P.label}: трамвай имеет преимущество при равном праве на движение.`);
    }
  }
  const opposite = Math.abs(angDiff(a.entryHeading, b.entryHeading)) > 2.1;
  for (const [y, p, Y, P] of pairs) if (opposite && ['left', 'uturn'].includes(y.maneuver) && ['straight', 'right'].includes(p.maneuver)) {
    return edge(ctx, y, p, [regulated ? 'pdd:13.4' : 'pdd:13.12', ...(!regulated && ctx.scene.signs.some(s => s.mainDirections?.length) ? ['pdd:13.10'] : []), 'rule:intersection-priority'], `${Y.label} поворачивает налево или разворачивается и уступает встречному ${P.label}, движущемуся прямо или направо.`);
  }
  if (regulated) return null;
  // Compare approach directions, not positions already displaced by a collision.
  const cross = Math.sin(angDiff(a.entryHeading, b.entryHeading));
  if (Math.abs(cross) < 0.5) return null;
  const mainChanges = ctx.scene.signs.some(s => s.mainDirections?.length && dist(s, j.center) < 60);
  const refs = [...(mainChanges ? ['pdd:13.10'] : []), 'pdd:13.11', 'rule:intersection-priority'];
  return cross < 0
    ? edge(ctx, a, b, refs, `${B.label} приближается справа от ${A.label}; при равном приоритете действует п. 13.11.`)
    : edge(ctx, b, a, refs, `${A.label} приближается справа от ${B.label}; при равном приоритете действует п. 13.11.`);
}

/** Strongly connected components prevent a pairwise resolver inventing a violator in a deadlock. */
export function priorityCycles(nodes: string[], edges: Pick<PriorityEdge, 'from' | 'to'>[]): string[][] {
  const reach = (start: string) => { const found = new Set<string>(); const queue = [start]; while (queue.length) { const n = queue.pop()!; for (const e of edges) if (e.from === n && !found.has(e.to)) { found.add(e.to); queue.push(e.to); } } return found; };
  const remaining = new Set(nodes), result: string[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    const r = reach(first);
    const group = [...remaining].filter(n => n === first || r.has(n) && reach(n).has(first));
    group.forEach(n => remaining.delete(n));
    if (group.length > 1) result.push(group.sort());
  }
  return result;
}

export function buildPriorityGraphs(ctx: Ctx): PriorityGraph[] {
  const graphs: PriorityGraph[] = [];
  for (const j of ctx.geo.intersections) {
    const all = [...ctx.infos.values()].map(i => participant(ctx, i, j)).filter((p): p is IntersectionParticipant => !!p);
    const snapshots = [...new Set(all.flatMap(p => [p.entryFrame, p.gateFrame]))].sort((a, b) => a - b);
    const seen = new Set<string>();
    for (const frame of snapshots) {
      // Every SCC belongs to one common instant. A union of pairwise encounters at different
      // times must never create a synthetic deadlock and erase a later actual violation.
      const participants = all.filter(p => p.entryFrame - APPROACH_WINDOW_SECONDS / (2 * DT) <= frame && p.exitFrame + 0.5 / DT >= frame);
      if (!participants.length) continue;
      const key = participants.map(p => p.actorId).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const edges: PriorityEdge[] = [];
      for (let a = 0; a < participants.length; a++) for (let b = a + 1; b < participants.length; b++) {
        const relation = compare(ctx, j, participants[a], participants[b]);
        if (relation) edges.push(relation);
      }
      const cycles = priorityCycles(participants.map(p => p.actorId), edges);
      graphs.push({ intersectionId: j.id, frame, participants, edges, cycles, agreementRequired: cycles.length > 0,
        trace: { frame, t: tOf(frame), boundary: j.boundary, boundarySource: j.boundarySource, simultaneousApproachWindowSeconds: APPROACH_WINDOW_SECONDS, roundabout: j.roundabout } });
    }
  }
  return graphs;
}

export function graphPriority(ctx: Ctx, a: string, b: string, point: Vec, frame: number): { edge: PriorityEdge | null; cycle: boolean; graph?: PriorityGraph } {
  const intersection = intersectionAt(ctx.geo, point);
  if (!intersection) return { edge: null, cycle: false };
  const graph = ctx.priorityGraphs.filter(g => g.intersectionId === intersection.id && g.frame <= frame && g.participants.some(p => p.actorId === a) && g.participants.some(p => p.actorId === b))
    .sort((x, y) => y.frame - x.frame)[0];
  if (!graph) return { edge: null, cycle: false };
  const cycle = graph.cycles.some(c => c.includes(a) && c.includes(b));
  return { edge: cycle ? null : graph.edges.find(e => e.from === a && e.to === b || e.from === b && e.to === a) ?? null, cycle, graph };
}

/** 13.1 concerns the destination road, which can lie outside the junction boundary. */
export function turningVulnerablePriority(ctx: Ctx, a: string, b: string, point: Vec): PriorityEdge | null {
  for (const graph of ctx.priorityGraphs) {
    const junction = ctx.geo.intersections.find(j => j.id === graph.intersectionId)!;
    if (dist(point, junction.center) > 35) continue;
    const relation = graph.edges.find(e => e.refs.includes('pdd:13.1') && (e.from === a && e.to === b || e.from === b && e.to === a));
    if (!relation) continue;
    const turning = graph.participants.find(p => p.actorId === relation.from)!;
    if (roadsAt(ctx.geo, point, 1).some(h => h.rg.road.id === turning.exitRoadId)) return relation;
  }
  return null;
}

export function checkIntersectionObservations(ctx: Ctx, add: (f: FindingInput) => unknown): void {
  for (const graph of ctx.priorityGraphs) {
    const junction = ctx.geo.intersections.find(j => j.id === graph.intersectionId)!;
    for (const cycle of graph.cycles) for (const actorId of cycle) add({ actorId, severity: 'info', t: tOf(graph.participants.find(p => p.actorId === actorId)!.entryFrame),
      title: 'Очерёдность требует согласования', detail: 'Водители договариваются, см. п. 13.11 и 1.5. Цикл уступания не определяет нарушителя.', refs: ['pdd:13.11', 'pdd:1.5'],
      trace: { priorityCycle: cycle, compliance: 'не определить', graph: graph.trace } });
    for (const p of graph.participants) {
      const i = ctx.infos.get(p.actorId)!;
      if (!i.isVeh) continue;
      const unknown = i.a.coveringUnknown || ctx.scene.roads.find(r => r.id === p.roadId)?.surfacePriority === 'unknown';
      const anotherUnknown = graph.participants.some(o => o.actorId !== p.actorId && (ctx.infos.get(o.actorId)!.a.coveringUnknown || ctx.scene.roads.find(r => r.id === o.roadId)?.surfacePriority === 'unknown'));
      if (!p.regulated && unknown && anotherUnknown && !p.signs.some(s => ['2.1', '2.4', '2.5'].includes(s))) add({ actorId: p.actorId, severity: 'contributing', t: tOf(p.entryFrame),
        title: 'Приоритет не установлен: покрытие обоих подходов неизвестно', detail: 'Каждый водитель обязан считать свою дорогу второстепенной по п. 13.13. Данных о фактическом покрытии нет; равнозначность и нарушитель не назначаются.', refs: ['pdd:13.13'], trace: { ...p.trace, compliance: 'не определить' } });
      add({ actorId: p.actorId, severity: 'info', t: tOf(p.gateFrame), title: p.regulated ? 'Регулируемый проезд перекрёстка' : 'Нерегулируемый проезд перекрёстка',
        detail: 'Режим установлен по сигналам данного подхода на момент въезда; мигающий жёлтый и выключенный светофор не задают приоритет.', refs: ['pdd:13.3'], trace: { ...p.trace, compliance: 'выполнено' } });
      const controller = ctx.scene.lights.find(l => l.id === p.lightId && l.kind === 'controller');
      if (controller && p.entered && p.allowed === true) {
        const permission = movementPermission(controller, { ...i.a, heading: p.entryHeading }, p.maneuver, tOf(p.gateFrame));
        add({ actorId: p.actorId, severity: 'info', t: tOf(p.entryFrame), title: 'движение по разрешающему жесту регулировщика', detail: permission.reason, refs: permission.refs, trace: { ...p.trace, compliance: 'выполнено' } });
      }
      if (controller && p.entered && p.allowed === false && !ctx.findings.some(f => f.actorId === p.actorId && f.refs.includes('rule:signal'))) {
        const permission = movementPermission(controller, { ...i.a, heading: p.entryHeading }, p.maneuver, tOf(p.gateFrame));
        add({ actorId: p.actorId, severity: 'violation', t: tOf(p.entryFrame), title: 'не выполнено требование регулировщика', detail: permission.reason,
          refs: [...permission.refs, 'pdd:6.13', 'rule:signal'], trace: { ...p.trace, observation: 'пересечение границы перекрёстка с адресованным запрещающим жестом' } });
        const list = ctx.lightViolations.get(p.actorId) ?? [];
        list.push({ light: controller, frame: p.entryFrame }); ctx.lightViolations.set(p.actorId, list);
      }
      if (!p.entered) continue;
      const stopped: number[] = [];
      for (let k = p.entryFrame; k <= Math.min(i.kEnd, p.exitFrame); k++) if (i.tr.v[k] < 0.3 && insideBoundary(posAt(i, k), junction.boundary)) stopped.push(k);
      if (stopped.length < QUEUE_STOP_SECONDS / DT) continue;
      const kBefore = Math.max(i.k0, p.entryFrame - 1);
      const queue = [...ctx.infos.values()].find(o => {
        if (!o.isVeh || o === i || !o.tr.present[kBefore] || o.tr.v[kBefore] >= 0.3) return false;
        const q = toLocal(posAt(o, kBefore), { cx: junction.center.x, cy: junction.center.y, a: p.exitHeading });
        return q.x > 0 && q.x < 35 && Math.abs(q.y) < i.hw + o.hw + 1;
      });
      const crossTraffic = [...ctx.infos.values()].some(o => o !== i && o.isVeh && routeTouches(o, junction, ctx) && Math.abs(Math.sin(angDiff(p.entryHeading, o.a.heading))) > 0.5);
      const turningException = ['left', 'right'].includes(p.maneuver);
      // TODO(legal-check): применимость исключения 13.2 к конкретному повороту требует установления предусмотренного Правилами случая; одно направление манёвра не доказывает разрешение.
      if (queue && crossTraffic) add({ actorId: p.actorId, severity: turningException ? 'contributing' : 'violation', t: tOf(p.entryFrame), title: turningException ? 'Затор на выходе после поворота: требуется проверка исключения п. 13.2' : 'Выезд на перекрёсток при существовавшем заторе',
        detail: 'До въезда впереди уже стояла очередь; ТС остановилось на пересечении поперечного потока. Проверяется фактическая очередь, а не сам факт остановки внутри.',
        refs: ['pdd:13.2', ...(ctx.scene.markings.some(m => m.kind === '1.26' && m.pts.some(v => insideBoundary(v, junction.boundary))) ? ['marking:1.26'] : []), ...(turningException ? [] : ['rule:intersection-blockage'])],
        trace: { queueActorId: queue.a.id, queueFrame: kBefore, stoppedFrames: stopped, minimumStopSeconds: QUEUE_STOP_SECONDS, turningException: turningException ? 'TODO(legal-check): не установлен предусмотренный Правилами случай поворота' : null, movement: p.trace } });
    }
    for (const relation of graph.edges) {
      if (graph.cycles.some(c => c.includes(relation.from) && c.includes(relation.to))) continue;
      const Y = ctx.infos.get(relation.from)!, P = ctx.infos.get(relation.to)!;
      const contact = ctx.tl.collisions.some(c => c.a === relation.from && c.b === relation.to || c.a === relation.to && c.b === relation.from);
      if (contact) continue; // The collision stage records the actual interference and causation.
      const passY = graph.participants.find(p => p.actorId === relation.from)!;
      const passP = graph.participants.find(p => p.actorId === relation.to)!;
      // A yield is observable when Y waits outside or enters after P has left. Separation alone is not a violation.
      // For a non-contact interference require braking AND Y physically obstructing the
      // priority actor's forward corridor during the crossing. The numerical observation
      // thresholds are model settings, not legal definitions of 'уступить дорогу'.
      let interferenceFrame = -1;
      for (let k = Math.max(Y.k0, P.k0, passY.entryFrame, 20); k <= Math.min(Y.kEnd, P.kEnd, passY.exitFrame); k++) {
        if (!Y.tr.present[k] || !P.tr.present[k]) continue;
        const ahead = toLocal(posAt(Y, k), { cx: P.tr.x[k], cy: P.tr.y[k], a: P.tr.h[k] });
        const deceleration = (P.tr.v[k - 20] - P.tr.v[k]) / (20 * DT);
        if (deceleration < 1.5 || P.tr.v[k - 20] < 2 || ahead.x <= 0 || ahead.x > 20 || Math.abs(ahead.y) > P.hw + Y.hw + 0.5) continue;
        const redAhead = ctx.scene.lights.some(l => l.kind !== 'controller' && dist(l, posAt(P, k)) < 25 && Math.abs(angDiff(P.tr.h[k], l.angle)) < 0.5 && movementPermission(l, { ...P.a, heading: P.tr.h[k] }, passP.maneuver, tOf(k)).allowed === false);
        if (!redAhead) { interferenceFrame = k; break; }
      }
      if (interferenceFrame >= 0) add({ actorId: relation.from, severity: 'violation', t: tOf(interferenceFrame), title: 'создал помеху участнику с преимуществом',
        detail: relation.explain + ' Приоритетный участник фактически тормозил при нахождении уступающего ТС в его переднем коридоре движения.', refs: relation.refs,
        trace: { ...relation.trace, interferenceFrame, prioritySpeedBefore: P.tr.v[interferenceFrame - 20], prioritySpeedAfter: P.tr.v[interferenceFrame], observationWindowSeconds: 20 * DT, minimumDeceleration: 1.5, maximumForwardDistance: 20 } });
      else if (!passY.entered || passY.entryFrame > passP.exitFrame) add({ actorId: relation.from, severity: 'info', t: tOf(passY.entryFrame), title: 'Требование уступить соблюдено в наблюдавшемся проезде',
        detail: relation.explain, refs: relation.refs, trace: { ...relation.trace, compliance: 'выполнено', priorityActor: P.a.id, yieldingActor: Y.a.id } });
    }
  }
}
