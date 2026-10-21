import { rad } from './geom';
import {
  type Actor,
  type CenterMarking,
  type Crosswalk,
  type Marking,
  type Obstacle,
  type PedestrianType,
  type Road,
  type Scene,
  type Sign,
  type TrafficLight,
  type TramTrack,
  type VehicleType,
  type Waypoint,
  PEDESTRIANS,
  VEHICLES,
  emptyScene,
} from './scene';

// Небольшой конструктор сцен для готовых примеров.

class Builder {
  scene: Scene = emptyScene();
  private n = 0;
  private id(p: string): string {
    return `${p}${++this.n}`;
  }

  name(s: string): this {
    this.scene.name = s;
    return this;
  }

  road(pts: [number, number][], o: Partial<Road> = {}): this {
    this.scene.roads.push({
      id: this.id('r'),
      pts: pts.map(([x, y]) => ({ x, y })),
      lanes: 1,
      center: 'dashed' as CenterMarking,
      oneWay: false,
      zone: 'city',
      smooth: false,
      ...o,
    });
    return this;
  }

  sidewalk(pts: [number, number][], width = 3): this {
    this.scene.sidewalks.push({ id: this.id('s'), pts: pts.map(([x, y]) => ({ x, y })), width, smooth: false });
    return this;
  }

  track(pts: [number, number][], o: Partial<TramTrack> = {}): this {
    this.scene.tracks.push({ id: this.id('t'), pts: pts.map(([x, y]) => ({ x, y })), separated: false, smooth: false, ...o });
    return this;
  }

  crosswalk(x: number, y: number, angleDeg: number, o: Partial<Crosswalk> = {}): this {
    this.scene.crosswalks.push({ id: this.id('c'), x, y, angle: rad(angleDeg), length: 8, width: 4, ...o });
    return this;
  }

  light(x: number, y: number, angleDeg: number, cycle: [number, number, number], offset = 0, lineLength = 3.5): string {
    const l: TrafficLight = {
      id: this.id('l'),
      x,
      y,
      angle: rad(angleDeg),
      lineLength,
      green: cycle[0],
      yellow: cycle[1],
      red: cycle[2],
      offset,
    };
    this.scene.lights.push(l);
    return l.id;
  }

  sign(kind: string, x: number, y: number, angleDeg: number, value?: number): this {
    const s: Sign = { id: this.id('g'), x, y, angle: rad(angleDeg), kind, value };
    this.scene.signs.push(s);
    return this;
  }

  obstacle(kind: Obstacle['kind'], x: number, y: number, w: number, h: number, angleDeg = 0): this {
    this.scene.obstacles.push({ id: this.id('o'), x, y, w, h, angle: rad(angleDeg), kind });
    return this;
  }

  vehicle(type: VehicleType, x: number, y: number, headingDeg: number, speed: number, path: [number, number, number][] = [], o: Partial<Actor> = {}): this {
    const wps: Waypoint[] = path.map(([px, py, v]) => ({ x: px, y: py, v }));
    this.scene.actors.push({
      id: this.id('a'),
      kind: 'vehicle',
      type,
      x,
      y,
      heading: rad(headingDeg),
      color: VEHICLES[type].color,
      speed,
      delay: 0,
      path: wps,
      flags: { drunk: false, noLicense: false, flees: false },
      ...o,
    });
    return this;
  }

  ped(type: PedestrianType, x: number, y: number, headingDeg: number, path: [number, number, number][], o: Partial<Actor> = {}): this {
    this.scene.actors.push({
      id: this.id('a'),
      kind: 'pedestrian',
      type,
      x,
      y,
      heading: rad(headingDeg),
      color: PEDESTRIANS[type].color,
      speed: path[0]?.[2] ?? 5,
      delay: 0,
      path: path.map(([px, py, v]) => ({ x: px, y: py, v })),
      flags: { drunk: false, noLicense: false, flees: false },
      ...o,
    });
    return this;
  }

  marking(kind: string, pts: [number, number][], o: Partial<Marking> = {}): this {
    this.scene.markings.push({ id: this.id('m'), kind, pts: pts.map(([x, y]) => ({ x, y })), ...o });
    return this;
  }

  duration(s: number): this {
    this.scene.env.duration = s;
    return this;
  }

  surface(s: Scene['env']['surface']): this {
    this.scene.env.surface = s;
    return this;
  }

  done(): Scene {
    return this.scene;
  }
}

/** Прямая дорога вдоль оси X с тротуарами. */
function straight(b: Builder, center: CenterMarking = 'dashed', lanes = 1, len = 120): Builder {
  const half = lanes * 3.5;
  return b
    .road([[-len, 0], [len, 0]], { lanes, center })
    .sidewalk([[-len, -(half + 2.5)], [len, -(half + 2.5)]])
    .sidewalk([[-len, half + 2.5], [len, half + 2.5]]);
}

