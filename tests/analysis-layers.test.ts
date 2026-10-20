import { describe, expect, it } from 'vitest';
import { analyze, STATUS_LABEL } from '../src/analysis';
import { analyzeTechnical } from '../src/analysis/technical';
import { analyzeRules } from '../src/analysis/traffic-rules';
import { analyzeLegal, LEGAL_EDITION_DATE } from '../src/analysis/legal';
import { PRESETS } from '../src/presets';
import { simulate } from '../src/sim';
import { normalizeScene } from '../src/scene';
import { loadCorpus, resolveRef } from '../src/corpus';

const preset = (id: string) => PRESETS.find(p => p.id === id)!.build();

describe('границы этапов экспертного анализа', () => {
  it('правила и квалификация не изменяют технические факты', () => {
    const scene = preset('red-light');
    const context = analyzeTechnical(scene, simulate(scene));
    const before = structuredClone(context.technical);
    const { section: rules } = analyzeRules(context);
    const rulesBefore = structuredClone(rules);
    analyzeLegal(scene, rules);
    expect(context.technical).toEqual(before);
    expect(rules).toEqual(rulesBefore);
    expect(JSON.stringify(context.technical)).not.toMatch(/koap:|uk:|pdd:/);
    expect(rules.findings.flatMap(f => f.refs).every(r => /^(pdd|sign|marking):/.test(r))).toBe(true);
  });

  it('trace позволяет повторить расчёт остановочного пути и диапазона', () => {
    const scene = preset('crosswalk');
    const report = analyze(scene, simulate(scene));
    const t = report.technical.collisions[0].tech[0];
    const { v0, t1, t2, j, S, available } = t.trace as Record<string, number>;
    expect(S).toBeCloseTo(v0 * (t1 + t2) + v0 ** 2 / (2 * j), 10);
    expect(t.stopDist).toBe(S);
    expect(t.available).toBe(available);
    expect(t.avoidable).toBe(S <= available + 1e-6);
    expect(t.ranges.stopDist[0]).toBeLessThan(t.stopDist);
    expect(t.ranges.stopDist[1]).toBeGreaterThan(t.stopDist);
    expect(report.technical.points.some(p => p.actorId === t.actorId && p.frame === t.trace.frame && p.speedKmh === t.speedKmh)).toBe(true);
    for (const f of report.rules.findings) expect(f.trace).toHaveProperty('actorId', f.actorId);
    for (const v of report.legal.verdicts) {
      expect(v.trace).toHaveProperty('subject');
      for (const l of v.legal) expect(l.trace).toHaveProperty('assessmentDate');
    }
  });

  it.each([7, 15, 16])('возраст пешехода %s: состав КоАП появляется только с 16 лет', age => {
    const scene = preset('ped-red');
    const ped = scene.actors.find(a => a.kind === 'pedestrian')!;
    ped.type = 'child';
    ped.age = age;
    const rep = analyze(scene, simulate(scene));
    expect(rep.rules.findings.some(f => f.actorId === ped.id && f.refs.includes('pdd:4.4'))).toBe(true);
    const verdict = rep.legal.verdicts.find(v => v.actorId === ped.id)!;
    expect(verdict.legal.flatMap(l => l.refs).some(r => r.startsWith('koap:'))).toBe(age >= 16);
    expect(rep.findings.filter(f => f.actorId === ped.id).flatMap(f => f.refs).some(r => r.startsWith('koap:'))).toBe(age >= 16);
  });

  it('для ребёнка без возраста субъект КоАП не предполагается', () => {
    const scene = preset('ped-red');
    const ped = scene.actors.find(a => a.kind === 'pedestrian')!;
    ped.type = 'child';
    const report = analyze(scene, simulate(scene));
    const verdict = report.legal.verdicts.find(v => v.actorId === ped.id)!;
    expect(verdict.legal.flatMap(l => l.refs).some(r => r.startsWith('koap:'))).toBe(false);
    expect(verdict.legal.some(l => l.text.includes('Возраст ребёнка не задан'))).toBe(true);
  });

  it('дата редакции определяет доступность санкций, технические результаты сохраняются', () => {
    const scene = preset('red-light');
    scene.analysisDate = LEGAL_EDITION_DATE;
    const tl = simulate(scene);
    const current = analyze(scene, tl);
    const sanctions = current.legal.verdicts.flatMap(v => v.legal.flatMap(l => l.sanctions ?? []));
    expect(sanctions.length).toBeGreaterThan(0);
    expect(sanctions.some(s => s.available && s.text)).toBe(true);
    scene.analysisDate = '2020-01-01';
    const historical = analyze(scene, tl);
    expect(historical.technical).toEqual(current.technical);
    expect(historical.legal.verdicts.flatMap(v => v.legal.flatMap(l => l.sanctions ?? [])).every(s => !s.available && s.text === null)).toBe(true);
    expect(historical.legal.assessmentDate).toBe('2020-01-01');
  });

  it('без старого переопределения дата ДТП определяет доступность правовых санкций', () => {
    const scene = preset('red-light');
    delete scene.analysisDate;
    const tl = simulate(scene);
    scene.env.accidentDate = LEGAL_EDITION_DATE;
    const current = analyze(scene, tl);
    expect(current.legal.assessmentDate).toBe(scene.env.accidentDate);
    expect(current.legal.verdicts.flatMap(v => v.legal.flatMap(l => l.sanctions ?? [])).some(s => s.available)).toBe(true);
    scene.env.accidentDate = '1900-01-01';
    const historical = analyze(scene, tl);
    expect(historical.legal.assessmentDate).toBe('1900-01-01');
    expect(historical.technical).toEqual(current.technical);
    expect(historical.legal.verdicts.flatMap(v => v.legal.flatMap(l => l.sanctions ?? [])).every(s => !s.available && s.text === null)).toBe(true);
  });

  it('выполнение оценивается только для наблюдавшегося требования', () => {
    const scene = preset('red-light');
    const report = analyze(scene, simulate(scene));
    expect(report.rules.findings.some(f => f.compliance === 'выполнено' && f.refs.includes('pdd:6.2'))).toBe(true);
    expect(report.rules.findings.some(f => f.compliance === 'не выполнено' && f.refs.includes('pdd:6.2'))).toBe(true);
  });

  it('отсутствие наблюдений не означает отсутствие нарушений', () => {
    const scene = preset('red-light');
    const absent = scene.actors[0];
    absent.delay = scene.env.duration + 100;
    const report = analyze(scene, simulate(scene));
    expect(report.rules.actors.find(v => v.actorId === absent.id)!.status).toBe('insufficient-data');
    expect(STATUS_LABEL['insufficient-data']).toBe('недостаточно данных');
  });
});

it('дата оценки и возраст сохраняются при экспорте и импорте сцены', () => {
  const scene = preset('ped-red');
  scene.analysisDate = '2020-01-01';
  scene.actors[1].age = 15;
  const loaded = normalizeScene(JSON.parse(JSON.stringify(scene)));
  expect(loaded.analysisDate).toBe(scene.analysisDate);
  expect(loaded.actors[1].age).toBe(15);
});

it('санкции в отчёте соответствуют тексту доступного корпуса', async () => {
  const scene = preset('red-light');
  scene.analysisDate = LEGAL_EDITION_DATE;
  const report = analyze(scene, simulate(scene));
  const corpus = await loadCorpus();
  for (const item of report.legal.verdicts.flatMap(v => v.legal)) {
    for (const sanction of item.sanctions ?? []) {
      const source = resolveRef(corpus, sanction.ref, report.legal.assessmentDate);
      expect(sanction.editionDate).toBe(source?.revision?.source.revisionDate ?? '');
      expect(sanction.text).toBe(source?.sanction ?? null);
    }
  }
});
