import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { actorAtMobilityPlace, mobilityPlaceAt, mobilityPlacePermission } from '../src/mobility';
import { buildGeo, sidewalkAt } from '../src/geo';
import { movementPermission } from '../src/traffic-control';
import { actorSpec, dimsOf, emptyScene, normalizeScene, VEHICLES, type Actor, type MobilitySurface, type Scene, type TrafficLight } from '../src/scene';
import { DT, simulate, type Timeline, type Track } from '../src/sim';
import { MOBILITY_PRESETS, PRESETS } from '../src/presets';
import { classOf, signApplies } from '../src/restrictions';
import { prepare } from '../src/analysis/technical';

const simParameters = { deviceMass: 20, riderMass: 75, length: 1.2, width: 0.55, height: 1.7, accel: 1, brakeDecel: 3,
  source: 'Условные параметры независимого теста, не паспорт и не натурная валидация' };
const actor = (options: Partial<Actor> = {}): Actor => ({ id: 'rider', kind: 'vehicle', type: 'sim', age: 30,
  x: -10, y: 0, heading: 0, speed: 18, path: [{ x: 10, y: 0, v: 18 }], delay: 0, color: '#abc',
  simParameters: { ...simParameters }, flags: { drunk: false, noLicense: false, flees: false }, ...options });
function sceneFor(a = actor(), surface: MobilitySurface | null = 'cyclepath'): Scene {
  const s = emptyScene();
  s.env.accidentDate = '2026-10-22T12:00'; s.env.duration = 4;
  s.actors = [a];
  if (surface) s.sidewalks = [{ id: 'corridor', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], width: 3, smooth: false,
    mobilityKind: surface, travelDirection: 'both', source: 'Независимый условный обмер' }];
  return s;
}
// Authored positions and speeds are observations. This does not call simulate or derive
// the expected position/speed from its follower, braking or collision solver.
function observed(s: Scene, endpoints = new Map(s.actors.map(a => [a.id, { x: a.x + 20, y: a.y, h: a.heading, speed: a.speed }]))): Timeline {
  const n = 161;
  const tracks = new Map<string, Track>();
  for (const a of s.actors) {
    const end = endpoints.get(a.id)!;
    const tr: Track = { id: a.id, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n), v: new Float32Array(n),
      present: new Uint8Array(n).fill(1), free: new Uint8Array(n), waypointTimes: [4] };
    for (let k = 0; k < n; k++) { tr.x[k] = a.x + (end.x - a.x) * k / 160; tr.y[k] = a.y + (end.y - a.y) * k / 160;
      tr.h[k] = end.h; tr.v[k] = end.speed / 3.6; }
    tracks.set(a.id, tr);
  }
  return { dt: DT, n, duration: 4, mu: 0.7, tracks, collisions: [] };
}
const run = (s: Scene) => analyze(s, observed(s));
const place = (s: Scene) => mobilityPlaceAt(buildGeo(s), s.actors[0], s.actors[0].heading, dimsOf(s.actors[0]).width);
const permission = (a: Actor, surface: MobilitySurface) => { const s = sceneFor(a, surface); return mobilityPlacePermission(a, place(s)).allowed; };
const violations = (s: Scene) => run(s).findings.filter(f => f.severity === 'violation');
const road = () => ({ id: 'road', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 1, center: 'dashed' as const, oneWay: false, smooth: false, zone: 'city' as const });
const light = (options: Partial<TrafficLight> = {}): TrafficLight => ({ id: 'light', x: 0, y: 0, angle: 0, lineLength: 5,
  green: 0, yellow: 0, red: 100, offset: 0, ...options });