function cross(b: Builder, len = 110): Builder {
  return b.road([[-len, 0], [len, 0]]).road([[0, -len], [0, len]]);
}

export interface Preset {
  id: string;
  title: string;
  hint: string;
  build: () => Scene;
  /** Наблюдаемое требование в паре учебных примеров раздела 13. */
  intersectionCase?: { rule: string; expected: 'compliant' | 'violation' | 'agreement'; actorIndex: number; evaluatedRequirement: string };
}

/** A stopped waypoint records the actual wait before entry, rather than hiding the participant. */
function waitBeforeEntry(a: Actor, seconds = 8): void {
  const dx = Math.cos(a.heading);
  const dy = Math.sin(a.heading);
  const distance = Math.max(0, Math.hypot(a.x, a.y) - 11);
  a.path.unshift({ x: a.x + dx * distance, y: a.y + dy * distance, v: 0, hold: seconds });
}

function intersectionBase(title: string): Builder {
  const b = cross(new Builder().name(title).duration(22), 85);
  // Fix the legal edition for durable examples; geometry and timing do not depend on today's clock.
  b.scene.env.accidentDate = '2026-10-20T12:00';
  return b;
}

function crossingPair(title: string, yieldIndex: number, compliant: boolean): Builder {
  const b = intersectionBase(title)
    .vehicle('car', -45, 1.75, 0, 30, [[70, 1.75, 30]])
    .vehicle('car', -1.75, -43, 90, 30, [[-1.75, 70, 30]]);
  if (compliant) waitBeforeEntry(b.scene.actors[yieldIndex]);
  return b;
}

function twoGreen(b: Builder): void {
  b.light(-8, 3.5, 0, [60, 0, 0]);
  b.light(-3.5, -8, 90, [60, 0, 0]);
}

function leftAcrossOpposing(title: string, compliant: boolean, regulated: boolean): Scene {
  const b = intersectionBase(title)
    .vehicle('car', -38, 1.75, 0, 25, [[-6, 1.75, 25], [1.75, -6, 25], [1.75, -70, 25]])
    .vehicle('car', 35, -1.75, 180, 25, [[-70, -1.75, 25]]);
  if (regulated) {
    b.light(-8, 3.5, 0, [60, 0, 0]);
    b.light(8, -3.5, 180, [60, 0, 0]);
  }
  if (compliant) waitBeforeEntry(b.scene.actors[0]);
  return b.done();
}

function circleEntry(title: string, compliant: boolean): Scene {
  const b = new Builder().name(title).duration(24);
  b.scene.env.accidentDate = '2026-10-20T12:00';
  // At the west arm the circle travels south: the island remains on the driver's left.
  const ring: [number, number][] = Array.from({ length: 33 }, (_, k) => {
    const a = -Math.PI / 2 - k * Math.PI / 16;
    return [20 * Math.cos(a), 20 * Math.sin(a)];
  });
  b.road(ring, { oneWay: true, center: 'none', role: 'roundabout' })
    .road([[-85, 0], [-20, 0]], { role: 'road' })
    .sign('4.3', -28, 5, 0)
    .vehicle('car', -45, 0, 0, 18, [[-27, 0, 18], [-21, -3, 18], [-20, 0, 18], [-18.48, 7.65, 18], [-14.14, 14.14, 18], [0, 20, 18]])
    .vehicle('car', -7.65, -18.48, 135, 18, [[-14.14, -14.14, 18], [-18.48, -7.65, 18], [-20, 0, 18], [-18.48, 7.65, 18], [-14.14, 14.14, 18], [0, 20, 18], [14.14, 14.14, 18]]);
  if (compliant) b.scene.actors[0].path.unshift({ x: -29, y: 0, v: 0, hold: 9 });
  return b.done();
}

