import type { Ctx, Info } from './analysis';
import type { Kit } from './restrictions';
import { type Vec, angDiff, add, buildPath, dist, fromAngle, mul, nearestOnPolyline, pathAt, segIntersect, toLocal } from './geom';
import { DT } from './sim';

export interface Approach {
  id: string;
  position: Vec;
  heading: number;
  exitHeading: number;
  rail: boolean;
}

export interface YieldEdge {
  from: string;
  to: string;
  reason: 'right' | 'left' | 'tram';
}

export interface PriorityGraph {
  ids: string[];
  edges: YieldEdge[];
  /** Слои: внутри одного слоя нет обязанности уступать друг другу. */
  order: string[][];
  cycle: string[];
  center?: Vec;
  arrival?: number;
}

/** Рёбра направлены от уступающего к тому, кому нужно уступить. */
export function buildPriorityGraph(approaches: Approach[]): PriorityGraph {
  const edges: YieldEdge[] = [];
  for (let n = 0; n < approaches.length; n++) for (let m = n + 1; m < approaches.length; m++) {
    const a = approaches[n];
    const b = approaches[m];
    const delta = Math.abs(angDiff(a.heading, b.heading));
    if (delta < 0.5) continue;
    const leftA = angDiff(a.heading, a.exitHeading) < -0.6;
    const leftB = angDiff(b.heading, b.exitHeading) < -0.6;
    if (delta > 2.1) {
      if (leftA !== leftB) {
        if (a.rail !== b.rail) edges.push({ from: a.rail ? b.id : a.id, to: a.rail ? a.id : b.id, reason: 'tram' });
        else edges.push({ from: leftA ? a.id : b.id, to: leftA ? b.id : a.id, reason: 'left' });
      }
      continue;
    }
    if (a.rail !== b.rail) {
      edges.push({ from: a.rail ? b.id : a.id, to: a.rail ? a.id : b.id, reason: 'tram' });
      continue;
    }
    const bRight = toLocal(b.position, { cx: a.position.x, cy: a.position.y, a: a.heading }).y > 0.5;
    const aRight = toLocal(a.position, { cx: b.position.x, cy: b.position.y, a: b.heading }).y > 0.5;
    if (bRight !== aRight) edges.push({ from: bRight ? a.id : b.id, to: bRight ? b.id : a.id, reason: 'right' });
  }
  const remaining = new Set(approaches.map((a) => a.id));
  const order: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((id) => !edges.some((edge) => edge.from === id && remaining.has(edge.to)));
    if (!ready.length) break;
    order.push(ready);
    ready.forEach((id) => remaining.delete(id));
  }
  return { ids: approaches.map((a) => a.id), edges, order, cycle: [...remaining] };
}

