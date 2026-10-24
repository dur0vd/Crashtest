import type { Vec } from './geom';
import { LEGACY_SIGN_KIND } from './signs';

// ---------------------------------------------------------------------------
// Каталог участников движения

export type VehicleType =
  | 'bicycle'
  | 'moped'
  | 'motorcycle'
  | 'car'
  | 'suv'
  | 'van'
  | 'truck'
  | 'bus'
  | 'trolleybus'
  | 'tram'
  | 'cart';

export type PedestrianType = 'adult' | 'child';

export interface VehicleSpec {
  name: string;
  length: number;
  width: number;
  /** масса, кг (с водителем) */
  mass: number;
  /** максимальное ускорение, м/с² */
  accel: number;
  /** доля от μ·g, доступная при торможении */
  brakeFactor: number;
  /** абсолютный предел замедления, м/с² (для рельсового транспорта) */
  brakeCap?: number;
  /** ориентировочная максимальная скорость, км/ч */
  vmax: number;
  color: string;
  /** участник без кузова, защищающего от удара */
  exposed: boolean;
  /** рельсовое ТС */
  rail: boolean;
  /** маршрутное ТС */
  route: boolean;
  /** грузовой автомобиль с разрешённой массой более 3,5 т */
  heavy: boolean;
  /** высота от поверхности дороги, м */
  height: number;
  /** разрешённая максимальная масса без груза, кг (для знаков 3.11 и сравнения с перевозимым грузом) */
  payload: number;
}

export const VEHICLES: Record<VehicleType, VehicleSpec> = {
  bicycle: { name: 'Велосипед', length: 1.8, width: 0.6, mass: 95, accel: 1.0, brakeFactor: 0.6, vmax: 35, color: '#2fb36b', exposed: true, rail: false, route: false, heavy: false, height: 1.8, payload: 0 },
  moped: { name: 'Мопед', length: 1.8, width: 0.7, mass: 150, accel: 1.4, brakeFactor: 0.8, vmax: 50, color: '#f5a524', exposed: true, rail: false, route: false, heavy: false, height: 1.7, payload: 0 },
  motorcycle: { name: 'Мотоцикл', length: 2.2, width: 0.8, mass: 280, accel: 4.0, brakeFactor: 0.9, vmax: 200, color: '#ff6b3d', exposed: true, rail: false, route: false, heavy: false, height: 1.5, payload: 0 },
  car: { name: 'Легковой автомобиль', length: 4.5, width: 1.8, mass: 1400, accel: 2.5, brakeFactor: 1.0, vmax: 200, color: '#3e9bff', exposed: false, rail: false, route: false, heavy: false, height: 1.5, payload: 450 },
  suv: { name: 'Внедорожник', length: 4.8, width: 1.95, mass: 2100, accel: 2.2, brakeFactor: 0.95, vmax: 180, color: '#8b6fe8', exposed: false, rail: false, route: false, heavy: false, height: 1.8, payload: 600 },
  van: { name: 'Микроавтобус / фургон', length: 5.6, width: 2.0, mass: 2800, accel: 1.6, brakeFactor: 0.9, vmax: 130, color: '#e8e4d8', exposed: false, rail: false, route: false, heavy: false, height: 2.5, payload: 1200 },
  truck: { name: 'Грузовик', length: 8.5, width: 2.5, mass: 14000, accel: 0.9, brakeFactor: 0.75, vmax: 90, color: '#c9a227', exposed: false, rail: false, route: false, heavy: true, height: 3.5, payload: 8000 },
  bus: { name: 'Автобус', length: 12, width: 2.55, mass: 13000, accel: 0.9, brakeFactor: 0.7, vmax: 100, color: '#e5484d', exposed: false, rail: false, route: true, heavy: true, height: 3.0, payload: 0 },
  trolleybus: { name: 'Троллейбус', length: 12, width: 2.55, mass: 14000, accel: 1.1, brakeFactor: 0.7, vmax: 70, color: '#35b6c4', exposed: false, rail: false, route: true, heavy: true, height: 3.4, payload: 0 },
  tram: { name: 'Трамвай', length: 15, width: 2.5, mass: 24000, accel: 1.0, brakeFactor: 1, brakeCap: 2.7, vmax: 70, color: '#d94f8c', exposed: false, rail: true, route: true, heavy: true, height: 3.4, payload: 0 },
  cart: { name: 'Гужевая повозка', length: 3.6, width: 1.5, mass: 800, accel: 0.6, brakeFactor: 0.5, vmax: 15, color: '#9a7b4f', exposed: true, rail: false, route: false, heavy: false, height: 2.2, payload: 600 },
};

export interface PedestrianSpec {
  name: string;
  size: number;
  mass: number;
  /** скорость по умолчанию, км/ч */
  speed: number;
  color: string;
}