/** Every item is paired with the same road/participants and a recorded wait or a changed control condition. */
const INTERSECTION_CASES: { rule: string; title: string; yieldIndex: number; requirement?: string; build: (compliant: boolean, title: string) => Scene }[] = [
  { rule: '13.1', title: 'Поворот и пешеход на выездной дороге', yieldIndex: 0, build: (ok, title) => {
    const b = intersectionBase(title)
      .vehicle('car', -24, 1.75, 0, 18, [[-3, 1.75, 18], [-1.75, 3, 18], [-1.75, 65, 18]])
      .ped('adult', -6, 9, 0, [[6, 9, 5]], { delay: 1.5 });
    if (ok) waitBeforeEntry(b.scene.actors[0]);
    return b.done();
  } },
  { rule: '13.2', title: 'Затор за перекрёстком и сетка 1.26', yieldIndex: 0, build: (ok, title) => {
    const b = intersectionBase(title)
      .marking('1.26', [[-4, -4], [4, -4], [4, 4], [-4, 4]])
      .vehicle('car', -40, 1.75, 0, 30, [[ok ? -10 : 1.75, 1.75, 0]])
      .vehicle('car', 8, 1.75, 0, 0, [])
      .vehicle('car', 15, 1.75, 0, 0, [])
      .vehicle('car', -1.75, -60, 90, 18, [[-1.75, 65, 18]]);
    twoGreen(b);
    return b.done();
  } },
  { rule: '13.3', title: 'Мигающий жёлтый: действуют знаки приоритета', yieldIndex: 0, requirement: '13.9', build: (ok, title) => {
    const b = crossingPair(title, 0, ok).sign('2.4', -16, 4.5, 0).sign('2.1', -4.5, -16, 90);
    twoGreen(b);
    for (const l of b.scene.lights) l.mode = 'flashing-yellow';
    return b.done();
  } },
  { rule: '13.4', title: 'Поворот налево на зелёный и встречное ТС', yieldIndex: 0, build: (ok, title) => leftAcrossOpposing(title, ok, true) },
  { rule: '13.5', title: 'Дополнительная стрелка с красным сигналом', yieldIndex: 0, build: (ok, title) => {
    const b = crossingPair(title, 0, ok);
    b.light(-8, 3.5, 0, [0, 0, 60]);
    b.scene.lights[0].extraSection = { directions: ['straight'], on: true };
    b.light(-3.5, -8, 90, [60, 0, 0]);
    return b.done();
  } },
  { rule: '13.6', title: 'Трамвай и автомобиль одновременно на зелёный', yieldIndex: 1, build: (ok, title) => {
    const b = crossingPair(title, 1, ok);
    Object.assign(b.scene.actors[0], { type: 'tram', color: VEHICLES.tram.color });
    b.track([[-85, 1.75], [85, 1.75]]);
    twoGreen(b);
    return b.done();
  } },
  { rule: '13.7', title: 'Завершение проезда и отдельная внутренняя стоп-линия', yieldIndex: 0, requirement: '6.2', build: (ok, title) => {
    const b = intersectionBase(title).vehicle('car', -30, 1.75, 0, 18, [[70, 1.75, 18]]);
    b.light(-7, 3.5, 0, [60, 0, 0]);
    b.light(7, 3.5, 0, [0, 0, 60]);
    // 13.7 permits completion past an exit signal without a separate stop line.
    b.scene.lights[1].stopLine = !ok;
    return b.done();
  } },
  { rule: '13.8', title: 'Новый зелёный: пропустить завершающего проезд', yieldIndex: 1, build: (ok, title) => {
    const b = intersectionBase(title)
      .vehicle('car', -20, 1.75, 0, 7.2, [[65, 1.75, 7.2]])
      .vehicle('car', -1.75, -46, 90, 18, [[-1.75, 65, 18]]);
    b.light(-3.5, 3.5, 0, [8, 0, 60]);
    b.light(-3.5, -3.5, 90, [60, 0, 8], 60);
    if (ok) waitBeforeEntry(b.scene.actors[1], 10);
    return b.done();
  } },
  { rule: '13.9', title: 'Главная и второстепенная: уступить главной', yieldIndex: 0, build: (ok, title) => crossingPair(title, 0, ok)
    .sign('2.4', -16, 4.5, 0).sign('2.1', -4.5, -16, 90).done() },
  { rule: '13.10', title: 'Главная меняет направление: два ТС на главной', yieldIndex: 0, build: (ok, title) => {
    const b = intersectionBase(title)
      .sign('2.1', -16, 4.5, 0).sign('2.1', 4.5, 16, -90)
      .vehicle('car', -45, 1.75, 0, 30, [[70, 1.75, 30]])
      .vehicle('car', 1.75, 43, -90, 30, [[1.75, -70, 30]]);
    for (const sign of b.scene.signs) {
      sign.plates = ['8.13'];
      sign.mainDirections = [0, -Math.PI / 2];
    }
    if (ok) waitBeforeEntry(b.scene.actors[0]);
    return b.done();
  } },
  { rule: '13.11', title: 'Равнозначные дороги: помеха справа', yieldIndex: 1, build: (ok, title) => crossingPair(title, 1, ok).done() },
  { rule: '13.11(1)', title: 'Въезд на круг с неглавной дороги', yieldIndex: 0, build: (ok, title) => circleEntry(title, ok) },
  { rule: '13.12', title: 'Поворот налево на равнозначном перекрёстке', yieldIndex: 0, build: (ok, title) => leftAcrossOpposing(title, ok, false) },
  { rule: '13.13', title: 'Покрытие не определить: считать дорогу второстепенной', yieldIndex: 0, build: (ok, title) => {
    const b = crossingPair(title, 0, ok);
    for (const road of b.scene.roads) road.surfacePriority = 'hard';
    b.scene.actors[0].coveringUnknown = true;
    return b.done();
  } },
];

