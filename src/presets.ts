import { rad } from './geom';
import {
  type Actor,
  type CenterMarking,
  type Crosswalk,
  type Obstacle,
  type PedestrianType,
  type Road,
  type Scene,
  type Sign,
  type SignKind,
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

  sign(kind: SignKind, x: number, y: number, angleDeg: number, value?: number): this {
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
}

export const PRESETS: Preset[] = [
  {
    id: 'crosswalk',
    title: 'Пешеход на нерегулируемом переходе',
    hint: 'Водитель не снижает скорость перед «зеброй». Что скажет п. 14.1 ПДД и ст. 12.18 КоАП?',
    build: () =>
      straight(new Builder().name('Пешеход на нерегулируемом переходе').duration(10), 'dashed')
        .crosswalk(0, 0, 90)
        .sign('crosswalk', -8, 5.2, 0)
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
    hint: 'Один водитель не остановился на красный, другой поехал на зелёный. Кто виноват?',
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
        .sign('giveway', -14, 5.0, 0)
        .sign('main', -5.5, -14, 90)
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
];

export function blankScene(): Scene {
  return emptyScene();
}
