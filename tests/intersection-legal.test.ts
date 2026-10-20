import { describe, expect, it } from 'vitest';
import { analyzeLegal } from '../src/analysis/legal';
import { PRESETS } from '../src/presets';
import { lawRef } from '../src/law';
import type { Finding, RulesSection } from '../src/analysis/types';

const date = '2026-10-20T12:00';

describe('составы нарушений проезда перекрёстков сверены с корпусом', () => {
  it.each([
    ['pdd:13.2', 'rule:intersection-blockage', 'koap:12.13.1', 'затора'],
    ['pdd:13.9', 'rule:intersection-priority', 'koap:12.13.2', 'уступить дорогу'],
    ['pdd:13.1', 'rule:pedestrian-priority', 'koap:12.18', 'пешеходам'],
    ['pdd:6.10', 'rule:signal', 'koap:12.12.1', 'жест регулировщика'],
  ])('%s → %s', (pdd, code, offence, sourceText) => {
    const scene = PRESETS.find(p => p.id === 'giveway')!.build();
    scene.env.accidentDate = date;
    const actorId = scene.actors[0].id;
    const finding: Finding = { actorId, severity: 'violation', title: 'Наблюдавшееся нарушение', detail: 'Без последствий для здоровья',
      refs: [pdd], causal: false, requirement: pdd, compliance: 'не выполнено', prevention: null, trace: { actorId, ruleCodes: [code] } };
    const rules: RulesSection = { priorityGraphs: [], actors: scene.actors.map(a => ({ actorId: a.id,
      status: a.id === actorId ? 'noncausal-violation' : 'no-violations', text: '', trace: {} })), findings: [finding], collisions: [] };
    const result = analyzeLegal(scene, rules);
    expect(result.findings[0].refs).toContain(offence);
    const source = lawRef(offence, date);
    expect(source.text).toContain(sourceText);
    const item = result.section.verdicts.find(v => v.actorId === actorId)!.legal.find(l => l.refs.includes(offence))!;
    expect(item.sanctions![0].text).toBe(source.sanction);
    expect(item.sanctions![0].available).toBe(true);
    expect(rules.findings[0].refs).toEqual([pdd]);
  });
});