describe('самостоятельная категория и миграция', () => {
  it('СИМ не механическое ТС, не велосипед, не повозка; нет фиктивного физического набора', () => {
    expect(VEHICLES.sim).toMatchObject({ motorized: false, licenseRequired: false, mass: 0, accel: 0, vmax: 0 });
    const a = actor({ simParameters: undefined });
    expect(actorSpec(a)).toEqual({ mass: 0, length: 0, width: 0 });
    expect(() => simulate(sceneFor(a))).toThrow(/введите массу устройства и ездока/);
    const ctx = prepare(sceneFor(a), observed(sceneFor(a)));
    expect(classOf(ctx.infos.get(a.id)!)).toBe('sim');
  });
  it.each(['deviceMass', 'riderMass', 'length', 'width', 'height', 'accel', 'brakeDecel', 'source'] as const)('не считает неполный ввод %s готовым для симуляции', key => {
    const a = actor(); delete a.simParameters![key];
    expect(() => simulate(sceneFor(a))).toThrow(/СИМ/);
  });
  it('масса устройства для правил отделена от массы для импульса', () => {
    const a = actor({ simParameters: { ...simParameters, deviceMass: 35, riderMass: 100 } });
    expect(dimsOf(a).mass).toBe(135);
    expect(permission(a, 'pedestrian-zone')).toBe(true);
    expect(permission({ ...a, simParameters: { ...a.simParameters, deviceMass: 35.001 } }, 'pedestrian-zone')).toBe(false);
  });
  it('старые тротуары сохраняют смысл; возраст и факты не превращаются в false/18', () => {
    const s = sceneFor(actor({ type: 'bicycle', age: undefined, simParameters: undefined }), 'sidewalk');
    delete s.sidewalks[0].mobilityKind;
    const migrated = normalizeScene(JSON.parse(JSON.stringify(s)));
    expect(migrated.actors[0].age).toBeUndefined(); expect(migrated.actors[0].mobilityContext).toBeUndefined();
    expect(place(migrated).surface).toBe('sidewalk');
    expect(mobilityPlacePermission(migrated.actors[0], place(migrated)).allowed).toBeNull();
  });
  it('round trip сохраняет явные false, источник, сигнал силуэта и режим ведущего устройство', () => {
    const s = sceneFor(actor({ mobilityContext: { adultAccompanied: false, pedestrianObstruction: false, source: 'Показания' } }));
    s.lights = [light({ kind: 'bicycle' })];
    s.actors.push(actor({ id: 'walking', kind: 'pedestrian', type: 'adult', leadingDevice: 'sim', simParameters: undefined }));
    const roundtrip = normalizeScene(JSON.parse(JSON.stringify(s)));
    expect(roundtrip.actors[0].simParameters).toEqual(simParameters);
    expect(roundtrip.actors[0].mobilityContext?.adultAccompanied).toBe(false);
    expect(roundtrip.actors[1].leadingDevice).toBe('sim'); expect(roundtrip.lights[0].kind).toBe('bicycle');
  });
  it('миграция отбрасывает недопустимые значения вместо подмены исходных фактов', () => {
    const a = actor({ age: -1, simParameters: { deviceMass: -1, riderMass: NaN, source: '  ' },
      mobilityContext: { adultAccompanied: 'yes' as unknown as boolean, pedestrianObstruction: false } });
    const n = normalizeScene(sceneFor(a));
    expect(n.actors[0].age).toBeUndefined(); expect(n.actors[0].simParameters?.deviceMass).toBeUndefined();
    expect(n.actors[0].mobilityContext).toEqual({ pedestrianObstruction: false });
  });
});

