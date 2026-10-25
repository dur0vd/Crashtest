import type { Ctx, Info } from './analysis';
import { roadsAt } from './geo';
import { dist, dot, fromAngle, nearestOnPolyline, sub, toLocal } from './geom';

/** Кольцо — замкнутая односторонняя дорога, обозначенная на въезде знаком 4.3. */
export function roundaboutPriority(ctx: Ctx, A: Info, B: Info, frame: number): { entering: Info; circulating: Info } | null {
  for (const ring of ctx.geo.roads) {
    const pts = ring.road.pts;
    if (!ring.road.oneWay || pts.length < 4 || dist(pts[0], pts[pts.length - 1]) > 1) continue;
    const signs = ctx.scene.signs.filter((s) => s.kind === '4.3' && nearestOnPolyline(ring.pts, s).dist < 30);
    if (!signs.length) continue;
    const onRing = (i: Info, k: number) => roadsAt(ctx.geo, { x: i.tr.x[k], y: i.tr.y[k] }, 0.5).some((h) => h.rg === ring);
    const entry = (i: Info): { frame: number } | undefined => {
      const crossed = ctx.gates.filter((g) => g.actorId === i.a.id && g.sign && signs.includes(g.sign) && g.frame <= frame && i.trav[frame] - g.dist < 50).at(-1);
      if (crossed) return crossed;
      // Сцена может начинаться после знака: обязанность уступить сохраняется.
      // Восстанавливаем только знак того же подъезда, обращённый к участнику,
      // пока тот ещё находится перед кольцом, а не уже движется по нему.
      if (onRing(i, i.k0) || i.trav[frame] >= 50) return undefined;
      const start = { x: i.tr.x[i.k0], y: i.tr.y[i.k0] };
      const approaches = roadsAt(ctx.geo, start, 0.5).filter((h) => h.rg !== ring);
      if (!approaches.length) return undefined;
      const passed = signs.some((sign) => {
        const direction = fromAngle(sign.angle);
        if (dot(direction, fromAngle(i.tr.h[i.k0])) < 0.5) return false;
        const relative = toLocal(start, { cx: sign.x, cy: sign.y, a: sign.angle });
        if (relative.x < -i.hl - i.shift || relative.x > 30) return false;
        if (!roadsAt(ctx.geo, sign, 3).some((h) => approaches.some((a) => a.rg === h.rg))) return false;
        const nearestRing = nearestOnPolyline(ring.pts, start);
        return nearestRing.dist < 30 && dot(sub(nearestRing.point, start), direction) > 0;
      });
      return passed ? { frame: i.k0 } : undefined;
    };
    const ea = entry(A);
    const eb = entry(B);
    // ТС, уже ехавшее по кольцу до въезда другого, пользуется преимуществом.
    if (ea && onRing(B, Math.max(B.k0, ea.frame - 1)) && !onRing(A, Math.max(A.k0, ea.frame - 1))) return { entering: A, circulating: B };
    if (eb && onRing(A, Math.max(A.k0, eb.frame - 1)) && !onRing(B, Math.max(B.k0, eb.frame - 1))) return { entering: B, circulating: A };
  }
  return null;
}
