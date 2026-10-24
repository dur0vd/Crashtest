import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { PRESETS } from '../src/presets';
import { simulate } from '../src/sim';

const scene = () => PRESETS.find((p) => p.id === 'roundabout-entry')!.build();
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
});