describe('возраст и допустимые места по тексту раздела 24', () => {
  it.each(['bicycle', 'sim'] as const)('%s: границы 6/7/13/14/15 лет проверяются отдельно', type => {
    const make = (age: number) => actor({ type, age, mobilityContext: { adultAccompanied: true } });
    expect(permission(make(6), 'cyclepath')).toBe(false);
    expect(permission(make(6), 'cycle-side')).toBe(false);
    expect(permission(make(6), 'pedestrian-side')).toBe(true);
    expect(permission(make(7), 'cyclepath')).toBe(true);
    expect(permission(make(13), 'cyclepath')).toBe(true);
    expect(permission(make(13), 'cycle-lane')).toBe(false);
    expect(permission(make(14), 'cyclepath')).toBe(true);
    expect(permission(make(14), 'cycle-lane')).toBe(true);
    expect(permission(make(15), 'cycle-lane')).toBe(true);
  });
  it.each([undefined, false, true])('СИМ до 7: сопровождение взрослого %s', adultAccompanied => {
    expect(permission(actor({ age: 6, mobilityContext: { adultAccompanied } }), 'sidewalk')).toBe(adultAccompanied ?? null);
  });
  it('масса более 35 кг не запрещает велодорожку взрослому и тротуар ребёнку 7–13 по 24.3', () => {
    const a = actor({ simParameters: { ...simParameters, deviceMass: 50 } });
    expect(permission(a, 'cyclepath')).toBe(true);
    expect(permission({ ...a, age: 10 }, 'sidewalk')).toBe(true);
    expect(permission(a, 'sidewalk')).toBe(false);
  });
  it('велосипед: правый край/обочина/тротуар требуют разных условий, не общую льготу', () => {
    const a = actor({ type: 'bicycle', mobilityContext: { cycleInfrastructureUnavailable: true, carriagewayUnavailable: false, shoulderUnavailable: false,
      accompaniesChildUnder14: false, carriesChildUnder7: false } });
    expect(permission(a, 'shoulder')).toBe(false); expect(permission(a, 'sidewalk')).toBe(false);
    expect(permission({ ...a, mobilityContext: { ...a.mobilityContext, carriagewayUnavailable: true } }, 'shoulder')).toBe(true);
    expect(permission({ ...a, mobilityContext: { accompaniesChildUnder14: true } }, 'sidewalk')).toBe(true);
    expect(permission({ ...a, mobilityContext: { carriesChildUnder7: true } }, 'sidewalk')).toBe(true);
  });
  it.each([undefined, false, true])('СИМ: отсутствие велоинфраструктуры %s на тротуаре', cycleInfrastructureUnavailable => {
    const a = actor({ mobilityContext: { cycleInfrastructureUnavailable, accompaniesChildUnder14: false } });
    expect(permission(a, 'sidewalk')).toBe(cycleInfrastructureUnavailable ?? null);
  });
  it('СИМ: сопровождение ребёнка не отменяет 35 кг', () => {
    const a = actor({ mobilityContext: { accompaniesChildUnder14: true, cycleInfrastructureUnavailable: false } });
    expect(permission(a, 'sidewalk')).toBe(true);
    a.simParameters!.deviceMass = 36;
    expect(permission(a, 'sidewalk')).toBe(false);
  });
  it('мопед: велополоса разрешена; велодорожка и тротуар не наследуют велосипедные права', () => {
    const a = actor({ type: 'moped' });
    expect(permission(a, 'cycle-lane')).toBe(true); expect(permission(a, 'cyclepath')).toBe(false); expect(permission(a, 'sidewalk')).toBe(false);
    expect(permission(a, 'shoulder')).toBeNull();
    expect(permission({ ...a, mobilityContext: { pedestrianObstruction: false } }, 'shoulder')).toBe(true);
  });
});

describe('геометрия, правый край и велосипедные зоны', () => {
  it('коридор ограничен шириной и торцами, соседняя дорога не превращается в велодорожку', () => {
    const s = sceneFor(); s.sidewalks[0].pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const geo = buildGeo(s);
    expect(mobilityPlaceAt(geo, { x: 5, y: 1.5 }, 0).surface).toBe('cyclepath');
    expect(mobilityPlaceAt(geo, { x: 5, y: 1.501 }, 0).surface).toBe('unknown');
    expect(mobilityPlaceAt(geo, { x: 10.01, y: 0 }, 0).surface).toBe('unknown');
    expect(sidewalkAt(geo, { x: 5, y: 0 })).toBeNull();
  });
  it('геометрия велополосы подавляет ложный generic opposing/sidewalk вывод', () => {
    const s = sceneFor(actor({ y: -1, path: [{ x: 10, y: -1, v: 18 }] }), 'cycle-lane'); s.roads = [road()];
    expect(violations(s).flatMap(f => f.refs)).not.toContain('pdd:9.1(1)');
    expect(violations(s).flatMap(f => f.refs)).not.toContain('pdd:9.9');
  });
  it('правый край измеряется от локальной кромки и учитывает направление и ширину', () => {
    const s = sceneFor(actor({ y: 3 }), null); s.roads = [road()];
    const geo = buildGeo(s);
    expect(mobilityPlaceAt(geo, { x: 0, y: 3 }, 0, 0.55).rightEdge).toBe(true);
    expect(mobilityPlaceAt(geo, { x: 0, y: 1.75 }, 0, 0.55).rightEdge).toBe(false);
    expect(mobilityPlaceAt(geo, { x: 0, y: -3 }, Math.PI, 0.55).rightEdge).toBe(true);
    expect(mobilityPlaceAt(geo, { x: 0, y: -3 }, 0, 0.55).rightEdge).toBe(false);
    s.roads[0].wr = [{ s: 0, w: 3.5 }, { s: 200, w: 1.5 }];
    expect(mobilityPlaceAt(buildGeo(s), { x: 0, y: 2.1 }, 0, 0.55).rightEdge).toBe(true);
  });
  it.each([60, 60.01, 90])('СИМ по правому краю: дорожный предел %s', roadSpeedLimit => {
    const a = actor({ y: 3, mobilityContext: { cycleInfrastructureUnavailable: true, pedestrianInfrastructureUnavailable: true,
      shoulderUnavailable: true, roadAllowsCycling: true, roadSpeedLimit, roadEquipmentComplete: true } });
    const s = sceneFor(a, null); s.roads = [road()];
    expect(mobilityPlacePermission(a, place(s)).allowed).toBe(roadSpeedLimit <= 60);
  });
  it.each(['cycleInfrastructureUnavailable', 'pedestrianInfrastructureUnavailable', 'shoulderUnavailable', 'roadAllowsCycling', 'roadEquipmentComplete'] as const)('СИМ на дороге: неизвестное условие %s не даёт разрешение', missing => {
    const a = actor({ y: 3, mobilityContext: { cycleInfrastructureUnavailable: true, pedestrianInfrastructureUnavailable: true,
      shoulderUnavailable: true, roadAllowsCycling: true, roadSpeedLimit: 60, roadEquipmentComplete: true } });
    delete a.mobilityContext![missing];
    const s = sceneFor(a, null); s.roads = [road()];
    expect(mobilityPlacePermission(a, place(s)).allowed).toBeNull();
  });
  it('5.39 и 5.33.1 без геометрии и источника не дают льготу велосипедной зоны', () => {
    const a = actor(); const s = sceneFor(a, null); s.roads = [road()];
    s.signs = ['5.39', '5.33.1'].map((kind, n) => ({ id: `sign${n}`, x: -40, y: 0, angle: 0, kind }));
    expect(place(s).cycleZone).toBe(false);
    s.sidewalks = [{ id: 'zone', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], width: 7, smooth: false, mobilityKind: 'cycle-zone' }];
    expect(mobilityPlacePermission(a, place(s)).allowed).toBe(false);
    s.sidewalks[0].source = 'Обмеренная граница и подтверждённое назначение';
    expect(mobilityPlacePermission(a, place(s)).allowed).toBe(true);
  });
});

