import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { simulate } from '../src/sim';
import { MANEUVER_COMPLIANT_PRESETS, MANEUVER_PRESETS, PRESETS } from '../src/presets';
import { normalizeScene } from '../src/scene';
import { vehicleSignalAt } from '../src/maneuver-signals';

const pairs = [
  ['overtake-left-turn','overtake-left-turn-yield','pdd:11.2',1],
  ['uturn-from-right-lane','uturn-from-left-lane','pdd:8.5',0],
  ['reverse-from-parking','reverse-from-parking-yield','pdd:8.12',0],
  ['lane-change-no-signal','lane-change-signal-yield','pdd:8.1',0],
] as const;
const sceneOf = (id: string) => normalizeScene(JSON.parse(JSON.stringify(PRESETS.find(p => p.id === id)!.build())));

describe('обязательные сценарии манёвров', () => {
  it.each(pairs)('%s проверяет конкретное требование', (id, _correct, ref, actorIndex) => {
    const preset = MANEUVER_PRESETS.find(p => p.id === id)!;
    expect(PRESETS).toContain(preset);
    const scene = sceneOf(id);
    const report = analyze(scene, simulate(scene));
    expect(report.rules.findings.some(f => f.actorId === scene.actors[actorIndex].id
      && f.severity === 'violation' && f.refs.includes(ref)), id).toBe(true);
  });

  it.each(pairs)('%s: безопасный вариант сохраняет дорогу и участников', (id, correct, ref, actorIndex) => {
    const original = sceneOf(id);
    const scene = sceneOf(correct);
    expect(scene.roads).toEqual(original.roads);
    expect(scene.actors.map(a => [a.kind, a.type])).toEqual(original.actors.map(a => [a.kind, a.type]));
    expect(scene.actors.every(a => a.delay === 0)).toBe(true);
    const timeline = simulate(scene);
    expect(timeline.collisions).toHaveLength(0);
    expect([...timeline.tracks.values()].every(track => [...track.present].every(Boolean))).toBe(true);
    const report = analyze(scene, timeline);
    expect(report.rules.findings.filter(f => f.actorId === scene.actors[actorIndex].id && f.severity === 'violation')
      .flatMap(f => f.refs), correct).not.toContain(ref);
    if (ref !== 'pdd:11.2') expect(report.rules.findings.some(f => f.actorId === scene.actors[actorIndex].id
      && f.refs.includes(ref) && f.compliance === 'выполнено'), correct).toBe(true);
    else {
      // No overtake was initiated: do not manufacture a positive legal verdict
      // about an unobserved manoeuvre. The precaution itself is observable.
      const track = timeline.tracks.get(scene.actors[actorIndex].id)!;
      expect([...track.v].filter(v => v === 0).length * timeline.dt).toBeGreaterThanOrEqual(5);
      expect([...track.y].every(y => y > 0)).toBe(true);
    }
  });

  it.each(['overtake-left-turn','reverse-from-parking','lane-change-no-signal'])('%s содержит реальный контакт', id => {
    const timeline = simulate(sceneOf(id));
    expect(timeline.collisions.some(c => c.kind === 'vv')).toBe(true);
  });

  it('попытка обгона прервана ударом при уже включённом левом сигнале лидера', () => {
    const scene = sceneOf('overtake-left-turn');
    const timeline = simulate(scene);
    const contact = timeline.collisions[0];
    const leader = timeline.tracks.get(scene.actors[0].id)!;
    const overtaker = timeline.tracks.get(scene.actors[1].id)!;
    expect([...overtaker.y.slice(0, contact.frame)].some(y => y < -0.9)).toBe(true);
    expect(vehicleSignalAt(scene.actors[0], contact.t, leader.waypointTimes).signal).toBe('left');
    const legal = analyze(scene, timeline).findings.filter(f => f.actorId === scene.actors[1].id && f.refs.includes('pdd:11.2'));
    expect(legal.some(f => f.severity === 'violation')).toBe(true);
  });

  it('выезд с парковки идёт задним ходом до удара, безопасный вариант ожидает вне дороги', () => {
    const bad = sceneOf('reverse-from-parking');
    const timeline = simulate(bad);
    const track = timeline.tracks.get(bad.actors[0].id)!;
    expect(track.reversing![timeline.collisions[0].frame - 1]).toBe(1);
    const good = sceneOf('reverse-from-parking-yield');
    const safe = simulate(good).tracks.get(good.actors[0].id)!;
    const waiting = [...safe.v].map((v, k) => v === 0 ? k : -1).filter(k => k >= 0);
    expect(waiting.length * timeline.dt).toBeGreaterThanOrEqual(5);
    expect(waiting.every(k => safe.y[k] > 3.5 + 2.25)).toBe(true);
    expect(safe.y[safe.y.length - 1]).toBeLessThan(-3.5);
  });

  it('ожидание прямого движения другого водителя задано фактом, а не выведено из отсутствия сигнала', () => {
    const scene = sceneOf('lane-change-no-signal');
    expect(scene.actors[1].maneuverContext?.expectedStraight).toBe(true);
    expect(scene.actors[0].path.every(w => w.signal === 'none')).toBe(true);
  });

  it('каталог содержит все восемь вариантов и сохраняет исходный пример', () => {
    expect(PRESETS[0].id).toBe('crosswalk');
    expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
    for (const preset of [...MANEUVER_PRESETS, ...MANEUVER_COMPLIANT_PRESETS]) {
      expect(PRESETS).toContain(preset);
      expect(preset.build().env.accidentDate).toBe('2026-10-21T12:00');
    }
  });
});
