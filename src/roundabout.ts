import type { Ctx, Info } from './analysis';
import { roadsAt } from './geo';
import { dist, nearestOnPolyline } from './geom';

/** Кольцо — замкнутая односторонняя дорога, обозначенная на въезде знаком 4.3. */
export function roundaboutPriority(ctx: Ctx, A: Info, B: Info, frame: number): { entering: Info; circulating: Info } | null {
  for (const ring of ctx.geo.roads) {
    const pts = ring.road.pts;
    if (!ring.road.oneWay || pts.length < 4 || dist(pts[0], pts[pts.length - 1]) > 1) continue;
    const signs = ctx.scene.signs.filter((s) => s.kind === '4.3' && nearestOnPolyline(ring.pts, s).dist < 30);
    if (!signs.length) continue;
    const onRing = (i: Info, k: number) => roadsAt(ctx.geo, { x: i.tr.x[k], y: i.tr.y[k] }, 0.5).some((h) => h.rg === ring);
    const entry = (i: Info) => ctx.gates.filter((g) => g.actorId === i.a.id && g.sign && signs.includes(g.sign) && g.frame <= frame && i.trav[frame] - g.dist < 50).at(-1);
    const ea = entry(A);
    const eb = entry(B);
    // ТС, уже ехавшее по кольцу до въезда другого, пользуется преимуществом.
    if (ea && onRing(B, Math.max(B.k0, ea.frame - 1)) && !onRing(A, Math.max(A.k0, ea.frame - 1))) return { entering: A, circulating: B };
    if (eb && onRing(A, Math.max(A.k0, eb.frame - 1)) && !onRing(B, Math.max(B.k0, eb.frame - 1))) return { entering: B, circulating: A };
  }
  return null;
}
