import { describe, expect, it } from 'vitest';
import { analyze, type Ctx } from '../src/analysis';
import { markParkingCausal } from '../src/parking';
import { emptyScene, normalizeScene, type Actor } from '../src/scene';
import { simulate, type Collision } from '../src/sim';

function parked(x = 0, y = 2.5): Actor {
  return { id: 'a1', kind: 'vehicle', type: 'car', x, y, heading: 0, color: '#fff', speed: 0, delay: 0, path: [], flags: { drunk: false, noLicense: false, flees: false }, parking: true };
}
function scene() {
  const s = emptyScene();
  s.env.duration = 2;
  s.roads.push({ id: 'r1', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 2, oneWay: false, center: 'dashed', zone: 'city', smooth: false });
  s.actors.push(parked());
  return s;
}
const findings = (s: ReturnType<typeof scene>) => analyze(s, simulate(s)).findings.filter((f) => f.refs.some((r) => r.startsWith('pdd:12.')));

describe('остановка и стоянка', () => {
  it('запрещает стоять на переходе и ближе 5 м перед ним, но разрешает после него', () => {
    const s = scene();
    s.crosswalks.push({ id: 'c1', x: 5, y: 0, angle: Math.PI / 2, length: 14, width: 4 });
    expect(findings(s).some((f) => f.refs.includes('koap:12.19.3'))).toBe(true);
    s.actors[0].x = 10;
    expect(findings(s).some((f) => f.refs.includes('koap:12.19.3'))).toBe(false);
  });
  it('учитывает край пересекаемой проезжей части и трамвайный габарит', () => {
    const s = scene();
    s.actors[0].x = -8;
    s.roads.push({ ...s.roads[0], id: 'r2', lanes: 1, pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] });
    expect(findings(s).some((f) => /перекрёстке/.test(f.title))).toBe(true);
    s.roads.pop();
    s.tracks.push({ id: 't1', pts: [{ x: -100, y: 2.5 }, { x: 100, y: 2.5 }], separated: false, smooth: false });
    expect(findings(s).some((f) => f.refs.includes('koap:12.19.3.2'))).toBe(true);
  });
  it('обнаруживает пересечение рельсов между центром и углами повёрнутого кузова', () => {
    const s = scene();
    Object.assign(s.actors[0], { x: 0, y: 0, heading: Math.PI / 2 });
    s.tracks.push({ id: 't1', pts: [{ x: -30, y: 1.1 }, { x: 30, y: 1.1 }], smooth: false, separated: false });
    expect(findings(s).some((f) => f.refs.includes('koap:12.19.3.2'))).toBe(true);
  });
  it('проверяет остановку маршрутного транспорта, свободные 3 м и меры водителя', () => {
    const s = scene();
    s.signs.push({ id: 'g1', kind: '5.16', x: 10, y: 7, angle: 0 });
    s.actors[0].unattended = true;
    s.actors[0].secured = false;
    expect(findings(s).flatMap((f) => f.refs)).toEqual(expect.arrayContaining(['koap:12.19.3.1', 'pdd:12.8']));
    s.roads[0].lanes = 1;
    s.roads[0].center = 'solid';
    expect(findings(s).some((f) => /менее 3 м/.test(f.title))).toBe(true);
  });
  it('отличает короткую остановку от стоянки дольше 5 минут', () => {
    const s = scene();
    s.actors[0].parking = false;
    s.actors[0].unattended = true;
    s.signs.push({ id: 'g1', kind: '5.16', x: 10, y: 7, angle: 0 });
    expect(findings(s).some((f) => f.refs.includes('pdd:12.5'))).toBe(false);
    s.env.duration = 301;
    expect(findings(s).some((f) => f.refs.includes('pdd:12.5'))).toBe(true);
  });
  it('не связывает нарушение прошлой остановки с ударом на другой остановке', () => {
    const s = scene();
    s.env.duration = 4;
    const tl = simulate(s);
    const tr = tl.tracks.get('a1')!;
    for (let k = 41; k < 80; k++) tr.v[k] = 1;
    tl.collisions.push({ a: 'a1', b: 'other', frame: tl.n - 1, t: 4 } as Collision);
    const ctx = {
      tl, infos: new Map([['a1', { a: s.actors[0], tr, k0: 0, kEnd: tl.n - 1 }]]),
      findings: [{ actorId: 'a1', severity: 'violation', t: 0, refs: ['pdd:12.4'], causal: false }],
    } as unknown as Ctx;
    markParkingCausal(ctx);
    expect(ctx.findings[0].causal).toBe(false);
  });
  it('связывает незаконную стоянку с ударом и сохраняет старые сцены', () => {
    const s = scene();
    s.env.duration = 7;
    s.crosswalks.push({ id: 'c1', x: 2, y: 0, angle: Math.PI / 2, length: 14, width: 4 });
    s.actors.push({ ...parked(-35), id: 'a2', speed: 40, parking: false, path: [{ x: 30, y: 2.5, v: 40 }] });
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.actorId === 'a1' && f.refs.includes('pdd:12.4') && f.causal)).toBe(true);
    const old = normalizeScene({ actors: [parked()] });
    expect(old.actors[0].secured).toBe(true);
    expect(old.actors[0].unattended).toBe(false);
  });
});
