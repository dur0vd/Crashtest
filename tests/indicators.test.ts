import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { signalAtDistance } from '../src/indicators';
import { PRESETS } from '../src/presets';
import { normalizeScene } from '../src/scene';
import { simulate } from '../src/sim';

const scene = () => {
  const s = PRESETS.find((p) => p.id === 'ramp-merge')!.build();
  s.actors = [s.actors[1]];
  s.env.duration = 3;
  return s;
};
const signals = (s: ReturnType<typeof scene>) => analyze(s, simulate(s)).findings.filter((f) => f.refs.includes('koap:12.14.1'));

describe('указатели поворота', () => {
  it('перестроение с заранее включённым указателем не нарушает п. 8.2', () => {
    expect(signals(scene())).toHaveLength(0);
  });
  it('перестроение без указателя нарушает п. 8.1–8.2', () => {
    const s = scene();
    s.actors[0].path.forEach((w) => (w.signal = 'none'));
    expect(signals(s).flatMap((f) => f.refs)).toContain('pdd:8.2');
  });
  it('неправильный указатель не подтверждает подачу сигнала перед манёвром', () => {
    const s = scene();
    s.actors[0].path.forEach((w) => (w.signal = 'left'));
    expect(signals(s)).toHaveLength(1);
  });
  it('сигнал на участке начинается до конечной точки и прекращается после маршрута', () => {
    const a = scene().actors[0];
    expect(signalAtDistance(a, 0)).toBe('right');
    expect(signalAtDistance(a, 10_000)).toBe('none');
  });
  it('старые точки без указателей нормализуются в состояние «нет»', () => {
    const s = scene();
    s.actors[0].path.forEach((w) => delete w.signal);
    expect(normalizeScene(s).actors[0].path.every((w) => w.signal === 'none')).toBe(true);
  });
  it('прямолинейное движение не требует указателя', () => {
    const s = scene();
    s.actors[0].path = [{ x: 100, y: s.actors[0].y, v: 58 }];
    expect(signals(s)).toHaveLength(0);
  });
});

describe('плавные перестроения', () => {
  const gentle = () => {
    const s = scene();
    s.roads = [{ id: 'r1', pts: [{ x: -200, y: 0 }, { x: 200, y: 0 }], lanes: 2, center: 'dashed', oneWay: true, zone: 'city', smooth: false }];
    s.env.duration = 12;
    Object.assign(s.actors[0], { x: -100, y: -1.75, speed: 36, path: [{ x: 0, y: 1.75, v: 36 }, { x: 100, y: 1.75, v: 36 }] });
    return s;
  };
  it('смена полосы с малым изменением курса требует сигнала', () => {
    expect(signals(gentle())).toHaveLength(1);
  });
  it('заранее поданный сигнал подтверждает плавное перестроение', () => {
    const s = gentle();
    s.actors[0].path.forEach((w) => (w.signal = 'right'));
    expect(signals(s)).toHaveLength(0);
  });
  it('обычное следование изгибу кольца не считается поворотом', () => {
    const s = gentle();
    const points = [{ x: 0, y: -20 }, { x: -14.142, y: -14.142 }, { x: -20, y: 0 }, { x: -14.142, y: 14.142 }, { x: 0, y: 20 }, { x: 14.142, y: 14.142 }, { x: 20, y: 0 }, { x: 14.142, y: -14.142 }, { x: 0, y: -20 }];
    s.roads = [{ ...s.roads[0], lanes: 1, pts: points, smooth: true }];
    Object.assign(s.actors[0], { x: 0, y: -20, heading: Math.PI, speed: 28, path: points.slice(1, 5).map((p) => ({ ...p, v: 28 })) });
    s.env.duration = 3.5;
    expect(signals(s)).toHaveLength(0);
  });
});