export const PEDESTRIANS: Record<PedestrianType, PedestrianSpec> = {
  adult: { name: 'Пешеход', size: 0.5, mass: 75, speed: 5, color: '#ffd166' },
  child: { name: 'Ребёнок', size: 0.4, mass: 30, speed: 5, color: '#ff8fab' },
};

export const SURFACES = {
  dry: { name: 'Сухой асфальт', mu: 0.7 },
  wet: { name: 'Мокрый асфальт', mu: 0.4 },
  snow: { name: 'Снежный накат', mu: 0.2 },
  ice: { name: 'Гололёд', mu: 0.1 },
} as const;
export type SurfaceType = keyof typeof SURFACES;

export const LANE_WIDTH = 3.5;
export const GAUGE = 1.52;

// ---------------------------------------------------------------------------
// Объекты сцены

export type CenterMarking = 'none' | 'dashed' | 'solid' | 'double';
export type RoadZone = 'city' | 'outside' | 'residential';

/** Точка профиля кромки: на расстоянии s от начала оси дорога от оси до края имеет ширину w. */
export interface EdgePt {
  s: number;
  w: number;
}

export interface Road {
  id: string;
  pts: Vec[];
  /** радиус скругления поворотов оси, м (0 — без скругления) */
  radius?: number;
  /** профиль левой и правой кромок; если не задан — ширина постоянна */
  wl?: EdgePt[];
  wr?: EdgePt[];
  /** полос в каждом направлении (для односторонней — всего полос) */
  lanes: number;
  center: CenterMarking;
  oneWay: boolean;
  zone: RoadZone;
  smooth: boolean;
}

export interface Sidewalk {
  id: string;
  pts: Vec[];
  radius?: number;
  width: number;
  smooth: boolean;
}

export interface TramTrack {
  id: string;
  pts: Vec[];
  radius?: number;
  /** путь выделен бордюром или разделительной полосой */
  separated: boolean;
  smooth: boolean;
}

export interface Crosswalk {
  id: string;
  x: number;
  y: number;
  /** направление ходьбы поперёк проезжей части */
  angle: number;
  length: number;
  width: number;
  /** светофор, по которому работает пешеходный сигнал */
  lightId?: string;
}

export interface TrafficLight {
  id: string;
  x: number;
  y: number;
  /** направление движения ТС, для которых работает сигнал */
  angle: number;
  /** длина стоп-линии */
  lineLength: number;
  green: number;
  yellow: number;
  red: number;
  /** сдвиг цикла, с */
  offset: number;
}

/** Номер знака по приложению 1 к ПДД: «2.1», «3.24», «5.19.1». */
export type SignKind = string;

export interface Sign {
  id: string;
  x: number;
  y: number;
  /** направление движения, которому адресован знак */
  angle: number;
  kind: SignKind;
  /** число на знаке: км/ч, т, м (см. VALUE_SIGNS) */
  value?: number;
  /** таблички под знаком (номера по приложению 1: «8.2.1», «8.4.1»…) */
  plates?: string[];
  /** длина зоны действия по табличке 8.2.1, м */
  zoneLen?: number;
}

/** Элемент горизонтальной разметки по приложению 2 к ПДД. */
export interface Marking {
  id: string;
  /** номер разметки: «1.1», «1.5», «1.18»… */
  kind: string;
  /** линия или площадка — точки по контуру; значок — одна точка */
  pts: Vec[];
  /** направление значка, рад */
  angle?: number;
  /** вариант (для стрел 1.18) */
  variant?: string;
  /** для 1.11: сплошная линия справа по ходу рисования (иначе слева) */
  solidRight?: boolean;
  radius?: number;
  smooth?: boolean;
}

export type ObstacleKind = 'building' | 'fence' | 'tree' | 'barrier';

export interface Obstacle {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  kind: ObstacleKind;
}

export interface Waypoint {
  x: number;
  y: number;
  /** скорость в этой точке, км/ч */
  v: number;
  /** сколько секунд стоять, если скорость в точке нулевая */
  hold?: number;
}

export interface DriverFlags {
  drunk: boolean;
  noLicense: boolean;
  flees: boolean;
}

/** Груз по разделу 23 ПДД и ст. 12.21 КоАП. Свесы считаются от габаритов ТС, в метрах. */
export interface Cargo {
  /** масса груза, кг */
  mass: number;
  /** выступ спереди и сзади за габариты ТС */
  front: number;
  rear: number;
  /** выступ сбоку от габаритного огня (слева и справа) */
  left: number;
  right: number;
  /** высота ТС с грузом от поверхности дороги, м */
  height: number;
  /** нанесены опознавательные знаки «Крупногабаритный груз» (п. 23.4) */
  marked: boolean;
  /** груз закреплён надлежащим образом (п. 23.2) */
  secured: boolean;
  /** груз закрывает обзор водителю, световые приборы или номер (п. 23.3) */
  blocksView: boolean;
  /** опасный груз */
  dangerous: boolean;
}