/** Встреча 3–4 ТС: намеренные маршруты и прибытие в пределах трёх секунд. */
export function collectPriorityGraphs(ctx: Ctx, kit: Kit): void {
  const centers: Vec[] = [];
  for (let a = 0; a < ctx.geo.roads.length; a++) for (let b = a + 1; b < ctx.geo.roads.length; b++) {
    const A = ctx.geo.roads[a];
    const B = ctx.geo.roads[b];
    for (let n = 1; n < A.pts.length; n++) for (let m = 1; m < B.pts.length; m++) {
      const hit = segIntersect(A.pts[n - 1], A.pts[n], B.pts[m - 1], B.pts[m]);
      if (!hit) continue;
      const p = { x: A.pts[n - 1].x + hit.t * (A.pts[n].x - A.pts[n - 1].x), y: A.pts[n - 1].y + hit.t * (A.pts[n].y - A.pts[n - 1].y) };
      if (!centers.some((q) => dist(p, q) < 10)) centers.push(p);
    }
  }
  ctx.priorityGraphs = [];
  for (const center of centers) {
    if (ctx.scene.lights.some((light) => dist(light, center) < 40) || ctx.scene.signs.some((sign) => ['2.1', '2.4', '2.5', '4.3'].includes(sign.kind) && dist(sign, center) < 40)) continue;
    const arrivals: { approach: Approach; time: number }[] = [];
    for (const i of ctx.infos.values()) {
      if (!i.isVeh || String(i.a.type) === 'train') continue;
      const start = { x: i.a.x, y: i.a.y };
      // Как в симуляции: без контрольных точек ТС продолжает движение прямо.
      const control = i.a.path.length ? i.a.path : [add(start, mul(fromAngle(i.a.heading), 2000))];
      const route = buildPath([start, ...control]);
      if (route.pts.length < 2) continue;
      const near = nearestOnPolyline(route.pts, center);
      if (near.dist > 8 || near.s < 8) continue;
      const before = pathAt(route, Math.max(0, near.s - 20));
      const after = pathAt(route, Math.min(route.total, near.s + 15));
      let closest = Infinity;
      let time: number | null = null;
      for (let k = i.k0; k <= i.kEnd; k += 4) {
        if (!i.tr.present[k] || i.tr.v[k] < 0.1) continue;
        const d = dist(kit.posAt(i, k), center);
        if (d < closest) {
          closest = d;
          if (d < 10) time = k * DT;
        }
      }
      // Только фактическое прибытие до первого удара: стоящее ТС и ещё
      // не появившиеся участники не создают фиктивных обязанностей уступить.
      if (time === null) continue;
      arrivals.push({ approach: { id: i.a.id, position: before.p, heading: before.a, exitHeading: after.a, rail: i.rail }, time });
    }
    arrivals.sort((a, b) => a.time - b.time);
    const used = new Set<string>();
    for (const arrival of arrivals) {
      if (used.has(arrival.approach.id)) continue;
      const group = arrivals.filter((x) => !used.has(x.approach.id) && x.time >= arrival.time && x.time - arrival.time <= 3);
      if (group.length < 3 || group.length > 4) continue;
      // Спецсигналы рассматриваются до общих правил равнозначного перекрёстка.
      if (group.some((x) => (ctx.infos.get(x.approach.id)!.a as { emergency?: boolean }).emergency)) continue;
      const graph = buildPriorityGraph(group.map((x) => x.approach));
      graph.center = center;
      graph.arrival = arrival.time;
      ctx.priorityGraphs.push(graph);
      group.forEach((x) => used.add(x.approach.id));
      const labels = (ids: string[]) => ids.map((id) => ctx.infos.get(id)!.label).join(', ');
      const detail = graph.cycle.length
        ? `Цикл обязанностей уступить: ${graph.edges.map((edge) => `${ctx.infos.get(edge.from)!.label} → ${ctx.infos.get(edge.to)!.label}`).join('; ')}. Автоматической очередности нет: водителям следует согласовать проезд, соблюдая безопасность и п. 13.11.`
        : `Очерёдность по графу обязанностей уступить: ${graph.order.map((layer) => labels(layer)).join(' → ')}. Участники одного слоя могут двигаться одновременно только при отсутствии конфликта траекторий.`;
      for (const { approach } of group) kit.add({ actorId: approach.id, severity: 'info', t: arrival.time, title: graph.cycle.length ? 'циклическая очерёдность: требуется договорённость водителей' : 'очерёдность разъезда нескольких ТС', detail, refs: ['pdd:13.11', ...(graph.edges.some((edge) => edge.reason === 'left') ? ['pdd:13.12'] : [])] });
    }
  }
}

export function graphPriority(ctx: Ctx, a: Info, b: Info, frame: number): { cycle: boolean; yielder: Info | null; other: Info | null; reason: 'right' | 'left' | 'tram' | null; explain: string } | null {
  const graph = ctx.priorityGraphs?.find((g) => g.ids.includes(a.a.id) && g.ids.includes(b.a.id) && Math.abs(frame * DT - (g.arrival ?? 0)) <= 6);
  if (!graph) return null;
  if (graph.cycle.length) return { cycle: true, yielder: null, other: null, reason: null, explain: 'В графе приоритетов нескольких ТС есть цикл «помеха справа»: водителям следовало согласовать безопасный проезд; единственного участника с преимуществом по этим данным нет (п. 13.11).' };
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return graph.edges.some((edge) => edge.from === from && (edge.to === to || reaches(edge.to, to, seen)));
  };
  const aYields = reaches(a.a.id, b.a.id);
  const bYields = reaches(b.a.id, a.a.id);
  if (aYields === bYields) return null;
  const yielder = aYields ? a : b;
  const other = aYields ? b : a;
  const reason = graph.edges.find((edge) => edge.from === yielder.a.id)?.reason ?? 'right';
  return { cycle: false, yielder, other, reason, explain: `${yielder.label} должен был дождаться ${other.label} согласно графу разъезда ${graph.ids.length} ТС на равнозначном перекрёстке.` };
}