export const INTERSECTION_PRESETS: Preset[] = INTERSECTION_CASES.flatMap(c => [true, false].map(compliant => {
  const title = `ПДД ${c.rule}: ${c.title} — ${compliant ? 'правильно' : 'нарушение'}`;
  return {
    id: `intersection-${c.rule.replace(/[().]/g, '-')}-${compliant ? 'correct' : 'violation'}`,
    title,
    hint: c.rule === '13.3' ? 'Мигающий жёлтый переводит перекрёсток в нерегулируемый режим; очередность определяют знаки.'
      : c.rule === '13.7' ? 'На выходе без отдельной стоп-линии можно завершить начатый проезд; перед внутренней стоп-линией сигнал обязателен.'
      : `Сравните фактическое движение с требованием п. ${c.rule} из корпуса ПДД. В парном примере сохранены остальные условия.`,
    intersectionCase: { rule: `pdd:${c.rule}`, expected: compliant ? 'compliant' as const : 'violation' as const,
      actorIndex: c.yieldIndex, evaluatedRequirement: `pdd:${c.requirement ?? c.rule}` },
    build: () => c.build(compliant, title),
  };
}));

/** Additional control examples keep the signal distinct from priority. */
export const INTERSECTION_CONTROL_PRESETS: Preset[] = [
  ...[true, false].map(ok => ({
    id: `intersection-main-arrow-${ok ? 'correct' : 'violation'}`,
    title: `Основная зелёная стрелка направо — ${ok ? 'правильно' : 'нарушение'}`,
    hint: 'Основной зелёный сигнал со стрелкой разрешает только указанное направление (п. 6.3).',
    intersectionCase: { rule: 'pdd:6.3', expected: ok ? 'compliant' as const : 'violation' as const,
      actorIndex: 0, evaluatedRequirement: 'pdd:6.3' },
    build: () => {
      const b = intersectionBase('Основная стрелка направо')
        .vehicle('car', -30, 1.75, 0, 18, ok
          ? [[-3, 1.75, 18], [-1.75, 3, 18], [-1.75, 65, 18]] : [[65, 1.75, 18]]);
      b.light(-8, 3.5, 0, [60, 0, 0]);
      b.scene.lights[0].mainDirections = ['right'];
      return b.done();
    },
  })),
  ...[true, false].map(ok => ({
    id: `intersection-tram-extra-${ok ? 'correct' : 'violation'}`,
    title: `Трамвай по дополнительной стрелке с красным — ${ok ? 'правильно' : 'нарушение'}`,
    hint: 'Исключение из преимущества трамвая: движение по дополнительной стрелке с красным или жёлтым требует уступить другим направлениям (п. 13.6).',
    intersectionCase: { rule: 'pdd:13.6', expected: ok ? 'compliant' as const : 'violation' as const,
      actorIndex: 0, evaluatedRequirement: 'pdd:13.6' },
    build: () => {
      const b = crossingPair('Трамвай по дополнительной стрелке с красным', 0, ok);
      Object.assign(b.scene.actors[0], { type: 'tram', color: VEHICLES.tram.color });
      b.track([[-85, 1.75], [85, 1.75]]);
      b.light(-8, 3.5, 0, [0, 0, 60]);
      b.scene.lights[0].extraSection = { directions: ['straight'], on: true };
      b.light(-3.5, -8, 90, [60, 0, 0]);
      return b.done();
    },
  })),
  ...[true, false].map(ok => ({
    id: `intersection-controller-${ok ? 'correct' : 'violation'}`,
    title: `Регулировщик важнее зелёного сигнала — ${ok ? 'правильно' : 'нарушение'}`,
    hint: 'При руках в стороны движение со стороны груди и спины запрещено; сигнал регулировщика имеет преимущество перед светофором (п. 6.10, 6.15).',
    intersectionCase: { rule: 'pdd:6.10', expected: ok ? 'compliant' as const : 'violation' as const,
      actorIndex: 0, evaluatedRequirement: 'pdd:6.10' },
    build: () => {
      const b = intersectionBase('Регулировщик важнее зелёного сигнала')
        .vehicle('car', -35, 1.75, 0, 18, ok ? [[-12, 1.75, 0]] : [[65, 1.75, 18]]);
      b.light(-8, 3.5, 0, [60, 0, 0]);
      b.light(0, 0, 0, [60, 0, 0], 0, 8);
      Object.assign(b.scene.lights[1], { kind: 'controller', controllerGesture: 'arms-out' });
      return b.done();
    },
  })),
  {
    id: 'intersection-four-way-cycle',
    title: 'Четыре ТС на равнозначном: договориться об очередности',
    hint: 'У каждого участника помеха справа. Цикл графа уступания не назначает нарушителя; водителям нужно договориться (п. 13.11, 1.5).',
    intersectionCase: { rule: 'pdd:13.11', expected: 'agreement', actorIndex: 0, evaluatedRequirement: 'pdd:13.11' },
    build: () => intersectionBase('Четыре ТС: цикл уступания')
      .vehicle('car', -35, 1.75, 0, 18, [[65, 1.75, 18]])
      .vehicle('car', -1.75, -35, 90, 18, [[-1.75, 65, 18]])
      .vehicle('car', 35, -1.75, 180, 18, [[-65, -1.75, 18]])
      .vehicle('car', 1.75, 35, -90, 18, [[1.75, -65, 18]]).done(),
  },
];