describe('скорость, пешеходы и пересечение перехода на независимых треках', () => {
  it.each([25, 25.1, 40])('СИМ на велодорожке при %s км/ч', speed => {
    const refs = violations(sceneFor(actor({ speed }))).flatMap(f => f.refs);
    expect(refs.includes('pdd:24.6')).toBe(speed > 25);
  });
  it('жилая зона 20 и знак 10 уменьшают предел СИМ; знак 40 не повышает 25', () => {
    const a = actor({ speed: 24, y: 3 }); const s = sceneFor(a, null); s.roads = [{ ...road(), zone: 'residential' }];
    expect(violations(s).some(f => f.trace.limit === 20)).toBe(true);
    s.roads[0].zone = 'city';
    s.signs = [{ id: 'speed', kind: '3.24', value: 10, x: 0, y: 5.5, angle: 0 }];
    expect(violations(s).some(f => f.trace.limit === 10)).toBe(true);
    s.signs[0].value = 40; a.speed = 30;
    expect(violations(s).some(f => f.trace.limit === 25)).toBe(true);
  });
  it('правомерный тротуар СИМ и велосипеда не получает 9.9', () => {
    for (const type of ['bicycle', 'sim'] as const) {
      const s = sceneFor(actor({ type, mobilityContext: { accompaniesChildUnder14: true, pedestrianObstruction: false,
        pedestrianDanger: false, pedestrianPriorityRespected: true } }), 'sidewalk');
      expect(violations(s)).toEqual([]);
    }
  });
  it('велосипед при помехе должен спешиться даже на скорости пешехода', () => {
    const s = sceneFor(actor({ type: 'bicycle', speed: 4, mobilityContext: { accompaniesChildUnder14: true, pedestrianObstruction: true, pedestrianSpeedKmh: 5 } }), 'sidewalk');
    expect(violations(s).some(f => f.refs.includes('pdd:24.6'))).toBe(true);
  });
  it.each([4, 5, 5.1])('СИМ при помехе: скорость %s при скорости пешехода 5', speed => {
    const s = sceneFor(actor({ speed, mobilityContext: { accompaniesChildUnder14: true, pedestrianObstruction: true, pedestrianSpeedKmh: 5, pedestrianPriorityRespected: true } }), 'sidewalk');
    expect(violations(s).some(f => f.refs.includes('pdd:24.6'))).toBe(speed > 5);
  });
  it('неизвестные помехи и приоритет не считаются соблюдёнными', () => {
    const s = sceneFor(actor({ mobilityContext: { accompaniesChildUnder14: true } }), 'sidewalk');
    expect(run(s).findings.filter(f => f.refs.includes('pdd:24.6')).every(f => f.compliance === 'не определить')).toBe(true);
    expect(run(s).verdicts[0].status).toBe('insufficient-data');
  });
  it.each(['bicycle', 'sim', 'moped'] as const)('%s верхом поперёк зебры нарушает 24.8, вдоль — нет', type => {
    const a = actor({ type, x: 0, y: -10, heading: Math.PI / 2 }); const s = sceneFor(a, null); s.roads = [road()];
    s.crosswalks = [{ id: 'zebra', x: 0, y: 0, angle: Math.PI / 2, width: 4, length: 8 }];
    const across = observed(s, new Map([[a.id, { x: 0, y: 10, h: Math.PI / 2, speed: 18 }]]));
    expect(analyze(s, across).findings.some(f => f.severity === 'violation' && f.refs.includes('pdd:24.8'))).toBe(true);
    a.x = -10; a.y = 0; a.heading = 0;
    expect(violations(s).some(f => f.refs.includes('pdd:24.8'))).toBe(false);
  });
  it('пешеход, ведущий СИМ, не получает запрет верхового пересечения 24.8', () => {
    const a = actor({ kind: 'pedestrian', type: 'adult', leadingDevice: 'sim', x: 0, y: -10, heading: Math.PI / 2 });
    const s = sceneFor(a, null); s.roads = [road()]; s.crosswalks = [{ id: 'cw', x: 0, y: 0, angle: Math.PI / 2, width: 4, length: 8 }];
    const rep = analyze(s, observed(s, new Map([[a.id, { x: 0, y: 10, h: Math.PI / 2, speed: 5 }]])));
    expect(rep.findings.some(f => f.refs.includes('pdd:24.8'))).toBe(false);
  });
});