export const NO_CARGO: Cargo = { mass: 0, front: 0, rear: 0, left: 0, right: 0, height: 0, marked: false, secured: true, blocksView: false, dangerous: false };

export interface Actor {
  id: string;
  kind: 'vehicle' | 'pedestrian';
  type: VehicleType | PedestrianType;
  x: number;
  y: number;
  heading: number;
  color: string;
  /** скорость в начальной точке, км/ч */
  speed: number;
  /** появление на сцене, с */
  delay: number;
  path: Waypoint[];
  flags: DriverFlags;
  /** груз (только для ТС) */
  cargo?: Cargo;
  /** трамвай: при сильном ударе возможен сход с путей (иначе едет строго по рельсам) */
  derail?: boolean;
}

export interface Env {
  surface: SurfaceType;
  duration: number;
}

export interface Scene {
  version: 1;
  name: string;
  env: Env;
  roads: Road[];
  sidewalks: Sidewalk[];
  tracks: TramTrack[];
  crosswalks: Crosswalk[];
  lights: TrafficLight[];
  signs: Sign[];
  markings: Marking[];
  obstacles: Obstacle[];
  actors: Actor[];
}

export function emptyScene(): Scene {
  return {
    version: 1,
    name: 'Новая ситуация',
    env: { surface: 'dry', duration: 20 },
    roads: [],
    sidewalks: [],
    tracks: [],
    crosswalks: [],
    lights: [],
    signs: [],
    markings: [],
    obstacles: [],
    actors: [],
  };
}

export type AnyItem = Road | Sidewalk | TramTrack | Crosswalk | TrafficLight | Sign | Marking | Obstacle | Actor;
export type Collection = 'roads' | 'sidewalks' | 'tracks' | 'crosswalks' | 'lights' | 'signs' | 'markings' | 'obstacles' | 'actors';

export const COLLECTIONS: Collection[] = ['roads', 'sidewalks', 'tracks', 'crosswalks', 'lights', 'signs', 'markings', 'obstacles', 'actors'];

const PREFIX: Record<Collection, string> = {
  roads: 'r',
  sidewalks: 's',
  tracks: 't',
  crosswalks: 'c',
  lights: 'l',
  signs: 'g',
  markings: 'm',
  obstacles: 'o',
  actors: 'a',
};

export function newId(scene: Scene, col: Collection): string {
  let max = 0;
  for (const it of scene[col] as { id: string }[]) {
    const n = parseInt(it.id.slice(1), 10);
    if (n > max) max = n;
  }
  return `${PREFIX[col]}${max + 1}`;
}

export function roadWidth(r: Road): number {
  return r.lanes * LANE_WIDTH * (r.oneWay ? 1 : 2);
}

export type LightPhase = 'green' | 'yellow' | 'red';

export function lightPhase(l: TrafficLight, t: number): LightPhase {
  const cycle = l.green + l.yellow + l.red;
  if (cycle <= 0) return 'green';
  const x = (((t + l.offset) % cycle) + cycle) % cycle;
  if (x < l.green) return 'green';
  if (x < l.green + l.yellow) return 'yellow';
  return 'red';
}

/** Сигнал пешеходного светофора: зелёный, пока у ТС красный. */
export function pedestrianGreen(scene: Scene, c: Crosswalk, t: number): boolean | null {
  if (!c.lightId) return null;
  const l = scene.lights.find((x) => x.id === c.lightId);
  if (!l) return null;
  return lightPhase(l, t) === 'red';
}

export function actorSpec(a: Actor): { length: number; width: number; mass: number } {
  if (a.kind === 'pedestrian') {
    const s = PEDESTRIANS[a.type as PedestrianType];
    return { length: s.size, width: s.size, mass: s.mass };
  }
  const s = VEHICLES[a.type as VehicleType];
  return { length: s.length, width: s.width, mass: s.mass };
}

/** Подписи участников: «ТС 1», «Пешеход 2». */
export function actorLabels(scene: Scene): Map<string, string> {
  const m = new Map<string, string>();
  let v = 0;
  let p = 0;
  for (const a of scene.actors) {
    if (a.kind === 'vehicle') m.set(a.id, `ТС ${++v}`);
    else m.set(a.id, `Пешеход ${++p}`);
  }
  return m;
}

export function actorTitle(a: Actor, labels: Map<string, string>): string {
  const name = a.kind === 'vehicle' ? VEHICLES[a.type as VehicleType].name : PEDESTRIANS[a.type as PedestrianType].name;
  return `${labels.get(a.id) ?? a.id} (${name.toLowerCase()})`;
}

export function cloneScene<T>(s: T): T {
  return JSON.parse(JSON.stringify(s)) as T;
}

