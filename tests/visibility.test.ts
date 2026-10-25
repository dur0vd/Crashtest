import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { PRESETS } from '../src/presets';
import { normalizeScene } from '../src/scene';
import { simulate } from '../src/sim';
import { visibilityDistance } from '../src/visibility';

describe('ночь и ограниченная видимость', () => {
  it('при скорости в пределах лимита туман исключает техвозможность и требует меньшей скорости', () => {
    const scene = PRESETS.find((p) => p.id === 'night-fog')!.build();
    const report = analyze(scene, simulate(scene));
    const car = scene.actors[0];
    const tech = report.collisions[0].tech.find((t) => t.actorId === car.id)!;
    expect(tech.speedKmh).toBeLessThanOrEqual(60);
    expect(tech.visibility).toBe(20);
    expect(tech.avoidable).toBe(false);
    expect(report.findings.some((f) => f.actorId === car.id && f.title.includes('пределах видимости') && f.causal)).toBe(true);
    scene.env.timeOfDay = 'day';
    scene.env.visibility = 1000;
    const clear = analyze(scene, simulate(scene));
    expect(clear.collisions[0].tech.find((t) => t.actorId === car.id)!.avoidable).toBe(true);
    expect(clear.findings.some((f) => f.title.includes('пределах видимости'))).toBe(false);
  });
  it('фары и стационарное освещение меняют дальность, туман ограничивает и дальний свет', () => {
    const s = PRESETS.find((p) => p.id === 'night-fog')!.build();
    const a = s.actors[0];
    s.env.visibility = 1000;
    expect(visibilityDistance(s, a, a.x, a.y)).toBe(55);
    a.headlights = 'high';
    expect(visibilityDistance(s, a, a.x, a.y)).toBe(120);
    expect(visibilityDistance(s, a, a.x, a.y, true)).toBe(150);
    s.env.visibility = 15;
    expect(visibilityDistance(s, a, a.x, a.y, true)).toBe(15);
  });
  it('движение без фар ночью нарушает 19.1 даже на освещённой дороге', () => {
    const s = PRESETS.find((p) => p.id === 'night-fog')!.build();
    s.actors[0].headlights = 'off';
    s.roads[0].lit = true;
    const report = analyze(s, simulate(s));
    expect(report.findings.some((f) => f.refs.includes('pdd:19.1') && f.refs.includes('koap:12.20'))).toBe(true);
  });
  it('старые сохранения получают дневные условия и ближний свет, неверные значения ограничены', () => {
    const s = PRESETS[1].build();
    delete s.env.timeOfDay;
    delete s.env.visibility;
    const normalized = normalizeScene(s);
    expect(normalized.env.timeOfDay).toBe('day');
    expect(normalized.env.visibility).toBe(1000);
    expect(normalized.actors[0].headlights).toBe('low');
    expect(normalizeScene({ env: { visibility: -3, timeOfDay: 'bad' } }).env).toMatchObject({ visibility: 1, timeOfDay: 'day' });
  });
});
