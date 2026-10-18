import { describe, expect, it } from 'vitest';
import { buildGeo, buildRoadGeo, profileAt, roadOutlinePoly, roadsAt, widthsAt } from '../src/geo';
import { filletPolyline, dist } from '../src/geom';
import { emptyScene, normalizeScene } from '../src/scene';
import { PRESETS } from '../src/presets';

const road = (over = {}) => ({
  id: 'r1',
  pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  lanes: 1,
  center: 'dashed' as const,
  oneWay: false,
  zone: 'city' as const,
  smooth: false,
  ...over,
});

describe('скругление поворотов', () => {
  it('заменяет угол дугой и сохраняет концы', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const out = filletPolyline(pts, 10);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[2]);
    expect(out.length).toBeGreaterThan(5);
    // угловая вершина больше не лежит на линии
    expect(Math.min(...out.map((p) => dist(p, pts[1])))).toBeGreaterThan(1);
  });

  it('уменьшает радиус на коротких отрезках, не выходя за них', () => {
    const out = filletPolyline([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }], 100);
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(6 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      expect(p.y).toBeLessThanOrEqual(6 + 1e-6);
    }
  });
});

describe('профиль кромок и сужения', () => {
  it('интерполирует ширину между точками', () => {
    const prof = [{ s: 0, w: 3.5 }, { s: 10, w: 1.5 }];
    expect(profileAt(prof, 3.5, 5)).toBeCloseTo(2.5);
    expect(profileAt(prof, 3.5, -4)).toBe(3.5);
    expect(profileAt(prof, 3.5, 99)).toBe(1.5);
    expect(profileAt(undefined, 3.5, 5)).toBe(3.5);
  });

  it('сужение меняет контур и зону проезжей части только на своём участке', () => {
    const s = emptyScene();
    s.roads.push(
      road({
        wr: [
          { s: 0, w: 3.5 },
          { s: 30, w: 3.5 },
          { s: 40, w: 1.5 },
          { s: 60, w: 1.5 },
          { s: 70, w: 3.5 },
          { s: 100, w: 3.5 },
        ],
      }),
    );
    const geo = buildGeo(s);
    const rg = geo.roads[0];
    expect(widthsAt(rg, 50).r).toBeCloseTo(1.5);
    expect(widthsAt(rg, 50).l).toBeCloseTo(3.5);
    // справа на y = 3 дорога есть до сужения и нет в его середине
    expect(roadsAt(geo, { x: 10, y: 3 }).length).toBe(1);
    expect(roadsAt(geo, { x: 50, y: 3 }).length).toBe(0);
    // слева ширина не изменилась
    expect(roadsAt(geo, { x: 50, y: -3 }).length).toBe(1);
    // контур содержит узлы на станциях профиля
    const poly = roadOutlinePoly(rg);
    expect(poly.some((p) => Math.abs(p.x - 40) < 1e-6 && Math.abs(p.y - 1.5) < 1e-6)).toBe(true);
  });

  it('кромки независимы от поворота оси: ширина сохраняется на дуге', () => {
    const rg = buildRoadGeo(road({ pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], radius: 10 }));
    for (let i = 0; i < rg.samples.length; i++) {
      const w = dist(rg.samples[i].p, rg.right[i]);
      expect(w).toBeGreaterThan(3.4);
      expect(w).toBeLessThan(5.1); // небольшая компенсация на изгибе
    }
  });

  it('нормализация отбрасывает мусор и сортирует точки профиля', () => {
    const s = normalizeScene({ roads: [road({ wr: [{ s: 9, w: 2 }, { s: 1, w: 3 }, { s: 'x', w: 1 }], radius: -4 })] });
    expect(s.roads[0].wr!.map((e) => e.s)).toEqual([1, 9]);
    expect(s.roads[0].radius).toBe(0);
  });

  it('готовые ситуации по-прежнему разбираются после смены геометрии дорог', () => {
    for (const p of PRESETS) {
      const scene = p.build();
      expect(() => buildGeo(scene)).not.toThrow();
    }
  });
});
