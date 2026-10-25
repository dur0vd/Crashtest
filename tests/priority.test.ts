import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { buildPriorityGraph, type Approach } from '../src/priority';
import { emptyScene, type Actor } from '../src/scene';
import { simulate } from '../src/sim';

const approaches: Approach[] = [
  { id: 'west', position: { x: -20, y: 1.75 }, heading: 0, exitHeading: 0, rail: false },
  { id: 'north', position: { x: -1.75, y: -20 }, heading: Math.PI / 2, exitHeading: Math.PI / 2, rail: false },
  { id: 'east', position: { x: 20, y: -1.75 }, heading: Math.PI, exitHeading: Math.PI, rail: false },
  { id: 'south', position: { x: 1.75, y: 20 }, heading: -Math.PI / 2, exitHeading: -Math.PI / 2, rail: false },
];

function intersection(count: number) {
  const scene = emptyScene();
  scene.env.duration = 10;
  scene.roads = [
    { id: 'r1', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false },
    { id: 'r2', pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }], lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false },
  ];
  scene.actors = approaches.slice(0, count).map((entry): Actor => {
    const x = Math.abs(entry.position.x) > 10 ? entry.position.x * 2 : entry.position.x;
    const y = Math.abs(entry.position.y) > 10 ? entry.position.y * 2 : entry.position.y;
    return { id: entry.id, kind: 'vehicle', type: 'car', x, y, heading: entry.heading, speed: 36, color: '#fff', delay: 0, path: [{ x: x + Math.cos(entry.heading) * 100, y: y + Math.sin(entry.heading) * 100, v: 36 }], flags: { drunk: false, noLicense: false, flees: false } };
  });
  return scene;
}

describe('разъезд нескольких ТС', () => {
  it('для трёх направлений даёт определённую последовательность', () => {
    const graph = buildPriorityGraph(approaches.slice(0, 3));
    expect(graph.cycle).toEqual([]);
    expect(graph.order).toEqual([['west'], ['north'], ['east']]);
    const s = intersection(3);
    const report = analyze(s, simulate(s));
    expect(report.findings.filter((f) => f.title === 'очерёдность разъезда нескольких ТС')).toHaveLength(3);
    expect(report.findings.some((f) => /ТС 1 → ТС 2 → ТС 3/.test(f.detail))).toBe(true);
  });
  it('четыре направления образуют цикл и требуют согласованного проезда', () => {
    expect(buildPriorityGraph(approaches).cycle).toHaveLength(4);
    const s = intersection(4);
    const report = analyze(s, simulate(s));
    expect(report.findings.filter((f) => /требуется договорённость/.test(f.title))).toHaveLength(4);
    expect(report.collisions.some((c) => c.notes.some((note) => /графе.*цикл/.test(note)))).toBe(true);
  });
  it('прямолинейное движение без контрольных точек участвует в графе', () => {
    const s = intersection(4);
    for (const a of s.actors) a.path = [];
    const report = analyze(s, simulate(s));
    expect(report.findings.filter((f) => /требуется договорённость/.test(f.title))).toHaveLength(4);
  });
  it('стоящее вне перекрёстка ТС не создаёт фиктивное прибытие и цикл', () => {
    const s = intersection(4);
    s.env.duration = 16;
    s.actors[0].x = -12;
    s.actors[0].speed = 0;
    s.actors[0].path = [{ x: 60, y: 1.75, v: 0 }];
    s.actors[1].y = -120;
    s.actors[2].x = 120;
    s.actors[3].y = 120;
    // Переносим и точки: все три движущихся участника пересекают перекрёсток.
    s.actors[1].path = [{ x: -1.75, y: 60, v: 36 }];
    s.actors[2].path = [{ x: -60, y: -1.75, v: 36 }];
    s.actors[3].path = [{ x: 1.75, y: -60, v: 36 }];
    const timeline = simulate(s);
    expect(Math.max(...timeline.tracks.get(s.actors[0].id)!.v)).toBe(0);
    const report = analyze(s, timeline);
    expect(report.findings.filter((f) => /требуется договорённость/.test(f.title))).toHaveLength(0);
    expect(report.findings.filter((f) => f.title === 'очерёдность разъезда нескольких ТС')).toHaveLength(3);
  });
  it('граф учитывает трамвай и левый поворот, а не только помеху справа', () => {
    const tram = approaches.map((a) => ({ ...a }));
    tram[0].rail = true;
    const graph = buildPriorityGraph(tram.slice(0, 3));
    expect(graph.edges).toContainEqual({ from: 'north', to: 'west', reason: 'tram' });
    const turning = [{ ...approaches[0], exitHeading: -Math.PI / 2 }, approaches[2]];
    expect(buildPriorityGraph(turning).edges).toContainEqual({ from: 'west', to: 'east', reason: 'left' });
  });
  it('не применяет равнозначный граф к регулируемому перекрёстку и разным моментам прибытия', () => {
    const s = intersection(4);
    s.lights.push({ id: 'l1', x: -10, y: 3.5, angle: 0, lineLength: 3.5, green: 30, yellow: 3, red: 30, offset: 0 });
    expect(analyze(s, simulate(s)).findings.some((f) => /договорённость/.test(f.title))).toBe(false);
    s.lights = [];
    s.actors[3].delay = 20;
    s.actors[2].delay = 10;
    expect(analyze(s, simulate(s)).findings.some((f) => /договорённость/.test(f.title))).toBe(false);
  });
});