describe('сигналы по месту движения и по пешеходному правилу 6.10', () => {
  it.each([['sidewalk', 'pedestrian'], ['footpath', 'pedestrian'], ['cyclepath', 'bicycle'], ['sharedpath', 'bicycle'], ['cycle-lane', 'bicycle'], ['carriageway', 'vehicle']] as const)('СИМ %s следует сигналу %s', (signalSurface, kind) => {
    expect(movementPermission(light({ kind, green: 100, red: 0 }), { type: 'sim', heading: 0, signalSurface }, 'straight', 0).allowed).toBe(true);
    expect(movementPermission(light({ kind }), { type: 'sim', heading: 0, signalSurface }, 'straight', 0).allowed).toBe(false);
  });
  it('автомобильный сигнал не подменяет пешеходный на тротуаре', () => {
    expect(movementPermission(light({ green: 100, red: 0 }), { type: 'sim', heading: 0, signalSurface: 'sidewalk' }, 'straight', 0).allowed).toBeNull();
    const s = sceneFor(actor(), 'sidewalk'); s.lights = [light({ green: 100, red: 0 })];
    expect(run(s).findings.some(f => f.refs.includes('pdd:6.5') && f.compliance === 'не определить')).toBe(true);
  });
  it('велосипедный силуэт не адресован автомобилю и мопеду вне велополосы', () => {
    expect(movementPermission(light({ kind: 'bicycle' }), { type: 'car', heading: 0 }, 'straight', 0).allowed).toBeNull();
    expect(movementPermission(light({ kind: 'bicycle' }), { type: 'moped', heading: 0, signalSurface: 'cycle-lane' }, 'straight', 0).allowed).toBe(false);
  });
  it('СИМ на запрещающий велосипедный силуэт: полный анализ', () => {
    const s = sceneFor(); s.lights = [light({ kind: 'bicycle' })];
    const f = violations(s).find(f => f.refs.includes('pdd:6.5'))!;
    expect(f).toBeDefined(); expect(f.refs).toContain('koap:12.29.2'); expect(f.refs).not.toContain('koap:12.12.1');
  });
  it.each([['arms-out', Math.PI / 2, -1, true], ['arms-out', 0, -1, false], ['right-arm-forward', Math.PI / 2, -2, true],
    ['right-arm-forward', Math.PI / 2, 2, false], ['arm-up', Math.PI / 2, -2, false], ['stop', Math.PI / 2, -2, false]] as const)('СИМ: регулировщик %s, курс %s, x=%s', (controllerGesture, heading, x, allowed) => {
    expect(movementPermission(light({ kind: 'controller', controllerGesture }), { type: 'sim', heading, x, y: -10 }, 'straight', 0).allowed).toBe(allowed);
  });
  it('на границе груди/спины и без координат не предполагает переход за спиной', () => {
    const l = light({ kind: 'controller', controllerGesture: 'right-arm-forward' });
    expect(movementPermission(l, { type: 'sim', heading: Math.PI / 2, x: 0, y: -10 }, 'straight', 0).allowed).toBeNull();
    expect(movementPermission(l, { type: 'sim', heading: Math.PI / 2 }, 'straight', 0).allowed).toBeNull();
  });
  it('адаптер сигнала использует наблюдаемую позицию, а не начало траектории', () => {
    const a = actor({ x: 10 }); const s = sceneFor(a);
    expect(actorAtMobilityPlace(buildGeo(s), a, { x: -3, y: 10 }, Math.PI / 2).x).toBe(-3);
  });
});

