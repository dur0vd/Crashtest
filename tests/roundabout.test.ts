import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { PRESETS } from '../src/presets';
import { simulate } from '../src/sim';

const scene = () => PRESETS.find((p) => p.id === 'roundabout-entry')!.build();
function afterSignScene() {
  const s = scene();
  s.actors[0].x = -31;
  s.actors[0].speed = 15;
  s.actors[0].path.forEach((w) => (w.v = 15));
  s.actors[1].x = -14.142;
  s.actors[1].y = -14.142;
  s.actors[1].path = [{ x: -20, y: 0, v: 28 }, { x: -14.142, y: 14.142, v: 28 }, { x: 0, y: 20, v: 28 }];
  return s;
}
describe('приоритет на круговом движении', () => {
  it('один знак 4.3 требует уступить уже движущемуся по кольцу', () => {
    const s = scene();
    const report = analyze(s, simulate(s));
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.actorId === s.actors[0].id && f.causal && f.refs.includes('pdd:13.11(1)'))).toBe(true);
    expect(report.findings.some((f) => f.actorId === s.actors[1].id && f.causal && f.refs.includes('koap:12.13.2'))).toBe(false);
  });
  it('знак 2.4 на въезде также требует уступить', () => {
    const s = scene();
    s.signs.push({ ...s.signs[0], id: 'yield', kind: '2.4' });
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.actorId === s.actors[0].id && f.causal && f.refs.includes('sign:2.4'))).toBe(true);
  });
  it('главная дорога на въезде отменяет общее требование уступить кольцу', () => {
    const s = scene();
    s.signs.push({ ...s.signs[0], id: 'main', kind: '2.1' });
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.actorId === s.actors[1].id && f.causal && f.refs.includes('pdd:13.9'))).toBe(true);
    expect(report.findings.some((f) => f.actorId === s.actors[0].id && f.refs.includes('pdd:13.11(1)'))).toBe(false);
  });
  it('без знака 4.3 замкнутая геометрия сама не создаёт режим кольца', () => {
    const s = scene();
    s.signs = [];
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.refs.includes('pdd:13.11(1)'))).toBe(false);
  });
  it.each([{ x: -31, speed: 15 }, { x: -33, speed: 18 }])('начало сцены после проезда знака передним габаритом ($x) сохраняет преимущество кольца', ({ x, speed }) => {
    const s = afterSignScene();
    s.actors[0].x = x;
    s.actors[0].speed = speed;
    s.actors[0].path.forEach((w) => (w.v = speed));
    const report = analyze(s, simulate(s));
    expect(report.collisions).toHaveLength(1);
    expect(report.findings.some((f) => f.actorId === s.actors[0].id && f.causal && f.refs.includes('pdd:13.11(1)'))).toBe(true);
    expect(report.findings.some((f) => f.actorId === s.actors[1].id && f.causal && f.refs.includes('koap:12.13.2'))).toBe(false);
  });
  it('не переносит знак встречного направления на участника, начавшего после него', () => {
    const s = afterSignScene();
    s.signs[0].angle = Math.PI;
    expect(analyze(s, simulate(s)).findings.some((f) => f.refs.includes('pdd:13.11(1)'))).toBe(false);
  });
  it('не переносит уже пройденный знак с соседнего подъезда', () => {
    const s = afterSignScene();
    s.signs[0].y = -10;
    s.roads.push({ ...s.roads[1], id: 'parallel', pts: [{ x: -90, y: -10 }, { x: -20, y: -10 }] });
    expect(analyze(s, simulate(s)).findings.some((f) => f.refs.includes('pdd:13.11(1)'))).toBe(false);
  });
});
