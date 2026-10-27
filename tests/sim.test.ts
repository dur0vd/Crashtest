import { describe, expect, it } from 'vitest';
import { simulate } from '../src/sim';
import { emptyScene, NO_CARGO, type Actor, type Scene } from '../src/scene';
import { rad } from '../src/geom';

function car(id: string, x: number, y: number, headingDeg: number, speed: number, path: Actor['path'] = []): Actor {
  return {
    id,
    kind: 'vehicle',
    type: 'car',
    x,
    y,
    heading: rad(headingDeg),
    color: '#fff',
    speed,
    delay: 0,
    path,
    flags: { drunk: false, noLicense: false, flees: false },
  };
}

describe('simulate', () => {
  it('держит постоянную скорость без путевых точек', () => {
    const s = emptyScene();
    s.env.duration = 4;
    s.actors.push(car('a1', 0, 0, 0, 36));
    const tl = simulate(s);
    const tr = tl.tracks.get('a1')!;
    expect(tr.x[tl.n - 1]).toBeGreaterThan(38);
    expect(tr.x[tl.n - 1]).toBeLessThan(41);
  });

  it('останавливается в точке с нулевой скоростью', () => {
    const s = emptyScene();
    s.env.duration = 10;
    s.actors.push(car('a1', 0, 0, 0, 54, [{ x: 60, y: 0, v: 0 }]));
    const tl = simulate(s);
    const tr = tl.tracks.get('a1')!;
    expect(Math.abs(tr.x[tl.n - 1] - 60)).toBeLessThan(0.5);
    expect(tr.v[tl.n - 1]).toBeLessThan(0.1);
  });

  it('фиксирует лобовое столкновение и гасит скорость', () => {
    const s = emptyScene();
    s.env.duration = 6;
    s.actors.push(car('a1', 0, 0, 0, 54));
    s.actors.push(car('a2', 80, 0, 180, 54));
    const tl = simulate(s);
    expect(tl.collisions.length).toBe(1);
    const c = tl.collisions[0];
    expect(c.kind).toBe('vv');
    expect(c.t).toBeGreaterThan(2);
    expect(c.t).toBeLessThan(3);
    expect(tl.tracks.get('a1')!.v[tl.n - 1]).toBeLessThan(1);
  });
});

function sideImpact(x = -1.6): Scene {
  const s = emptyScene();
  s.env.duration = 8;
  s.actors.push(car('target', 0, 0, 0, 0));
  s.actors.push(car('striker', x, -20, 90, 36));
  return s;
}

describe('вращение кузовов после удара', () => {
  it('боковой удар в заднюю часть разворачивает кузов и учитывает вращение в импульсе', () => {
    const tl = simulate(sideImpact());
    const c = tl.collisions[0];
    expect(c).toBeDefined();
    const target = tl.tracks.get('target')!;
    expect(Math.abs(target.h[tl.n - 1])).toBeGreaterThan(0.05);
    // При внецентренном ударе часть энергии уходит во вращение: поступательный
    // импульс меньше, чем у двух тел с той же массой без вращения.
    expect(c.dvA).toBeLessThan(((1 + 0.12) * c.rel) / 2);
    expect(c.dvA).toBeGreaterThan(0);
    expect(target.free[tl.n - 1]).toBe(1);
  });

  it('зеркальные боковые удары вращают кузов в противоположные стороны', () => {
    const left = simulate(sideImpact(-1.6));
    const right = simulate(sideImpact(1.6));
    const lh = left.tracks.get('target')!.h[left.n - 1];
    const rh = right.tracks.get('target')!.h[right.n - 1];
    expect(lh * rh).toBeLessThan(0);
    expect(Math.abs(lh)).toBeCloseTo(Math.abs(rh), 5);
  });

  it('центральный лобовой удар не создаёт заметного вращения', () => {
    const s = emptyScene();
    s.env.duration = 6;
    s.actors.push(car('a1', -30, 0, 0, 36), car('a2', 30, 0, 180, 36));
    const tl = simulate(s);
    expect(tl.collisions).toHaveLength(1);
    expect(Math.abs(tl.tracks.get('a1')!.h[tl.n - 1])).toBeLessThan(1e-5);
    expect(Math.abs(tl.tracks.get('a2')!.h[tl.n - 1] - Math.PI)).toBeLessThan(1e-5);
  });

  it('считает плечо удара от смещённого центра кузова с грузом', () => {
    const s = sideImpact(1.5);
    s.actors[0].cargo = { ...NO_CARGO, mass: 400, front: 3 };
    const tl = simulate(s);
    expect(tl.collisions).toHaveLength(1);
    expect(tl.collisions[0].point.x).toBeCloseTo(1.5, 5);
    expect(Math.abs(tl.tracks.get('target')!.h[tl.n - 1])).toBeLessThan(1e-5);
  });

  it('трение останавливает вращение, а на льду кузов разворачивается сильнее', () => {
    const dryScene = sideImpact();
    const dry = simulate(dryScene);
    const iceScene = sideImpact();
    iceScene.env.surface = 'ice';
    const ice = simulate(iceScene);
    const td = dry.tracks.get('target')!;
    const ti = ice.tracks.get('target')!;
    expect(Math.abs(ti.h[ice.n - 1])).toBeGreaterThan(Math.abs(td.h[dry.n - 1]));
    expect(td.h[dry.n - 1]).toBe(td.h[dry.n - 41]);
    expect(ti.h[ice.n - 1]).toBe(ti.h[ice.n - 41]);
  });

  it('повторный запуск даёт те же траектории и углы', () => {
    const s = sideImpact();
    const a = simulate(s);
    const b = simulate(s);
    expect(a.collisions).toEqual(b.collisions);
    for (const id of a.tracks.keys()) expect(a.tracks.get(id)).toEqual(b.tracks.get(id));
  });

  it('трамвай, удерживаемый рельсами, не вращается от внецентренного удара', () => {
    const s = sideImpact(-5);
    s.tracks.push({ id: 't1', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], separated: false, smooth: false });
    s.actors[0].type = 'tram';
    const tl = simulate(s);
    expect(tl.collisions).toHaveLength(1);
    const tram = tl.tracks.get('target')!;
    expect(Array.from(tram.h).every((h) => h === 0)).toBe(true);
    expect(Array.from(tram.free).every((f) => f === 0)).toBe(true);
  });
});