describe('правовая квалификация, знаки и пресеты', () => {
  it.each([undefined, 15, 16])('возраст %s: 12.29 не назначается до установленного субъекта 16+', age => {
    const s = sceneFor(actor({ age, speed: 30 }));
    const refs = run(s).findings.flatMap(f => f.refs);
    expect(refs.includes('koap:12.29.2')).toBe(age === 16);
  });
  it('опьянение на СИМ — 12.29.3, без прав и автомобильной 12.8', () => {
    const a = actor({ speed: 30, flags: { drunk: true, noLicense: true, flees: false } });
    const refs = run(sceneFor(a)).findings.flatMap(f => f.refs);
    expect(refs).toContain('koap:12.29.3'); expect(refs.some(r => /^koap:12\.(7|8|9)\./.test(r))).toBe(false);
  });
  it('12.30 требует заданных причинных последствий и источника; помеха пешеходам не равна помехе ТС', () => {
    const a = actor({ speed: 30, mobilityContext: { pedestrianObstruction: true } });
    let s = sceneFor(a);
    expect(run(s).findings.flatMap(f => f.refs)).not.toContain('koap:12.30.1');
    a.mobilityContext = { causedVehicleObstruction: true, consequenceRuleRef: 'pdd:24.6', source: 'Установленная связь нарушения 24.6 и помехи ТС' };
    expect(run(s).findings.flatMap(f => f.refs)).toContain('koap:12.30.1');
    a.mobilityContext = { negligentHarm: 'medium', consequenceRuleRef: 'pdd:24.6', source: 'Условное заключение и причинная связь' };
    expect(run(s).findings.flatMap(f => f.refs)).toContain('koap:12.30.2');
    a.mobilityContext.source = '';
    expect(run(s).findings.flatMap(f => f.refs)).not.toContain('koap:12.30.2');
  });
  it.each([['8.4.7', 'не определить'], ['8.4.15', 'не выполнено'], ['8.4.16', 'не выполнено']])('%s не предоставляет льготу велосипеду: %s', (plate, expected) => {
    expect(signApplies({ id: 'sign', x: 0, y: 0, angle: 0, kind: '3.9', plates: [plate] }, 'bicycle')).toBe(true);
    const a = actor({ type: 'bicycle' }); const s = sceneFor(a);
    s.signs = [{ id: 'sign', x: 0, y: 0, angle: 0, kind: '3.9', plates: [plate] }];
    const finding = run(s).findings.find(f => f.refs.includes('sign:3.9'))!;
    expect(finding.compliance).toBe(expected);
  });
  it('3.9 запрещает велосипед и мопед, не СИМ; 3.35 проверен по первоисточнику', () => {
    for (const type of ['bicycle', 'moped', 'sim'] as const) {
      const s = sceneFor(actor({ type })); s.signs = [{ id: 'ban', x: 0, y: 0, angle: 0, kind: '3.9' }];
      expect(violations(s).some(f => f.refs.includes('sign:3.9'))).toBe(type !== 'sim');
    }
    const s = sceneFor(); s.signs = [{ id: 'ban', x: 0, y: 0, angle: 0, kind: '3.35' }];
    expect(run(s).findings.find(f => f.refs.includes('sign:3.35'))?.compliance).toBe('не выполнено');
  });
  it('3.10 адресован пешеходу и едущему СИМ по редакции 1769', () => {
    const s = sceneFor(); s.signs = [{ id: 'ban', x: 0, y: 0, angle: 0, kind: '3.10' }];
    expect(violations(s).some(f => f.refs.includes('sign:3.10'))).toBe(true);
    s.actors[0] = actor({ kind: 'pedestrian', type: 'adult', leadingDevice: 'sim' });
    expect(violations(s).some(f => f.refs.includes('sign:3.10') && f.refs.includes('koap:12.29.1'))).toBe(true);
  });
  it.each(MOBILITY_PRESETS.map(p => [p.id, p] as const))('отдельный пресет %s и экспорт/импорт', (id, preset) => {
    const s = normalizeScene(JSON.parse(JSON.stringify(preset.build())));
    const rep = analyze(s, simulate(s));
    const v = rep.findings.filter(f => f.severity === 'violation');
    if (id.endsWith('correct')) expect(v).toEqual([]);
    else expect(v.some(f => f.refs.includes('pdd:24.8'))).toBe(true);
    expect(rep.technical).toBeDefined(); expect(rep.rules).toBeDefined(); expect(rep.legal).toBeDefined();
  });
  it('все прежние и новые пресеты остаются рассчитываемыми', () => {
    for (const preset of PRESETS) expect(() => simulate(normalizeScene(preset.build())), preset.id).not.toThrow();
  });
});

