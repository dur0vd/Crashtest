import { describe, expect, it } from 'vitest';
import { angDiff, buildPath, nearestOnPolyline, obbContact, pathAt, rad, segIntersect, smoothPolyline } from '../src/geom';

describe('геометрия', () => {
  it('приводит разность углов к (-π, π]', () => {
    expect(angDiff(rad(170), rad(-170))).toBeCloseTo(rad(20));
    expect(angDiff(0, rad(90))).toBeCloseTo(rad(90));
  });

  it('смещение от оси положительно справа по ходу', () => {
    const r = nearestOnPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 5, y: 2 });
    expect(r.d).toBeCloseTo(2);
    expect(r.s).toBeCloseTo(5);
  });

  it('находит пересечение отрезков', () => {
    expect(segIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 })).not.toBeNull();
    expect(segIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeNull();
  });

  it('сплайн проходит через заданные точки', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }];
    const sm = smoothPolyline(pts, 10);
    for (let i = 0; i < pts.length; i++) {
      expect(sm.pts[sm.nodeIdx[i]].x).toBeCloseTo(pts[i].x);
      expect(sm.pts[sm.nodeIdx[i]].y).toBeCloseTo(pts[i].y);
    }
  });

  it('путь продолжается по прямой за последней точкой', () => {
    const p = buildPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], false);
    expect(pathAt(p, 15).p.x).toBeCloseTo(15);
  });

  it('контакт выбирает грань, которой тела коснулись первыми', () => {
    // машина едет вправо на пешехода, который чуть задел её передний угол
    const car = { cx: 0, cy: 0, hl: 2.25, hw: 0.9, a: 0 };
    const ped = { cx: 2.3, cy: 1.0, hl: 0.25, hw: 0.25, a: Math.PI / 2 };
    const c = obbContact(car, ped, { x: 14, y: -1.4 })!;
    expect(Math.abs(c.n.x)).toBeGreaterThan(0.9);
  });
});
