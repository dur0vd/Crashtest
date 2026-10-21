import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { analyzeLegal } from '../src/analysis/legal';
import type { Finding, RulesSection } from '../src/analysis/types';
import { PRESETS, SPECIAL_SIGNAL_PRESETS } from '../src/presets';
import { cloneScene, normalizeScene } from '../src/scene';
import { simulate } from '../src/sim';

const sceneOf = (id: string) => normalizeScene(cloneScene(PRESETS.find(preset => preset.id === id)!.build()));

describe('пара примеров со спецтранспортом', () => {
  it('конфликт сохраняет обязанности обоих водителей', () => {
    expect(SPECIAL_SIGNAL_PRESETS.every(preset => PRESETS.includes(preset))).toBe(true);
    const scene = sceneOf('special-signal-conflict');
    const timeline = simulate(scene), report = analyze(scene, timeline);
    const [ordinary, special] = scene.actors;
    expect(timeline.collisions.some(contact => contact.kind === 'vv')).toBe(true);
    expect(report.rules.findings.some(finding => finding.actorId === ordinary.id
      && finding.causal && finding.severity === 'violation' && finding.refs.includes('pdd:3.2'))).toBe(true);
    expect(report.rules.findings.some(finding => finding.actorId === special.id
      && finding.causal && finding.severity === 'violation' && finding.refs.includes('pdd:3.1'))).toBe(true);
    expect(report.findings.some(finding => finding.actorId === ordinary.id
      && finding.refs.includes('koap:12.17#2'))).toBe(true);
    expect(report.findings.some(finding => finding.actorId === special.id
      && finding.refs.includes('koap:12.17#2'))).toBe(false);
  });

  it('правильный вариант тормозит перед конфликтом и сохраняет тех же участников', () => {
    const bad = sceneOf('special-signal-conflict'), scene = sceneOf('special-signal-yield');
    expect(scene.roads).toEqual(bad.roads);
    expect(scene.lights).toEqual(bad.lights);
    expect(scene.actors.map(actor => [actor.kind, actor.type, actor.x, actor.y, actor.speed, actor.delay]))
      .toEqual(bad.actors.map(actor => [actor.kind, actor.type, actor.x, actor.y, actor.speed, actor.delay]));
    expect(scene.actors.every(actor => actor.delay === 0)).toBe(true);
    const timeline = simulate(scene), report = analyze(scene, timeline);
    const [ordinary, special] = scene.actors;
    expect(timeline.collisions).toHaveLength(0);
    const car = timeline.tracks.get(ordinary.id)!;
    const waiting = [...car.v].map((speed, frame) => speed === 0 ? frame : -1).filter(frame => frame >= 0);
    expect(waiting.length * timeline.dt).toBeGreaterThanOrEqual(6);
    expect(waiting.every(frame => car.x[frame] < -10)).toBe(true);
    expect([...timeline.tracks.get(special.id)!.y].some(y => y > 30)).toBe(true);
    expect(report.rules.findings.some(finding => finding.actorId === ordinary.id
      && finding.severity === 'info' && finding.refs.includes('pdd:3.2') && finding.compliance === 'выполнено')).toBe(true);
    expect(report.findings.some(finding => finding.actorId === special.id
      && finding.refs.includes('koap:12.12.1'))).toBe(false);
    expect(report.findings.some(finding => finding.actorId === ordinary.id
      && finding.refs.includes('koap:12.17#2'))).toBe(false);
  });
});

describe('известность специальных сигналов при загрузке', () => {
  it('старая сцена не получает ложных фактов о маячке и сирене', () => {
    const scene = sceneOf('special-signal-conflict');
    for (const actor of scene.actors) {
      delete actor.specialSignals;
      delete actor.specialInteractions;
    }
    const loaded = normalizeScene(cloneScene(scene));
    expect(loaded.actors.every(actor => actor.specialSignals === undefined && actor.specialInteractions === undefined)).toBe(true);
  });

  it('указание задания не превращает неизвестный цвет в выключенный маячок', () => {
    const raw = cloneScene(sceneOf('special-signal-conflict')) as any;
    raw.actors[1].specialSignals = { urgentDuty: true, siren: 'yes', colorScheme: false, safetyEnsured: 'no' };
    const loaded = normalizeScene(raw);
    expect(loaded.actors[1].specialSignals).toEqual({ beacon: 'unknown', urgentDuty: true, colorScheme: false });
    expect(loaded.actors[1].specialSignals).not.toHaveProperty('siren');
    expect(loaded.actors[1].specialSignals).not.toHaveProperty('safetyEnsured');
  });

  it('парные факты сохраняют false и неизвестность для конкретного участника', () => {
    const raw = cloneScene(sceneOf('special-signal-conflict')) as any;
    const [ordinary, special] = raw.actors;
    ordinary.specialInteractions = [
      { otherId: special.id, yielded: false, beaconVisible: 'yes', immediateStopPossible: true },
      { otherId: special.id, yielded: true },
      { otherId: ordinary.id, yielded: true },
      { otherId: 'absent', yielded: true },
    ];
    const loaded = normalizeScene(raw);
    expect(loaded.actors[0].specialInteractions).toEqual([{ otherId: special.id, yielded: false, immediateStopPossible: true }]);
    expect(loaded.actors[0].specialInteractions![0]).not.toHaveProperty('beaconVisible');
    expect(loaded.actors[0].specialInteractions![0]).not.toHaveProperty('yieldingVerified');
  });
});

it.each(['info', 'contributing'] as const)('оценка %s не назначает часть КоАП за неустановленное нарушение', severity => {
  const scene = sceneOf('special-signal-yield'), actorId = scene.actors[0].id;
  const finding: Finding = { actorId, severity, title: 'Уступание', detail: '', refs: ['pdd:3.2'], causal: false,
    requirement: 'pdd:3.2', compliance: severity === 'info' ? 'выполнено' : 'не определить', prevention: null,
    trace: { ruleCodes: ['rule:special-priority-marked'] } };
  const rules: RulesSection = { priorityGraphs: [], collisions: [], findings: [finding],
    actors: scene.actors.map(actor => ({ actorId: actor.id, status: severity === 'info' ? 'no-violations' : 'insufficient-data', text: '', trace: {} })) };
  const result = analyzeLegal(scene, rules);
  expect(result.findings[0].refs).toEqual(['pdd:3.2']);
  expect(result.section.verdicts.flatMap(verdict => verdict.legal.flatMap(item => item.refs))).not.toContain('koap:12.17#2');
});