/** Cases from section 8/11. Commands carry explicit simulation times. */
export const MANEUVER_PRESETS: Preset[] = [
  {
    id: 'overtake-left-turn', title: 'Обгон автомобиля, поворачивающего налево',
    hint: 'Впереди идущий автомобиль заранее подал левый сигнал. Сигнал не даёт ему преимущества; безопасность поворота и запрет обгона проверяются отдельно.',
    build: () => {
      const b = straight(new Builder().name('Обгон поворачивающего налево').duration(12), 'dashed', 1, 100)
        .vehicle('car', -20, 1.75, 0, 18, [[-8, 1.75, 18], [-1.75, -6, 18], [-1.75, -40, 18]])
        .vehicle('car', -45, 1.75, 0, 50, [[-28, -1.75, 50], [-5, -1.75, 50], [30, 1.75, 50]]);
      b.scene.env.accidentDate = '2026-10-21T12:00';
      for (const point of b.scene.actors[0].path) { point.signal = 'left'; point.signalAt = 0; }
      Object.assign(b.scene.actors[0].path.at(-1)!, { signal: 'none', signalAt: 4.6 });
      b.scene.actors[1].maneuverContext = { expectedStraight: false, oncomingClear: true, overtakeReturnClear: true };
      return b.done();
    },
  },
  {
    id: 'uturn-from-right-lane', title: 'Разворот с правой полосы',
    hint: 'Две полосы в каждом направлении. Крайнее положение и исключения для габаритов оцениваются отдельно от поданного сигнала.',
    build: () => {
      const b = straight(new Builder().name('Разворот из правой полосы').duration(18), 'dashed', 2, 100)
        .vehicle('car', -40, 5.25, 0, 18, [[-10, 5.25, 18], [-2, 0, 18], [-12, -5.25, 18], [-60, -5.25, 18]]);
      b.scene.env.accidentDate = '2026-10-21T12:00';
      for (const point of b.scene.actors[0].path) { point.signal = 'left'; point.signalAt = 0; }
      b.scene.actors[0].maneuverContext = { cannotKeepExtreme: false, longVehicleException: false };
      return b.done();
    },
  },
  {
    id: 'reverse-from-parking', title: 'Выезд задним ходом с парковки',
    hint: 'Отрицательная скорость задаёт задний ход; кузов направлен противоположно движению. Проверяются безопасность манёвра и обязанность уступить при выезде.',
    build: () => {
      const b = straight(new Builder().name('Задний ход с парковки').duration(12), 'dashed', 1, 90)
        .vehicle('car', 0, 9, 90, -8, [[0, 1.75, -8], [0, -8, -8]])
        .vehicle('car', -25, 1.75, 0, 30, [[70, 1.75, 30]]);
      b.scene.env.accidentDate = '2026-10-21T12:00';
      return b.done();
    },
  },
  {
    id: 'lane-change-no-signal', title: 'Перестроение без указателя поворота',
    hint: 'Водитель смещается из правой полосы в левую. Другой участник ожидал прямолинейного движения; это исходное условие примера, а не следствие отсутствия сигнала.',
    build: () => {
      const b = straight(new Builder().name('Перестроение без сигнала').duration(12), 'dashed', 2, 100)
        .vehicle('car', -40, 5.25, 0, 36, [[-20, 5.25, 36], [5, 1.75, 36], [65, 1.75, 36]])
        .vehicle('car', -45, 1.75, 0, 40, [[75, 1.75, 40]]);
      b.scene.env.accidentDate = '2026-10-21T12:00';
      b.scene.actors[1].maneuverContext = { expectedStraight: true };
      return b.done();
    },
  },
];

