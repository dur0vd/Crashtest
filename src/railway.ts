import type { Ctx } from './analysis';
import { add, dot, fromAngle, mul, obbCorners, sub, type Vec } from './geom';
import type { Kit } from './restrictions';
import { GAUGE, type RailwayCrossing } from './scene';
import { visibilityAt } from './visibility';

export function railwayPoints(r: RailwayCrossing): Vec[] {
  const d = mul(fromAngle(r.angle), r.length / 2);
  return [sub(r, d), add(r, d)];
}

export function railwayState(r: RailwayCrossing, t: number): { red: boolean; closed: boolean; train: boolean } {
  const train = r.trainWindows.some((w) => t >= w.start && t < w.end);
  return { red: r.red || train, closed: r.barrier === 'closed' || (r.barrier !== 'none' && train), train };
}

/** Переезд рассматривается в локальных координатах: x вдоль рельсов, y поперёк. */
export function checkRailwayRules(ctx: Ctx, kit: Kit): void {
  for (const r of ctx.scene.railways ?? []) {
    const along = fromAngle(r.angle);
    const normal = fromAngle(r.angle + Math.PI / 2);
    const local = (p: Vec) => ({ x: dot(sub(p, r), along), y: dot(sub(p, r), normal) });
    for (const i of ctx.infos.values()) {
      if (!i.isVeh || i.a.type === 'train') continue;
      let entered = false;
      let stopped = false;
      let bypassed = false;
      for (let k = i.k0; k <= i.kEnd; k++) {
        if (!i.tr.present[k] || i.tr.free[k]) continue;
        const p = local(kit.posAt(i, k));
        const box = kit.boxAt(i, k);
        const corners = obbCorners(box).map(local);
        const nearRail = Math.min(...corners.map((q) => Math.abs(q.y))) - GAUGE / 2;
        const inWidth = Math.abs(p.x) <= r.width / 2 + i.hw;
        const overlaps = corners.some((q) => Math.abs(q.y) <= GAUGE / 2) || (Math.min(...corners.map((q) => q.y)) < -GAUGE / 2 && Math.max(...corners.map((q) => q.y)) > GAUGE / 2);
        const t = k * ctx.tl.dt;
        const state = railwayState(r, t);
        const approachingTrain = [...ctx.infos.values()].some((train) => {
          if (train.a.type !== 'train' || train.a.railwayId !== r.id || !train.tr.present[k]) return false;
          const q = local(kit.posAt(train, k));
          const alongSpeed = dot(fromAngle(train.tr.h[k]), along) * train.tr.v[k];
          const occupiesCrossing = Math.abs(q.x) <= train.hl + r.width / 2;
          // Поезд считается приближающимся, пока водитель может его видеть (ч. 1 ст. 12.10 КоАП:
          // «в пределах видимости»); дальность — та же учебная видимость, что и в расчёте техвозможности.
          const approaches = q.x * alongSpeed < 0 && Math.abs(q.x) <= train.hl + Math.max(50, visibilityAt(ctx, i, k));
          return train.tr.v[k] > 0.1 && (occupiesCrossing || approaches);
        });
        // После полного выезда следующее пересечение проверяется заново.
        // Пока кузов внутри границы переезда, смена сигнала не создаёт нового въезда.
        if (!overlaps && nearRail >= 5.1) entered = false;
        // Въезд фиксируем только при достижении границы переезда; смена
        // сигнала после законного въезда не превращает его в нарушение задним числом.
        if (!entered && (overlaps || nearRail < 5) && inWidth && i.tr.v[k] > 0.1) {
          entered = true;
          if (state.red || state.closed || state.train || approachingTrain) {
            const reason = state.closed ? 'закрытом шлагбауме' : state.red ? 'мигающем красном сигнале' : 'приближающемся поезде';
            kit.add({ actorId: i.a.id, severity: 'violation', t, causal: ctx.tl.collisions.some((c) => (c.a === i.a.id || c.b === i.a.id) && (ctx.infos.get(c.a)?.a.type === 'train' || ctx.infos.get(c.b)?.a.type === 'train')), title: 'въезд на запрещённый железнодорожный переезд', detail: `Въезд при ${reason}. Следовало остановиться до переезда.`, refs: ['pdd:15.1', 'pdd:15.3', 'koap:12.10.1'] });
          }
        }
        if (!bypassed && state.closed && overlaps && !inWidth && Math.abs(p.x) < r.width / 2 + 15 && i.tr.v[k] > 0.1) {
          bypassed = true;
          kit.add({ actorId: i.a.id, severity: 'violation', t, title: 'объезд закрытого шлагбаума', detail: 'Участник пересёк рельсы рядом с автомобильным проездом при закрытом шлагбауме.', refs: ['pdd:15.3', 'koap:12.10.1'] });
        }
        // Без стоп-линии и знака 2.5: 5 м до шлагбаума, без него — 10 м до рельса.
        // Шлагбаум модели находится в 5 м от крайнего рельса.
        const required = 10;
        const signedStop = ctx.scene.signs.some((s) => s.kind === '2.5' && Math.abs(local(s).x) < r.width / 2 + 2 && Math.abs(local(s).y - p.y) < 20);
        const stopLine = ctx.scene.markings.some((m) => m.kind === '1.12' && m.pts.some((q) => Math.abs(local(q).x) < r.width / 2 + 2 && Math.abs(local(q).y - p.y) < 20));
        if (!stopped && inWidth && (state.red || state.closed || state.train) && !signedStop && !stopLine && !overlaps && nearRail >= 0 && nearRail < required - 0.05 && i.tr.v[k] < 0.05) {
          stopped = true;
          kit.add({ actorId: i.a.id, severity: 'violation', t, title: 'остановка слишком близко к переезду', detail: r.barrier === 'none' ? 'Без шлагбаума, стоп-линии и знака 2.5 следует остановиться не ближе 10 м до ближайшего рельса (п. 15.4).' : 'Без стоп-линии и знака 2.5 следует остановиться не ближе 5 м до шлагбаума (п. 15.4).', refs: ['pdd:15.4', 'koap:12.10.2'] });
        }
        if (!stopped && inWidth && overlaps && i.tr.v[k] < 0.05) {
          stopped = true;
          kit.add({ actorId: i.a.id, severity: 'violation', t, title: 'остановка на железнодорожном переезде', detail: 'Задана остановка на рельсах. При вынужденной остановке нужны действия по п. 15.5 ПДД.', refs: ['pdd:12.4', 'pdd:15.5', 'koap:12.10.1'] });
        }
      }
    }
  }
}
