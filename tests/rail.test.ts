import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { emptyScene, VEHICLES, type Actor, type Scene } from '../src/scene';
import { simulate } from '../src/sim';

function scene(): Scene {
  const s = emptyScene();
  s.env.duration = 25;
  s.roads.push({ id: 'r1', pts: [{ x: -120, y: 0 }, { x: 120, y: 0 }], lanes: 2, center: 'none', oneWay: false, zone: 'city', smooth: false });
  s.tracks.push({ id: 't1', pts: [{ x: -120, y: 1.75 }, { x: 0, y: 1.75 }, { x: 40, y: 12 }, { x: 120, y: 12 }], separated: false, smooth: false });
  return s;
}

function actor(type: 'tram' | 'car', id: string, x: number, y: number, h: number, speed: number, path: [number, number][], o: Partial<Actor> = {}): Actor {
  return { id, kind: 'vehicle', type, x, y, heading: h, color: VEHICLES[type].color, speed, delay: 0, path: path.map(([px, py]) => ({ x: px, y: py, v: speed })), flags: { drunk: false, noLicense: false, flees: false }, ...o };
}

describe('трамвай на рельсах', () => {
  it('едет по колее, даже если маршрут нарисован мимо путей', () => {
    const s = scene();
    s.actors.push(actor('tram', 'a1', -100, 1.9, 0, 36, [[-40, 5], [30, -3], [115, 12.5]]));
    const tr = simulate(s).tracks.get('a1')!;
    let worst = 0;
    for (let k = 0; k < tr.x.length; k += 5) {
      const x = tr.x[k];
      const y = tr.y[k];
      let expected: number;
      if (x <= 0) expected = 1.75;
      else if (x <= 40) expected = 1.75 + ((x / 40) * (12 - 1.75));
      else expected = 12;
      // допуск по Y: на наклонном участке отклонение по нормали больше
      worst = Math.max(worst, Math.abs(y - expected));
    }
    expect(worst).toBeLessThan(1.5);
    expect(tr.x[tr.x.length - 1]).toBeGreaterThan(40);
  });

  it('удар не сбивает трамвай с рельсов, он тормозит на пути', () => {
    const s = scene();
    s.actors.push(actor('tram', 'a1', -80, 1.75, 0, 36, [[-5, 1.75]]));
    // автомобиль выезжает на рельсы сбоку
    s.actors.push(actor('car', 'a2', -30, -45, Math.PI / 2, 40, [[-30, 20]]));
    const tl = simulate(s);
    expect(tl.collisions.length).toBeGreaterThan(0);
    const tr = tl.tracks.get('a1')!;
    for (let k = 0; k < tr.x.length; k += 10) expect(Math.abs(tr.y[k] - 1.75)).toBeLessThan(0.05);
    expect(tr.free[tr.free.length - 1]).toBe(0);
    expect(tr.v[tr.v.length - 1]).toBeLessThan(0.5);
  });

  it('со сходом: сильный удар выбрасывает трамвай с путей', () => {
    const s = scene();
    s.actors.push(actor('tram', 'a1', -80, 1.75, 0, 36, [[-5, 1.75]], { derail: true }));
    s.actors.push(actor('car', 'a2', -30, -65, Math.PI / 2, 60, [[-30, 20]]));
    const tl = simulate(s);
    const tr = tl.tracks.get('a1')!;
    expect(tr.free[tr.free.length - 1]).toBe(1);
  });

  it('готовый пример с трамваем работает как раньше', () => {
    const sc = PRESETS.find((p) => p.id === 'tram')!.build();
    expect(simulate(sc).tracks.size).toBe(2);
  });
});