/** Same road situations with an observed precaution instead of hiding an actor. */
export const MANEUVER_COMPLIANT_PRESETS: Preset[] = [
  {
    id: 'overtake-left-turn-yield', title: 'Отказ от обгона перед левым поворотом',
    hint: 'Задний автомобиль останавливается в своей полосе, ожидает поворота лидера и продолжает движение без выезда на встречную.',
    build: () => {
      const scene = MANEUVER_PRESETS.find(p => p.id === 'overtake-left-turn')!.build();
      scene.name = 'Ожидание поворачивающего налево';
      scene.env.duration = 18;
      scene.actors[1].path = [{ x: -30, y: 1.75, v: 0, hold: 5 }, { x: 60, y: 1.75, v: 30 }];
      return scene;
    },
  },
  {
    id: 'uturn-from-left-lane', title: 'Разворот из крайнего левого положения',
    hint: 'Та же дорога с двумя полосами. До разворота автомобиль занимает левую полосу своего направления и подаёт сигнал заранее.',
    build: () => {
      const scene = MANEUVER_PRESETS.find(p => p.id === 'uturn-from-right-lane')!.build();
      scene.name = 'Разворот из левой полосы';
      const actor = scene.actors[0];
      actor.y = 1.75;
      actor.path = [{ x: -10, y: 1.75, v: 18, signal: 'left', signalAt: 0 },
        { x: -2, y: 0, v: 18, signal: 'left', signalAt: 0 },
        { x: -12, y: -1.75, v: 18, signal: 'left', signalAt: 0 },
        { x: -60, y: -1.75, v: 18, signal: 'none', signalAt: 10 }];
      return scene;
    },
  },
  {
    id: 'reverse-from-parking-yield', title: 'Задний ход с парковки после уступки',
    hint: 'Водитель останавливается перед краем проезжей части, пропускает автомобиль и продолжает задний ход. Участники остаются в сцене всё время.',
    build: () => {
      const scene = MANEUVER_PRESETS.find(p => p.id === 'reverse-from-parking')!.build();
      scene.name = 'Безопасный задний ход после уступки';
      scene.env.duration = 18;
      scene.actors[0].path.unshift({ x: 0, y: 7, v: 0, hold: 5 });
      return scene;
    },
  },
  {
    id: 'lane-change-signal-yield', title: 'Перестроение с сигналом после пропуска ТС',
    hint: 'Автомобиль едет медленнее, заранее включает левый сигнал и перестраивается после прохождения попутного ТС. Сам сигнал преимущества не создаёт.',
    build: () => {
      const scene = MANEUVER_PRESETS.find(p => p.id === 'lane-change-no-signal')!.build();
      scene.name = 'Заблаговременный сигнал перед перестроением';
      scene.env.duration = 18;
      const actor = scene.actors[0];
      actor.speed = 18;
      actor.path = actor.path.map((point, index) => ({ ...point, v: 18, signal: index === actor.path.length - 1 ? 'none' as const : 'left' as const, signalAt: index === actor.path.length - 1 ? 9.5 : 0 }));
      scene.actors[1].maneuverContext = { ...scene.actors[1].maneuverContext, expectedStraight: false };
      return scene;
    },
  },
];

