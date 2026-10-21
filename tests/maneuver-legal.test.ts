import { describe, expect, it } from 'vitest';
import { analyzeLegal } from '../src/analysis/legal';
import { PRESETS } from '../src/presets';
import { lawRef } from '../src/law';
import type { Finding, RulesSection } from '../src/analysis/types';

function qualify(codes: string[], pdd = 'pdd:8.12') {
  const scene = PRESETS.find(p => p.id === 'giveway')!.build();
  scene.env.accidentDate = '2026-10-21T12:00';
  const actorId = scene.actors[0].id;
  const finding: Finding = { actorId, severity: 'violation', title: 'Наблюдавшееся нарушение', detail: '', refs: [pdd], causal: false,
    requirement: pdd, compliance: 'не выполнено', prevention: null, trace: { actorId, ruleCodes: codes } };
  const rules: RulesSection = { priorityGraphs: [], actors: scene.actors.map(a => ({ actorId: a.id,
    status: a.id === actorId ? 'noncausal-violation' : 'no-violations', text: '', trace: {} })), findings: [finding], collisions: [] };
  return { result: analyzeLegal(scene, rules), date: scene.env.accidentDate };
}

describe('квалификация манёвров по частям статей корпуса', () => {
  it.each([
    ['rule:indicator', 'koap:12.14#1', 'подать сигнал'],
    ['rule:extreme-position', 'koap:12.14#1.1', 'крайнее положение'],
    ['rule:forbidden-maneuver', 'koap:12.14#2', 'задним ходом'],
    ['rule:motorway-maneuver', 'koap:12.11#3', 'автомагистрали'],
    ['rule:obstacle-bypass', 'koap:12.15#3', 'объезде препятствия'],
    ['rule:slow-vehicle-yield', 'koap:12.15#1.1', 'пропустить'],
    ['rule:meeting-priority', 'koap:12.15#1', 'встречного разъезда'],
    ['rule:road-position', 'koap:12.15#1', 'расположения транспортного средства'],
  ])('%s выбирает отдельный состав', (code, ref, fragment) => {
    const { result, date } = qualify([code]);
    expect(result.findings[0].refs).toContain(ref);
    const source = lawRef(ref, date);
    expect(source.text).toContain(fragment);
    expect(result.section.verdicts[0].legal.flatMap(l => l.sanctions ?? []).find(s => s.ref === ref)?.text).toBe(source.sanction);
  });

  it.each([
    [['rule:forbidden-maneuver','rule:motorway-maneuver'], 'koap:12.11#3', 'koap:12.14#2'],
    [['rule:forbidden-maneuver','rule:turn-sign'], 'koap:12.16.2', 'koap:12.14#2'],
    [['rule:obstacle-bypass','rule:opposing-lane'], 'koap:12.15#3', 'koap:12.15.4'],
  ] as const)('явное исключение не дублируется общим составом', (codes, selected, excluded) => {
    const refs = qualify([...codes]).result.findings[0].refs;
    expect(refs).toContain(selected);
    expect(refs).not.toContain(excluded);
  });

  it('повышение скорости обгоняемым само по себе не становится объездом препятствия', () => {
    const { result } = qualify([], 'pdd:11.3');
    expect(result.findings[0].refs).toEqual(['pdd:11.3']);
    expect(result.section.verdicts[0].legal).toHaveLength(0);
  });
});
