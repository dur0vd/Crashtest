import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { PRESETS, ROUTE_TRANSPORT_PRESETS } from '../src/presets';
import { cloneScene, normalizeScene } from '../src/scene';
import { simulate } from '../src/sim';

const sceneOf = (id: string) => normalizeScene(cloneScene(PRESETS.find(preset => preset.id === id)!.build()));

describe('автобус от обозначенной остановки', () => {
  it('пример содержит фактическую остановку, выезд и конфликт с обязанностями обоих', () => {
    expect(ROUTE_TRANSPORT_PRESETS.every(preset => PRESETS.includes(preset))).toBe(true);
    const scene = sceneOf('bus-stop-departure-conflict'), timeline = simulate(scene);
    const [bus, ordinary] = scene.actors;
    const track = timeline.tracks.get(bus.id)!;
    expect([...track.v].filter(speed => speed === 0).length * timeline.dt).toBeGreaterThanOrEqual(2);
    expect(timeline.collisions.some(contact => contact.kind === 'vv')).toBe(true);
    const contact = timeline.collisions.find(contact => contact.kind === 'vv')!;
    // The observed departure is interrupted by contact, rather than completing
    // its planned merge. Do not require a completed manoeuvre to apply 18.3.
    expect(track.x[contact.frame - 1]).toBeGreaterThan(bus.x + 0.5);
    expect(track.v[contact.frame - 1]).toBeGreaterThan(0.1);
    const report = analyze(scene, timeline);
    expect(report.rules.findings.some(finding => finding.actorId === ordinary.id && finding.severity === 'violation'
      && finding.causal && finding.refs.includes('pdd:18.3'))).toBe(true);
    expect(report.rules.findings.some(finding => finding.actorId === bus.id && finding.severity === 'violation'
      && finding.refs.includes('pdd:18.3'))).toBe(true);
    expect(report.findings.some(finding => finding.actorId === ordinary.id && finding.refs.includes('koap:12.17#1'))).toBe(true);
  });

  it('уступающий действительно тормозит перед конфликтом без сдвига появления участников', () => {
    const bad = sceneOf('bus-stop-departure-conflict'), scene = sceneOf('bus-stop-departure-yield');
    expect(scene.roads).toEqual(bad.roads);
    expect(scene.routeStops).toEqual(bad.routeStops);
    expect(scene.actors.map(actor => [actor.type, actor.x, actor.y, actor.speed, actor.delay]))
      .toEqual(bad.actors.map(actor => [actor.type, actor.x, actor.y, actor.speed, actor.delay]));
    expect(scene.actors.every(actor => actor.delay === 0)).toBe(true);
    const timeline = simulate(scene), report = analyze(scene, timeline);
    expect(timeline.collisions).toHaveLength(0);
    const [bus, ordinary] = scene.actors, car = timeline.tracks.get(ordinary.id)!;
    const waiting = [...car.v].map((speed, frame) => speed === 0 ? frame : -1).filter(frame => frame >= 0);
    expect(waiting.length * timeline.dt).toBeGreaterThanOrEqual(10);
    expect(waiting.every(frame => car.x[frame] < -25)).toBe(true);
    expect(timeline.tracks.get(bus.id)!.x.at(-1)).toBeGreaterThan(20);
    expect(report.rules.findings.some(finding => finding.actorId === ordinary.id && finding.severity === 'info'
      && finding.refs.includes('pdd:18.3') && finding.compliance === 'выполнено')).toBe(true);
    expect(report.findings.some(finding => finding.actorId === ordinary.id && finding.refs.includes('koap:12.17#1'))).toBe(false);
  });
});

describe('общая и выделенная полосы', () => {
  it('обычный автомобиль в выделенке получает отдельную квалификацию', () => {
    const scene = sceneOf('route-lane-private-car'), report = analyze(scene, simulate(scene));
    expect(report.rules.findings.some(finding => finding.actorId === scene.actors[0].id && finding.severity === 'violation'
      && finding.refs.includes('pdd:18.2'))).toBe(true);
    expect(report.findings.some(finding => finding.actorId === scene.actors[0].id && finding.refs.includes('koap:12.17#1.1'))).toBe(true);
    expect(report.rules.findings.some(finding => finding.actorId === scene.actors[1].id && finding.severity === 'violation'
      && finding.refs.includes('pdd:18.2'))).toBe(false);
  });

  it('обычная полоса сохраняет дорогу и участников без нарушения18.2', () => {
    const bad = sceneOf('route-lane-private-car'), scene = sceneOf('route-lane-keep-ordinary');
    expect(scene.roads).toEqual(bad.roads);
    expect(scene.actors.map(actor => actor.type)).toEqual(bad.actors.map(actor => actor.type));
    const timeline = simulate(scene), report = analyze(scene, timeline);
    expect(timeline.collisions).toHaveLength(0);
    expect(report.rules.findings.some(finding => finding.actorId === scene.actors[0].id && finding.severity === 'violation'
      && finding.refs.includes('pdd:18.2'))).toBe(false);
  });
});

describe('сохранение неопределённых исходных данных', () => {
  it('не подставляет город и статус регулярного маршрута при загрузке', () => {
    const raw = sceneOf('route-lane-private-car');
    delete raw.env.federalCity;
    delete raw.actors[1].routeContext;
    delete raw.roads[0].routeLanes![0].rightmost;
    const scene = normalizeScene(cloneScene(raw));
    expect(scene.env).not.toHaveProperty('federalCity');
    expect(scene.actors[1]).not.toHaveProperty('routeContext');
    expect(scene.roads[0].routeLanes![0]).not.toHaveProperty('rightmost');
  });

  it('сохраняет подтверждённое false и неизвестную проверку для конкретной пары', () => {
    const raw = cloneScene(sceneOf('bus-stop-departure-conflict')) as any;
    raw.actors[0].routeContext = { regularService: false, taxi: 'no', routeVehiclesUnimpeded: true,
      departureStopId: 'rs1', departureChecks: [{ otherId: raw.actors[1].id, yieldingVerified: 'yes' }] };
    const scene = normalizeScene(raw);
    expect(scene.actors[0].routeContext).toEqual({ regularService: false, routeVehiclesUnimpeded: true,
      departureStopId: 'rs1', departureChecks: [{ otherId: raw.actors[1].id }] });
  });

  it('отклоняет неверную геометрию полосы вместо выдуманной ширины', () => {
    const raw = sceneOf('route-lane-private-car');
    raw.roads[0].routeLanes![0].width = 0;
    expect(() => normalizeScene(raw)).toThrow(/Маршрутная полоса/);
  });
});