/** Достраивает отсутствующие поля при загрузке сохранённой сцены. */
export function normalizeScene(raw: unknown): Scene {
  const base = emptyScene();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Неверный формат файла');
  const r = raw as Partial<Scene>;
  const scene: Scene = {
    ...base,
    name: typeof r.name === 'string' ? r.name : base.name,
    env: { ...base.env, ...(r.env ?? {}) },
    roads: [],
    sidewalks: [],
    tracks: [],
    crosswalks: [],
    lights: [],
    signs: [],
    markings: [],
    obstacles: [],
    actors: [],
  };
  for (const c of COLLECTIONS) {
    const arr = (r as Record<string, unknown>)[c];
    if (Array.isArray(arr)) (scene[c] as unknown[]) = structuredClone(arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string'));
  }
  const point = (p: unknown): p is Vec => !!p && typeof p === 'object' && Number.isFinite((p as Vec).x) && Number.isFinite((p as Vec).y);
  const number = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  scene.env.surface = SURFACES[scene.env.surface] ? scene.env.surface : base.env.surface;
  scene.env.duration = Math.max(0.1, Math.min(3600, number(scene.env.duration, base.env.duration)));
  for (const col of ['roads', 'sidewalks', 'tracks', 'markings'] as const) {
    (scene[col] as unknown[]) = scene[col].filter(item => Array.isArray(item.pts) && item.pts.every(point) && item.pts.length >= (col === 'markings' ? 1 : 2));
  }
  for (const col of ['crosswalks', 'lights', 'signs', 'obstacles', 'actors'] as const) {
    (scene[col] as unknown[]) = scene[col].filter(point);
  }
  scene.signs = scene.signs.filter(g => typeof g.kind === 'string');
  scene.actors = scene.actors.filter(a => a.kind === 'vehicle' ? Object.hasOwn(VEHICLES, a.type) : a.kind === 'pedestrian' && Object.hasOwn(PEDESTRIANS, a.type));
  for (const road of scene.roads) {
    road.lanes = Math.max(1, Math.min(10, Math.round(number(road.lanes, 1))));
    road.center = road.center ?? 'dashed';
    road.oneWay = !!road.oneWay;
    road.zone = road.zone ?? 'city';
    road.smooth = !!road.smooth;
    road.radius = Number.isFinite(road.radius) ? Math.max(0, road.radius as number) : 0;
    for (const k of ['wl', 'wr'] as const) {
      const prof = road[k];
      if (!Array.isArray(prof)) delete road[k];
      else road[k] = prof.filter((e) => e && Number.isFinite(e.s) && Number.isFinite(e.w)).sort((a, b) => a.s - b.s);
    }
  }
  for (const g of scene.signs) {
    g.kind = LEGACY_SIGN_KIND[g.kind] ?? g.kind;
    if (!Array.isArray(g.plates)) delete g.plates;
  }
  scene.markings = scene.markings.filter((m) => m && Array.isArray(m.pts) && m.pts.length >= 1 && typeof m.kind === 'string');
  for (const a of scene.actors) {
    a.path = Array.isArray(a.path) ? a.path.filter(point).map(p => ({ ...p, v: Math.max(0, number((p as Waypoint).v, 0)), hold: Math.max(0, number((p as Waypoint).hold, 0)) })) : [];
    a.flags = { drunk: a.flags?.drunk === true, noLicense: a.flags?.noLicense === true, flees: a.flags?.flees === true };
    a.delay = Math.max(0, number(a.delay, 0));
    a.speed = Math.max(0, number(a.speed, 0));
    a.heading = number(a.heading, 0);
    a.color = typeof a.color === 'string' ? a.color : '#3e9bff';
    if (a.cargo) {
      a.cargo = { ...NO_CARGO, ...a.cargo };
      for (const key of ['mass', 'front', 'rear', 'left', 'right', 'height'] as const) a.cargo[key] = Math.max(0, number(a.cargo[key], 0));
    }
  }
  return scene;
}

/** Габариты участника с учётом свесов груза: длина, ширина, высота, масса и смещение центра кузова вдоль курса. */
export function dimsOf(a: Actor): { length: number; width: number; height: number; mass: number; shift: number } {
  const sp = actorSpec(a);
  if (a.kind !== 'vehicle') return { length: sp.length, width: sp.width, height: 1.7, mass: sp.mass, shift: 0 };
  const vs = VEHICLES[a.type as VehicleType];
  const c = a.cargo;
  if (!c) return { length: sp.length, width: sp.width, height: vs.height, mass: sp.mass, shift: 0 };
  return {
    length: sp.length + c.front + c.rear,
    width: sp.width + c.left + c.right,
    height: Math.max(vs.height, c.height),
    mass: sp.mass + c.mass,
    shift: (c.front - c.rear) / 2,
  };
}
