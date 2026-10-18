import { describe, expect, it } from 'vitest';
import { simulate } from '../src/sim';
import { emptyScene, type Actor } from '../src/scene';
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