describe('приоритет и конфликт с общими проверками', () => {
  it('13.1 распространяется на едущего СИМ на выездной дороге', () => {
    const s = sceneFor(actor({ id: 'turner', type: 'car', x: -20, y: 1.75, speed: 18,
      path: [{ x: -5, y: 1.75, v: 18 }, { x: -1.75, y: 5, v: 18 }, { x: -1.75, y: 30, v: 18 }] }), null);
    s.roads = [road(), { ...road(), id: 'vertical', pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }];
    const sim = actor({ id: 'crossing', x: -10, y: 9, path: [{ x: 10, y: 9, v: 18 }] });
    s.actors.push(sim);
    const tl = observed(s);
    const tr = tl.tracks.get('turner')!;
    for (let k = 0; k < tl.n; k++) {
      const t = k * DT;
      if (t < 2) { tr.x[k] = -20 + t * 10; tr.y[k] = 1.75; tr.h[k] = 0; }
      else { tr.x[k] = -1.75; tr.y[k] = 1.75 + (t - 2) * 12; tr.h[k] = Math.PI / 2; }
    }
    const rep = analyze(s, tl);
    expect(rep.rules.priorityGraphs.flatMap(g => g.edges).some(e => e.from === 'turner' && e.to === 'crossing' && e.refs.includes('pdd:13.1'))).toBe(true);
  });
  it('зебра не даёт едущему СИМ преимущество пешехода по 14.1', () => {
    const a = actor({ id: 'driver', type: 'car', x: -10, y: 1.75 }); const s = sceneFor(a, null);
    s.roads = [road()]; s.crosswalks = [{ id: 'cw', x: 0, y: 0, length: 8, width: 4, angle: Math.PI / 2 }];
    const sim = actor({ id: 'sim', x: 0, y: -10, heading: Math.PI / 2 }); s.actors.push(sim);
    const tl = observed(s, new Map([['driver', { x: 10, y: 1.75, h: 0, speed: 18 }], ['sim', { x: 0, y: 10, h: Math.PI / 2, speed: 18 }]]));
    tl.collisions = [{ idx: 0, t: 2, frame: 80, a: 'driver', b: 'sim', point: { x: 0, y: 1.75 }, n: { x: 0, y: 1 }, kind: 'vv',
      vA: { x: 5, y: 0 }, vB: { x: 0, y: 5 }, rel: 7.07, dvA: 0, dvB: 0 }];
    const rep = analyze(s, tl);
    expect(rep.findings.filter(f => f.actorId === 'driver').flatMap(f => f.refs)).not.toContain('pdd:14.1');
    expect(rep.findings.some(f => f.actorId === 'sim' && f.refs.includes('pdd:24.8'))).toBe(true);
  });
  it('велозона даёт приоритет перед механическим ТС; неподтверждённая зона его не даёт', () => {
    const s = sceneFor(actor({ id: 'sim', x: -10, y: 1.75 }), 'cycle-zone');
    s.sidewalks[0].width = 100;
    s.roads = [road(), { ...road(), id: 'vertical', pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }];
    s.actors.push(actor({ id: 'car', type: 'car', x: -1.75, y: -10, heading: Math.PI / 2, path: [{ x: -1.75, y: 10, v: 18 }] }));
    const tl = observed(s, new Map([['sim', { x: 10, y: 1.75, h: 0, speed: 18 }], ['car', { x: -1.75, y: 10, h: Math.PI / 2, speed: 18 }]]));
    expect(analyze(s, tl).rules.priorityGraphs.flatMap(g => g.edges).some(e => e.from === 'car' && e.to === 'sim' && e.refs.includes('pdd:24.11'))).toBe(true);
    delete s.sidewalks[0].source;
    expect(analyze(s, tl).rules.priorityGraphs.flatMap(g => g.edges).some(e => e.refs.includes('pdd:24.11'))).toBe(false);
  });
  it.each([undefined, false, true])('левый поворот на многополосной дороге: разрешение из правой полосы %s', leftTurnPermittedFromRight => {
    const a = actor({ x: -10, y: 3, path: [{ x: -2, y: 3, v: 18 }, { x: 1.75, y: -10, v: 18 }], mobilityContext: { leftTurnPermittedFromRight } });
    const s = sceneFor(a, null); s.roads = [{ ...road(), lanes: 2 }, { ...road(), id: 'vertical', pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }];
    const tl = observed(s), tr = tl.tracks.get(a.id)!;
    for (let k = 0; k < tl.n; k++) {
      const t = k * DT;
      tr.x[k] = t < 2 ? -10 + t * 5 : 1.75; tr.y[k] = t < 2 ? 3 : 3 - (t - 2) * 10; tr.h[k] = t < 2 ? 0 : -Math.PI / 2;
    }
    const finding = analyze(s, tl).findings.find(f => f.title === 'ограничение левого поворота и разворота');
    expect(finding).toBeDefined();
    expect(finding!.compliance).toBe(leftTurnPermittedFromRight === undefined ? 'не определить' : leftTurnPermittedFromRight ? 'выполнено' : 'не выполнено');
    expect(analyze(s, tl).findings.some(f => f.severity === 'violation' && f.refs.includes('pdd:8.5'))).toBe(false);
  });
  it('12.30 не назначается другому нарушению той же сцены', () => {
    const a = actor({ speed: 30, mobilityContext: { causedVehicleObstruction: true, consequenceRuleRef: 'pdd:24.8', source: 'Связь только с переходом' } });
    expect(run(sceneFor(a)).findings.flatMap(f => f.refs)).not.toContain('koap:12.30.1');
  });
  it('знак 40 не повышает жилой предел 20 для СИМ', () => {
    const s = sceneFor(actor({ speed: 24, y: 3 }), null); s.roads = [{ ...road(), zone: 'residential' }];
    s.signs = [{ id: 'speed', x: -5, y: 5, angle: 0, kind: '3.24', value: 40 }];
    expect(violations(s).some(f => f.trace.limit === 20)).toBe(true);
  });
});

  it('сигнал рукой для СИМ не получает автомобильный fallback при отсутствии указателей', () => {
    const s = sceneFor(actor({ x: -10, y: 3, path: [{ x: -2, y: 3, v: 18 }, { x: -1.75, y: 10, v: 18 }],
      maneuverContext: { handSignal: 'right' } }), null);
    s.roads = [road(), { ...road(), id: 'vertical', pts: [{ x: 0, y: -100 }, { x: 0, y: 100 }] }];
    const tl = observed(s), tr = tl.tracks.get('rider')!;
    for (let k = 80; k < tl.n; k++) { tr.x[k] = -1.75; tr.y[k] = 3 + (k - 80) / 8; tr.h[k] = Math.PI / 2; }
    const signals = analyze(s, tl).findings.filter(f => f.actorId === 'rider' && f.refs.includes('pdd:8.1'));
    expect(signals.some(f => f.title === 'соответствующий сигнал рукой задан' && f.trace.handSignal === 'right')).toBe(true);
    expect(signals.some(f => f.severity === 'violation')).toBe(false);
  });

it.each([['forward', 0, true], ['forward', Math.PI, false], ['reverse', Math.PI, true], ['both', Math.PI, true], [undefined, 0, null]] as const)(
  'велополоса: направление %s при курсе %s', (travelDirection, heading, allowed) => {
    const a = actor({ heading }); const s = sceneFor(a, 'cycle-lane'); s.sidewalks[0].travelDirection = travelDirection;
    expect(mobilityPlacePermission(a, place(s)).allowed).toBe(allowed);
  });
