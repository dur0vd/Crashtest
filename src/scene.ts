import type { Vec } from './geom';

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
}

export const VEHICLES: Record<VehicleType, VehicleSpec> = {
  bicycle: { name: 'Велосипед', length: 1.8, width: 0.6, mass: 95, accel: 1.0, brakeFactor: 0.6, vmax: 35, color: '#2fb36b', exposed: true, rail: false, route: false, heavy: false },
  moped: { name: 'Мопед', length: 1.8, width: 0.7, mass: 150, accel: 1.4, brakeFactor: 0.8, vmax: 50, color: '#f5a524', exposed: true, rail: false, route: false, heavy: false },
  motorcycle: { name: 'Мотоцикл', length: 2.2, width: 0.8, mass: 280, accel: 4.0, brakeFactor: 0.9, vmax: 200, color: '#ff6b3d', exposed: true, rail: false, route: false, heavy: false },
  car: { name: 'Легковой автомобиль', length: 4.5, width: 1.8, mass: 1400, accel: 2.5, brakeFactor: 1.0, vmax: 200, color: '#3e9bff', exposed: false, rail: false, route: false, heavy: false },
  suv: { name: 'Внедорожник', length: 4.8, width: 1.95, mass: 2100, accel: 2.2, brakeFactor: 0.95, vmax: 180, color: '#8b6fe8', exposed: false, rail: false, route: false, heavy: false },
  van: { name: 'Микроавтобус / фургон', length: 5.6, width: 2.0, mass: 2800, accel: 1.6, brakeFactor: 0.9, vmax: 130, color: '#e8e4d8', exposed: false, rail: false, route: false, heavy: false },
  truck: { name: 'Грузовик', length: 8.5, width: 2.5, mass: 14000, accel: 0.9, brakeFactor: 0.75, vmax: 90, color: '#c9a227', exposed: false, rail: false, route: false, heavy: true },
  bus: { name: 'Автобус', length: 12, width: 2.55, mass: 13000, accel: 0.9, brakeFactor: 0.7, vmax: 100, color: '#e5484d', exposed: false, rail: false, route: true, heavy: true },
  trolleybus: { name: 'Троллейбус', length: 12, width: 2.55, mass: 14000, accel: 1.1, brakeFactor: 0.7, vmax: 70, color: '#35b6c4', exposed: false, rail: false, route: true, heavy: true },
  tram: { name: 'Трамвай', length: 15, width: 2.5, mass: 24000, accel: 1.0, brakeFactor: 1, brakeCap: 2.7, vmax: 70, color: '#d94f8c', exposed: false, rail: true, route: true, heavy: true },
  cart: { name: 'Гужевая повозка', length: 3.6, width: 1.5, mass: 800, accel: 0.6, brakeFactor: 0.5, vmax: 15, color: '#9a7b4f', exposed: true, rail: false, route: false, heavy: false },
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

export type SignKind = 'main' | 'giveway' | 'stop' | 'noentry' | 'limit' | 'noovertake' | 'crosswalk';

export interface Sign {
  id: string;
  x: number;
  y: number;
  /** направление движения, которому адресован знак */
  angle: number;
  kind: SignKind;
  /** для ограничения скорости, км/ч */
  value?: number;
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
    obstacles: [],
    actors: [],
  };
}

export type AnyItem = Road | Sidewalk | TramTrack | Crosswalk | TrafficLight | Sign | Obstacle | Actor;
export type Collection = 'roads' | 'sidewalks' | 'tracks' | 'crosswalks' | 'lights' | 'signs' | 'obstacles' | 'actors';

export const COLLECTIONS: Collection[] = ['roads', 'sidewalks', 'tracks', 'crosswalks', 'lights', 'signs', 'obstacles', 'actors'];

const PREFIX: Record<Collection, string> = {
  roads: 'r',
  sidewalks: 's',
  tracks: 't',
  crosswalks: 'c',
  lights: 'l',
  signs: 'g',
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
  if (!raw || typeof raw !== 'object') throw new Error('Неверный формат файла');
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
    obstacles: [],
    actors: [],
  };
  for (const c of COLLECTIONS) {
    const arr = (r as Record<string, unknown>)[c];
    if (Array.isArray(arr)) (scene[c] as unknown[]) = arr.filter((x) => x && typeof x === 'object');
  }
  for (const road of scene.roads) {
    road.lanes = road.lanes ?? 1;
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
  for (const a of scene.actors) {
    a.path = a.path ?? [];
    a.flags = Object.assign({ drunk: false, noLicense: false, flees: false }, a.flags);
    a.delay = a.delay ?? 0;
  }
  return scene;
}