export const PRESETS: Preset[] = [
  {
    id: 'crosswalk',
    title: 'Пешеход на нерегулируемом переходе',
    hint: 'Водитель не снижает скорость перед «зеброй». Что скажет п. 14.1 ПДД и ст. 12.18 КоАП?',
    build: () =>
      straight(new Builder().name('Пешеход на нерегулируемом переходе').duration(10), 'dashed')
        .crosswalk(0, 0, 90)
        .sign('5.19.1', -8, 5.2, 0)
        .vehicle('car', -50, 1.75, 0, 50, [[60, 1.75, 50]])
        .ped('adult', 0.5, -4.2, 90, [[0.5, 6, 5]])
        .done(),
  },
  {
    id: 'ped-run',
    title: 'Пешеход выбежал вне перехода',
    hint: 'Пешеход выскакивает на дорогу перед самым автомобилем. Мог ли водитель успеть остановиться?',
    build: () =>
      straight(new Builder().name('Пешеход выбежал на дорогу').duration(8), 'dashed')
        .crosswalk(70, 0, 90)
        .vehicle('car', -28, 1.75, 0, 50, [[60, 1.75, 50]])
        .ped('adult', 0.5, -4.0, 90, [[0.5, 6, 10]])
        .done(),
  },
  {
    id: 'ped-red',
    title: 'Пешеход на красный сигнал',
    hint: 'Автомобиль едет на зелёный, пешеход выходит на переход при красном для него.',
    build: () => {
      const b = straight(new Builder().name('Пешеход на красный сигнал').duration(8), 'dashed');
      const lid = b.light(-12, 3.5, 0, [60, 2, 20]);
      return b
        .crosswalk(0, 0, 90, { lightId: lid })
        .vehicle('car', -29, 1.75, 0, 45, [[60, 1.75, 45]])
        .ped('adult', 0.5, -4.0, 90, [[0.5, 6, 9]], { delay: 0.2 })
        .done();
    },
  },
  {
    id: 'red-light',
    title: 'Проезд на красный (перекрёсток со светофорами)',
    hint: 'Один водитель не остановился на красный, другой поехал на зелёный. Какие нарушения находятся в причинной связи с ДТП?',
    build: () => {
      const b = cross(new Builder().name('Проезд на красный сигнал').duration(12));
      b.light(-6, 3.5, 0, [4, 2, 8], 0);
      b.light(-3.5, -6, 90, [4, 2, 8], 8);
      return b
        .vehicle('car', -112, 1.75, 0, 50, [[110, 1.75, 50]])
        .vehicle('suv', -1.75, -86, 90, 40, [[-1.75, 110, 40]])
        .done();
    },
  },
  {
    id: 'right-hand',
    title: 'Равнозначный перекрёсток: помеха справа',
    hint: 'Нет ни знаков, ни светофоров. Кто должен уступить?',
    build: () =>
      cross(new Builder().name('Помеха справа на равнозначном перекрёстке').duration(10))
        .vehicle('car', -57, 1.75, 0, 40, [[110, 1.75, 40]])
        .vehicle('van', -1.75, -54, 90, 40, [[-1.75, 110, 40]])
        .done(),
  },
  {
    id: 'giveway',
    title: 'Главная и второстепенная дорога',
    hint: 'Знак «Уступите дорогу» на одной дороге и «Главная дорога» — на другой.',
    build: () =>
      cross(new Builder().name('Главная и второстепенная дорога').duration(10))
        .sign('2.4', -14, 5.0, 0)
        .sign('2.1', -4.6, -14, 90)
        .vehicle('car', -57, 1.75, 0, 45, [[110, 1.75, 45]])
        .vehicle('truck', -1.75, -53, 90, 45, [[-1.75, 110, 45]])
        .done(),
  },
  {
    id: 'head-on',
    title: 'Выезд на встречную через сплошную (водитель пьян)',
    hint: 'Двойная сплошная разметка, лобовое столкновение. Обратите внимание на квалификацию по УК РФ.',
    build: () =>
      straight(new Builder().name('Выезд на встречную полосу').duration(8), 'double')
        .vehicle('car', -100, 1.75, 0, 60, [[-45, 1.75, 60], [-12, -1.75, 60], [110, -1.75, 60]], { flags: { drunk: true, noLicense: false, flees: false } })
        .vehicle('suv', 100, -1.75, 180, 60, [[-110, -1.75, 60]])
        .done(),
  },
  {
    id: 'rear-end',
    title: 'Наезд сзади на светофоре',
    hint: 'Передний автомобиль остановился на красный, задний не выдержал дистанцию.',
    build: () => {
      const b = straight(new Builder().name('Наезд сзади').duration(10), 'dashed');
      b.light(48, 3.5, 0, [1, 1, 80], 2);
      return b
        .vehicle('car', 0, 1.75, 0, 36, [[43, 1.75, 0]])
        .vehicle('suv', -34, 1.75, 0, 58, [[100, 1.75, 58]])
        .done();
    },
  },
  {
    id: 'ice',
    title: 'Гололёд: скорость не соответствует условиям',
    hint: 'Водитель собирается затормозить перед стоящей колонной, но покрытие не даёт остановиться.',
    build: () =>
      straight(new Builder().name('Гололёд').duration(14).surface('ice'), 'dashed')
        .vehicle('car', 70, 1.75, 0, 0, [], { delay: 0 })
        .vehicle('truck', 55, 1.75, 0, 0, [])
        .vehicle('suv', -60, 1.75, 0, 50, [[48, 1.75, 0]])
        .done(),
  },
  {
    id: 'tram',
    title: 'Трамвай на перекрёстке',
    hint: 'Трамвай идёт по рельсам через равнозначный перекрёсток, легковой автомобиль не уступает.',
    build: () =>
      new Builder()
        .name('Трамвай и легковой автомобиль')
        .duration(12)
        .road([[-110, 0], [110, 0]], { oneWay: true, lanes: 2, center: 'none' })
        .road([[0, -110], [0, 110]])
        .track([[-110, 1.75], [110, 1.75]])
        .vehicle('tram', -54, 1.75, 0, 36, [[110, 1.75, 36]])
        .vehicle('car', -1.75, -49, 90, 40, [[-1.75, 110, 40]])
        .done(),
  },
  {
    id: 'speeding',
    title: 'Превышение скорости в жилой зоне',
    hint: 'Автомобиль проносится по жилой зоне на скорости 70 км/ч, ребёнок выходит на проезжую часть.',
    build: () => {
      const b = straight(new Builder().name('Жилая зона, ребёнок на дороге').duration(8), 'none');
      b.scene.roads.forEach((r) => (r.zone = 'residential'));
      return b
        .vehicle('car', -40, 1.75, 0, 70, [[80, 1.75, 70]])
        .ped('child', 0.5, -1.8, 90, [[0.5, 6, 5]])
        .done();
    },
  },
  {
    id: 'overhang',
    title: 'Необозначенный груз, выступающий сзади',
    hint: 'Грузовик везёт длинные трубы со свесом 3 м без знаков «Крупногабаритный груз»; идущий сзади автомобиль врезается в свес.',
    build: () => {
      const b = straight(new Builder().name('Свес груза без обозначения').duration(9), 'dashed');
      b.vehicle('truck', 0, 1.75, 0, 30, [[130, 1.75, 30]], { cargo: { mass: 3000, front: 0, rear: 3, left: 0, right: 0, height: 3.2, marked: false, secured: true, blocksView: false, dangerous: false } });
      b.vehicle('car', -60, 1.75, 0, 60, [[130, 1.75, 60]]);
      return b.done();
    },
  },
  {
    id: 'no-right-turn',
    title: 'Поворот направо под знак 3.18.1',
    hint: 'Знак запрещает поворот направо, но водитель всё равно сворачивает и сталкивается со встречным автомобилем.',
    build: () => {
      const b = cross(new Builder().name('Запрещённый поворот').duration(10));
      b.sign('3.18.1', -30, 5.5, 0);
      b.vehicle('car', -60, 1.75, 0, 25, [[-40, 1.75, 25], [-20, 1.75, 25], [-8, 1.75, 15], [-1.75, 8, 15], [-1.75, 80, 25]]);
      b.vehicle('car', -1.75, 75, -90, 30, [[-1.75, -80, 30]]);
      return b.done();
    },
  },
  {
    id: 'ramp-merge',
    title: 'Съезд на трассу: перестроение на полосе разгона',
    hint: 'Двухполосный съезд сужается в одну полосу разгона и вливается в трёхполосную трассу. ТС 2 перестраивается из левой полосы в правую (сигнал поворота не задан), ТС 3 догоняет по правой полосе и бьёт его, когда тот ещё частично на левой. На островке стоит машина ДПС (ТС 1).',
    build: () => {
      const b = new Builder().name('Съезд на трассу, перестроение на разгоне').duration(14);
      // трасса: три полосы в одну сторону (на восток), справа — съезд
      b.road([[-260, 0], [260, 0]], { lanes: 3, oneWay: true, center: 'dashed', zone: 'outside' });
      // съезд: две полосы, обе кромки сходятся в одну полосу разгона вдоль трассы
      b.road([[-260, 120], [-210, 40], [-170, 11.75], [-45, 11.75], [20, 7], [150, 7]], {
        lanes: 2,
        oneWay: true,
        center: 'dashed',
        radius: 25,
        zone: 'outside',
        wl: [{ s: 0, w: 3.5 }, { s: 262, w: 3.5 }, { s: 328, w: 1.75 }, { s: 500, w: 1.75 }],
        wr: [{ s: 0, w: 3.5 }, { s: 262, w: 3.5 }, { s: 328, w: 1.75 }, { s: 500, w: 1.75 }],
      });
      // островок безопасности между трассой и съездом, на нём машина ДПС
      b.marking('1.16.1', [[-130, 5.25], [-50, 5.25], [-50, 8.1], [-130, 8.1]]);
      b.vehicle('car', -90, 6.7, 0, 0, [], { color: '#2f6fd6' });
      // машина 1 идёт по левой полосе съезда и перестраивается вправо
      b.vehicle('car', -118, 10, 0, 58, [[-98, 10, 58], [-72, 13.5, 58], [-45, 13.5, 58], [20, 8, 58]]);
      // машина 2 едет по правой полосе чуть быстрее
      b.vehicle('suv', -128, 13.5, 0, 76, [[-45, 13.5, 74], [20, 8, 74]]);
      return b.done();
    },
  },
  ...INTERSECTION_PRESETS,
  ...INTERSECTION_CONTROL_PRESETS,
  ...MANEUVER_PRESETS,
  ...MANEUVER_COMPLIANT_PRESETS,
];

export function blankScene(): Scene {
  return emptyScene();
}
