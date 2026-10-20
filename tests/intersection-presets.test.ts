import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { buildGeo } from '../src/geo';
import { INTERSECTION_CONTROL_PRESETS, INTERSECTION_PRESETS, PRESETS } from '../src/presets';
import { simulate } from '../src/sim';
import pdd from '../src/data/pdd.json';

const rules = ['13.1', '13.2', '13.3', '13.4', '13.5', '13.6', '13.7', '13.8', '13.9', '13.10', '13.11', '13.11(1)', '13.12', '13.13'];
const paired = [...INTERSECTION_PRESETS, ...INTERSECTION_CONTROL_PRESETS.filter(p => p.intersectionCase?.expected !== 'agreement')];

describe('парные примеры перекрёстков из раздела 13', () => {
  it.each(rules)('для п. %s есть наблюдаемые правильный и нарушающий варианты', rule => {
    expect(pdd.sections.flatMap(s => s.points).find(p => p.id === rule)?.text).toBeTruthy();
    const pair = INTERSECTION_PRESETS.filter(p => p.intersectionCase?.rule === `pdd:${rule}`);
    expect(pair.map(p => p.intersectionCase!.expected).sort()).toEqual(['compliant', 'violation']);
    const [correct, violation] = pair.map(p => p.build());
    expect(correct.roads).toEqual(violation.roads);
    expect(correct.actors.map(a => a.type)).toEqual(violation.actors.map(a => a.type));
    expect(buildGeo(correct).intersections.length).toBeGreaterThan(0);
  });

  it.each(paired.filter(p => p.intersectionCase!.expected === 'compliant'))('$title: уступка либо разрешённое движение не создают нарушения', preset => {
    const scene = preset.build();
    const timeline = simulate(scene);
    const report = analyze(scene, timeline);
    const { actorIndex, evaluatedRequirement } = preset.intersectionCase!;
    expect(timeline.collisions, preset.id).toHaveLength(0);
    expect(report.rules.findings.filter(f => f.actorId === scene.actors[actorIndex].id && f.severity === 'violation')
      .flatMap(f => f.refs), preset.id).not.toContain(evaluatedRequirement);
  });

  it.each(paired.filter(p => p.intersectionCase!.expected === 'violation'))('$title: зафиксировано требование, которое нарушено', preset => {
    const scene = preset.build();
    const report = analyze(scene, simulate(scene));
    const { actorIndex, evaluatedRequirement } = preset.intersectionCase!;
    expect(report.rules.findings.some(f => f.actorId === scene.actors[actorIndex].id
      && f.severity === 'violation' && f.refs.includes(evaluatedRequirement)), preset.id).toBe(true);
  });

  it('четыре равнозначных подъезда образуют цикл без назначения нарушителя приоритета', () => {
    const scene = INTERSECTION_CONTROL_PRESETS.find(p => p.id === 'intersection-four-way-cycle')!.build();
    const report = analyze(scene, simulate(scene));
    expect(report.rules.priorityGraphs.some(g => g.agreementRequired && g.cycles.some(c => c.length === 4))).toBe(true);
    expect(report.rules.findings.filter(f => f.severity === 'violation').flatMap(f => f.refs)).not.toContain('pdd:13.11');
    expect(report.rules.findings.some(f => f.detail.includes('договариваются'))).toBe(true);
  });

  it('новые примеры доступны в общем каталоге без смены исходного примера', () => {
    expect(PRESETS[0].id).toBe('crosswalk');
    expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
    for (const preset of [...INTERSECTION_PRESETS, ...INTERSECTION_CONTROL_PRESETS]) {
      expect(PRESETS).toContain(preset);
      expect(preset.build().env.accidentDate).toBe('2026-10-20T12:00');
    }
  });
});
