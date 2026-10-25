import type { Ctx, Info } from './analysis';
import type { Kit } from './restrictions';
import { densify, roadsAt, widthsAt } from './geo';
import { type OBB, type Vec, angDiff, dist, distToSegment, dot, fromAngle, nearestOnPolyline, obbContact, obbCorners, pointInObb, segIntersect, toLocal } from './geom';
import { DT } from './sim';

/** Неподвижные интервалы до первого удара: остановка из-за удара сюда не попадает. */
export function stationaryIntervals(i: Info): { start: number; end: number; parking: boolean }[] {
  const out: { start: number; end: number; parking: boolean }[] = [];
  let start = -1;
  for (let k = i.k0; k <= i.kEnd + 1; k++) {
    const stopped = k <= i.kEnd && i.tr.present[k] && i.tr.v[k] < 0.03;
    if (stopped && start < 0) start = k;
    if (!stopped && start >= 0) {
      const end = k - 1;
      if ((end - start) * DT >= 0.5) out.push({ start, end, parking: !!i.a.parking || (end - start) * DT > 300 });
      start = -1;
    }
  }
  return out;
}

/** Минимальный просвет между кузовом и ломаной (0 при пересечении). */
function distanceToBody(box: OBB, pts: Vec[]): number {
  const corners = obbCorners(box);
  let best = Infinity;
  for (const point of pts) {
    const local = toLocal(point, box);
    best = Math.min(best, Math.hypot(Math.max(0, Math.abs(local.x) - box.hl), Math.max(0, Math.abs(local.y) - box.hw)));
  }
  for (let n = 1; n < pts.length; n++) {
    const a = pts[n - 1];
    const b = pts[n];
    if (corners.some((q, index) => segIntersect(a, b, q, corners[(index + 1) % corners.length]))) return 0;
    best = Math.min(best, ...corners.map((q) => distToSegment(q, a, b)));
  }
  return best;
}

