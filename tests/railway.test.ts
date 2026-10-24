import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { PRESETS } from '../src/presets';
import { railwayState } from '../src/railway';
import { emptyScene, normalizeScene, VEHICLES, type Actor, type Scene } from '../src/scene';
import { simulate } from '../src/sim';

function scene(): Scene {
  const s = emptyScene();
  s.env.duration = 12;
  s.roads.push({ id: 'r1', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 1, oneWay: false, center: 'dashed', zone: 'city', smooth: false });
  s.railways.push({ id: 'j1', x: 0, y: 0, angle: Math.PI / 2, length: 300, width: 7, barrier: 'open', red: false, trainWindows: [] });
  return s;
}
function actor(type: 'car' | 'train', o: Partial<Actor> = {}): Actor {
  return { id: type, kind: 'vehicle', type, x: -45, y: 1.75, heading: 0, speed: 36, color: VEHICLES[type].color, delay: 0, flags: { drunk: false, noLicense: false, flees: false }, path: [{ x: 70, y: 1.75, v: 36 }], ...o };
}
function findings(s: Scene) { return analyze(s, simulate(s)).findings.filter((f) => f.refs.some((r) => r.startsWith('pdd:15.'))); }

describe('железнодорожный переезд', () => {
  it.each(['barrier', 'red', 'schedule'])('запрещённый въезд: %s', (reason) => {
    const s = scene();
    if (reason === 'barrier') s.railways[0].barrier = 'closed';
    if (reason === 'red') s.railways[0].red = true;
    if (reason === 'schedule') s.railways[0].trainWindows = [{ start: 0, end: 9 }];
    s.actors.push(actor('car'));
    expect(findings(s).some((f) => f.refs.includes('pdd:15.3') && f.refs.includes('koap:12.10.1'))).toBe(true);
  });
  it('открытый переезд без поезда не даёт нарушения раздела 15', () => {
    const s = scene(); s.actors.push(actor('car'));
    expect(findings(s)).toHaveLength(0);
  });
  it('красный после законного въезда не обвиняет задним числом', () => {
    const s = scene(); s.actors.push(actor('car'));
    s.railways[0].trainWindows = [{ start: 4.5, end: 10 }];
    expect(findings(s).filter((f) => f.refs.includes('pdd:15.3'))).toHaveLength(0);
  });
  it('объезд закрытого шлагбаума распознаётся рядом с проездом', () => {
    const s = scene(); s.railways[0].barrier = 'closed';
    s.actors.push(actor('car', { y: 7, path: [{ x: 70, y: 7, v: 36 }] }));
    expect(findings(s).some((f) => f.title.includes('объезд'))).toBe(true);
  });
  it('ожидание без шлагбаума слишком близко к ближайшему рельсу', () => {
    const s = scene(); s.railways[0].barrier = 'none'; s.railways[0].red = true;
    s.actors.push(actor('car', { x: -8, speed: 0, path: [] }));
    expect(findings(s).some((f) => f.refs.includes('pdd:15.4') && f.refs.includes('koap:12.10.2'))).toBe(true);
    s.actors[0].x = -15;
    expect(findings(s)).toHaveLength(0);
  });
  it('правильная остановка до шлагбаума не нарушает п.15.4', () => {
    const s = scene(); s.railways[0].barrier = 'closed'; s.actors.push(actor('car', { x: -15, speed: 0, path: [] }));
    expect(findings(s)).toHaveLength(0);
  });
  it('заданная остановка на переезде квалифицируется по ч.1 ст.12.10', () => {
    const s = scene(); s.actors.push(actor('car', { x: 0, speed: 0, path: [] }));
    expect(findings(s).some((f) => f.refs.includes('koap:12.10.1') && f.refs.includes('pdd:15.5'))).toBe(true);
  });
  it('расписание имеет полуоткрытые границы и не создаёт шлагбаум из ничего', () => {
    const r = scene().railways[0]; r.barrier = 'none'; r.trainWindows = [{ start: 2, end: 5 }];
    expect(railwayState(r, 1)).toEqual({ red: false, closed: false, train: false });
    expect(railwayState(r, 2)).toEqual({ red: true, closed: false, train: true });
    expect(railwayState(r, 5)).toEqual({ red: false, closed: false, train: false });
  });
  it('старые сохранения получают пустую коллекцию, повреждённое расписание отбрасывается', () => {
    expect(normalizeScene({ version: 1 }).railways).toEqual([]);
    const s = scene(); (s.railways[0] as unknown as { trainWindows: unknown }).trainWindows = [{ start: 'bad', end: 2 }, { start: 1, end: 2 }];
    expect(normalizeScene(s).railways[0].trainWindows).toEqual([{ start: 1, end: 2 }]);
  });
  it('поезд следует выбранным рельсам независимо от нарисованных точек', () => {
    const s = scene(); s.actors.push(actor('train', { railwayId: 'j1', x: 0.5, y: -80, heading: Math.PI / 2, speed: 54, path: [{ x: 2, y: 100, v: 54 }] }));
    const tr = simulate(s).tracks.get('train')!;
    expect(Math.max(...tr.x.map(Math.abs))).toBeLessThan(0.01);
    expect(tr.y.at(-1)!).toBeGreaterThan(0);
    expect(Math.max(...tr.free)).toBe(0);
  });
  it('торможение поезда ограничено 0,8 м/с², а остановочный путь велик', () => {
    const s = scene(); s.env.duration = 30;
    s.actors.push(actor('train', { railwayId: 'j1', x: 0, y: -120, heading: Math.PI / 2, speed: 54, path: [{ x: 0, y: 120, v: 0 }] }));
    const tr = simulate(s).tracks.get('train')!;
    for (let k = 1; k < tr.v.length; k++) expect(tr.v[k - 1] - tr.v[k]).toBeLessThanOrEqual(0.8 * 0.025 + 0.001);
    expect(tr.y.at(-1)! - tr.y[0]).toBeGreaterThan(140);
    expect(tr.v.at(-1)).toBeLessThan(0.05);
  });
  it('поезд без рельсов стоит', () => {
    const s = scene(); s.actors.push(actor('train'));
    const tr = simulate(s).tracks.get('train')!;
    expect(Math.max(...tr.v)).toBe(0);
    expect(tr.x.at(-1)).toBe(tr.x[0]);
  });
  it('пример даёт столкновение с поездом, причинное нарушение и без дорожного обвинения машиниста', () => {
    const s = PRESETS.find((p) => p.id === 'railway-red')!.build(); const r = analyze(s, simulate(s));
    expect(r.collisions[0].title).toMatch(/поездом/);
    const car = s.actors.find((a) => a.type === 'car')!;
    const train = s.actors.find((a) => a.type === 'train')!;
    expect(r.findings.some((f) => f.actorId === car.id && f.causal && f.refs.includes('pdd:15.3'))).toBe(true);
    expect(r.findings.filter((f) => f.actorId === train.id && f.severity === 'violation')).toHaveLength(0);
  });
});