export function checkParkingRules(ctx: Ctx, kit: Kit): void {
  const stopMarkings = ctx.scene.markings
    .filter((marking) => ['1.17.1', '1.17.2'].includes(marking.kind) && marking.pts.length >= 2)
    .map((marking) => ({ marking, pts: densify(marking.pts, !!marking.smooth, marking.radius ?? 0) }));
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || i.rail) continue;
    for (const interval of stationaryIntervals(i)) {
      const seen = new Set<string>();
      const k = interval.start;
      // Остановка для выполнения требования светофора, знака или пропуска участника —
      // часть движения; флаг стоянки позволяет явно задать намеренное прекращение движения.
      if (!interval.parking && !i.a.unattended && kit.reasonToBrake(ctx, i, k)) continue;
      const p = kit.posAt(i, k);
      const box = kit.boxAt(i, k);
      const corners = obbCorners(box);
      const name = interval.parking ? 'стоянка' : 'остановка';
      const add = (key: string, title: string, detail: string, refs: string[]) => {
        if (seen.has(key)) return;
        seen.add(key);
        kit.add({ actorId: i.a.id, severity: 'violation', t: k * DT, title, detail, refs });
      };
      for (const cw of ctx.geo.crosswalks) {
        const local = toLocal({ x: cw.box.cx, y: cw.box.cy }, { cx: box.cx, cy: box.cy, a: box.a });
        const extent = Math.abs(dot(fromAngle(box.a), fromAngle(cw.box.a))) * cw.box.hl +
          Math.abs(Math.sin(angDiff(box.a, cw.box.a))) * cw.box.hw;
        const lateral = Math.abs(local.y) <= cw.box.hl + box.hw;
        const before = local.x - extent - box.hl;
        if (obbContact(box, cw.box) || (lateral && before >= 0 && before < 5)) {
          add('crosswalk', `${name} на переходе или ближе 5 м перед ним`, 'Расстояние считается от переднего габарита ТС до ближайшей границы перехода по ходу движения.', ['pdd:12.4', ...(interval.parking ? ['pdd:12.5'] : []), 'koap:12.19.3']);
        }
      }
      const blocksTrack = ctx.geo.tracks.some((track) => {
        for (let n = 1; n < track.pts.length; n++) {
          const a = track.pts[n - 1];
          const b = track.pts[n];
          if (pointInObb(a, box, 1) || pointInObb(b, box, 1)) return true;
          if (corners.some((q) => distToSegment(q, a, b) < 1)) return true;
          if (corners.some((q, index) => segIntersect(a, b, q, corners[(index + 1) % corners.length]))) return true;
        }
        return false;
      });
      if (blocksTrack) {
        add('tram', `${name} на трамвайных путях`, 'ТС занимает габарит трамвайного пути и создаёт препятствие трамваю.', ['pdd:12.4', ...(interval.parking ? ['pdd:12.5'] : []), 'koap:12.19.3.2']);
      }
      const road = roadsAt(ctx.geo, p, i.hw)[0];
      if (road) {
        for (const other of ctx.geo.roads) {
          if (other === road.rg || other.pts.length < 2) continue;
          const near = nearestOnPolyline(other.pts, p);
          if (Math.abs(dot(near.tangent, road.near.tangent)) > 0.8) continue;
          if (near.beyond) {
            // Конец бокового проезда внутри основной дороги образует Т-перекрёсток.
            if (!roadsAt(ctx.geo, near.point).some((hit) => hit.rg === road.rg)) continue;
            const inside = near.s < 0.01 ? other.pts[1] : other.pts[other.pts.length - 2];
            const normal = { x: -road.near.tangent.y, y: road.near.tangent.x };
            const branchSide = dot({ x: inside.x - near.point.x, y: inside.y - near.point.y }, normal);
            const opposite = corners.every((q) => dot({ x: q.x - near.point.x, y: q.y - near.point.y }, normal) * branchSide < 0);
            // Исключение п. 12.4 действует напротив бокового проезда только при сплошной.
            if (opposite && ['solid', 'double'].includes(road.rg.road.center)) continue;
          }
          const w = widthsAt(other, near.s);
          const side = near.d >= 0 ? w.r : w.l;
          const offsets = corners.map((q) => dot({ x: q.x - near.point.x, y: q.y - near.point.y }, { x: -near.tangent.y, y: near.tangent.x }));
          const bodyEdge = Math.min(...offsets) <= 0 && Math.max(...offsets) >= 0 ? 0 : Math.min(...offsets.map(Math.abs));
          if (bodyEdge - side < 5) add('junction', `${name} на перекрёстке или ближе 5 м к пересекаемой проезжей части`, 'Проверяется расстояние от габарита ТС до края поперечной проезжей части.', ['pdd:12.4', ...(interval.parking ? ['pdd:12.5'] : []), 'koap:12.19.1']);
        }
        const w = widthsAt(road.rg, road.near.s);
        const lat = corners.map((q) => dot({ x: q.x - road.near.point.x, y: q.y - road.near.point.y }, { x: -road.near.tangent.y, y: road.near.tangent.x }));
        // Сплошная осевая отделяет встречную часть: её нельзя считать свободным объездом.
        let leftEdge = -w.l;
        let rightEdge = w.r;
        if (!road.rg.road.oneWay && ['solid', 'double'].includes(road.rg.road.center)) {
          if (road.near.d >= 0) leftEdge = 0;
          else rightEdge = 0;
        }
        const passage = Math.max(Math.min(...lat) - leftEdge, rightEdge - Math.max(...lat));
        if (passage < 3 && Math.min(...lat) < rightEdge && Math.max(...lat) > leftEdge) {
          add('passage', `${name} оставляет менее 3 м для проезда`, `Наибольший непрерывный просвет до края проезжей части или сплошной осевой — ${Math.max(0, passage).toFixed(1)} м.`, ['pdd:12.4', ...(interval.parking ? ['pdd:12.5'] : []), 'koap:12.19.4']);
        }
      }
      for (const { marking, pts } of stopMarkings) {
        const near = nearestOnPolyline(pts, p);
        if (Math.abs(dot(near.tangent, fromAngle(i.tr.h[k]))) < 0.5) continue;
        const local = toLocal(near.point, { cx: p.x, cy: p.y, a: i.tr.h[k] });
        if (Math.abs(local.y) > 8) continue;
        if (road) {
          const markerSide = nearestOnPolyline(road.rg.pts, near.point).d;
          if (markerSide * road.near.d < 0 && Math.abs(markerSide) > 1 && Math.abs(road.near.d) > 1) continue;
        }
        if (distanceToBody(box, pts) < 15) add('bus', `${name} ближе 15 м к остановке маршрутного транспорта`, 'При наличии разметки место остановки и отсчёт 15 м определяются по её границам. Посадка/высадка без помех маршрутному транспорту отдельно не задана.', ['pdd:12.4', ...(interval.parking ? ['pdd:12.5'] : []), `marking:${marking.kind}`, 'koap:12.19.3.1']);
      }
      for (const sign of ctx.scene.signs) {
        if (!['5.16', '5.17', '5.18'].includes(sign.kind)) continue;
        // Указатель задаёт отсчёт только при отсутствии разметки этой остановки.
        const markedStop = stopMarkings.some(({ pts }) => {
          const near = nearestOnPolyline(pts, sign);
          const local = toLocal(near.point, { cx: sign.x, cy: sign.y, a: sign.angle });
          return near.dist <= 40 && Math.abs(local.y) <= 8 && Math.abs(dot(near.tangent, fromAngle(sign.angle))) > 0.5;
        });
        if (markedStop) continue;
        const local = toLocal(sign, { cx: p.x, cy: p.y, a: i.tr.h[k] });
        // Знак остановки относится к той же стороне дороги и направлению.
        if (Math.abs(angDiff(sign.angle, i.tr.h[k])) > 0.7 || Math.abs(local.y) > 8) continue;
        const edgeDistance = Math.max(0, dist(p, sign) - i.hl);
        if (edgeDistance < 15) add('bus', `${name} ближе 15 м к остановке маршрутного транспорта`, 'В модели не задана посадка/высадка без помех маршрутному транспорту; положение остановки задаётся знаком 5.16–5.18.', ['pdd:12.4', ...(interval.parking ? ['pdd:12.5'] : []), 'koap:12.19.3.1']);
      }
      if (i.a.unattended && i.a.secured === false) add('unsecured', 'водитель оставил ТС без необходимых мер', 'Не приняты меры, исключающие самопроизвольное движение ТС и использование его в отсутствие водителя.', ['pdd:12.8', 'koap:12.19.1']);
    }
  }
}

/** Удар по неподвижному ТС связывает выявленную помеху с ДТП, но не снимает обязанностей с другого водителя. */
export function markParkingCausal(ctx: Ctx): void {
  for (const collision of ctx.tl.collisions) {
    for (const id of [collision.a, collision.b]) {
      const i = ctx.infos.get(id);
      if (!i || i.tr.v[Math.max(i.k0, collision.frame - 1)] >= 0.03) continue;
      const current = stationaryIntervals(i).find((interval) => interval.start <= collision.frame - 1 && interval.end >= collision.frame - 1);
      if (!current) continue;
      for (const f of ctx.findings) {
        if (f.actorId === id && f.severity === 'violation' && f.t !== undefined && Math.abs(f.t - current.start * DT) < 1e-6 && f.refs.includes('pdd:12.4')) f.causal = true;
      }
    }
  }
}
