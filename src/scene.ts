import type { Vec } from './geom';
import { LEGACY_SIGN_KIND } from './signs';

// ---------------------------------------------------------------------------
// Каталог участников движения

export type VehicleType =
  | 'sim'
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
  /** механическое ТС */
  motorized: boolean;
  /** для управления требуется специальное право */
  licenseRequired: boolean;
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
  // Zero values are an unconfigured draft, never a physical parameter set.
  sim: { motorized: false, licenseRequired: false, name: 'СИМ', length: 0, width: 0, mass: 0, accel: 0, brakeFactor: 0, vmax: 0, color: '#45c9b2', exposed: true, rail: false, route: false, heavy: false, height: 0, payload: 0 },
  bicycle: { motorized: false, licenseRequired: false, name: 'Велосипед', length: 1.8, width: 0.6, mass: 95, accel: 1.0, brakeFactor: 0.6, vmax: 35, color: '#2fb36b', exposed: true, rail: false, route: false, heavy: false, height: 1.8, payload: 0 },
  moped: { motorized: true, licenseRequired: true, name: 'Мопед', length: 1.8, width: 0.7, mass: 150, accel: 1.4, brakeFactor: 0.8, vmax: 50, color: '#f5a524', exposed: true, rail: false, route: false, heavy: false, height: 1.7, payload: 0 },
  motorcycle: { motorized: true, licenseRequired: true, name: 'Мотоцикл', length: 2.2, width: 0.8, mass: 280, accel: 4.0, brakeFactor: 0.9, vmax: 200, color: '#ff6b3d', exposed: true, rail: false, route: false, heavy: false, height: 1.5, payload: 0 },
  car: { motorized: true, licenseRequired: true, name: 'Легковой автомобиль', length: 4.5, width: 1.8, mass: 1400, accel: 2.5, brakeFactor: 1.0, vmax: 200, color: '#3e9bff', exposed: false, rail: false, route: false, heavy: false, height: 1.5, payload: 450 },
  suv: { motorized: true, licenseRequired: true, name: 'Внедорожник', length: 4.8, width: 1.95, mass: 2100, accel: 2.2, brakeFactor: 0.95, vmax: 180, color: '#8b6fe8', exposed: false, rail: false, route: false, heavy: false, height: 1.8, payload: 600 },
  van: { motorized: true, licenseRequired: true, name: 'Микроавтобус / фургон', length: 5.6, width: 2.0, mass: 2800, accel: 1.6, brakeFactor: 0.9, vmax: 130, color: '#e8e4d8', exposed: false, rail: false, route: false, heavy: false, height: 2.5, payload: 1200 },
  truck: { motorized: true, licenseRequired: true, name: 'Грузовик', length: 8.5, width: 2.5, mass: 14000, accel: 0.9, brakeFactor: 0.75, vmax: 90, color: '#c9a227', exposed: false, rail: false, route: false, heavy: true, height: 3.5, payload: 8000 },
  bus: { motorized: true, licenseRequired: true, name: 'Автобус', length: 12, width: 2.55, mass: 13000, accel: 0.9, brakeFactor: 0.7, vmax: 100, color: '#e5484d', exposed: false, rail: false, route: true, heavy: true, height: 3.0, payload: 0 },
  trolleybus: { motorized: true, licenseRequired: true, name: 'Троллейбус', length: 12, width: 2.55, mass: 14000, accel: 1.1, brakeFactor: 0.7, vmax: 70, color: '#35b6c4', exposed: false, rail: false, route: true, heavy: true, height: 3.4, payload: 0 },
  tram: { motorized: true, licenseRequired: true, name: 'Трамвай', length: 15, width: 2.5, mass: 24000, accel: 1.0, brakeFactor: 1, brakeCap: 2.7, vmax: 70, color: '#d94f8c', exposed: false, rail: true, route: true, heavy: true, height: 3.4, payload: 0 },
  cart: { motorized: false, licenseRequired: false, name: 'Гужевая повозка', length: 3.6, width: 1.5, mass: 800, accel: 0.6, brakeFactor: 0.5, vmax: 15, color: '#9a7b4f', exposed: true, rail: false, route: false, heavy: false, height: 2.2, payload: 600 },
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

/** Установленные особенности участка, используемые при проверке манёвров. */
export type RoadFeature = 'bridge' | 'tunnel' | 'railway-crossing' | 'limited-visibility' | 'stop-area' | 'motorway';

/** Измеренная полоса: расстояния вдоль оси, смещение вправо от авторского направления. */
export interface RouteLane {
  id: string;
  fromS: number;
  toS: number;
  offset: number;
  width: number;
  direction: 'forward' | 'reverse';
  signIds: string[];
  boundary?: 'dashed' | 'solid' | 'unknown';
  rightmost?: boolean;
  source?: string;
}

export interface RouteStop {
  id: string;
  roadId: string;
  x: number;
  y: number;
  heading: number;
  signId?: string;
  markingId?: string;
  source?: string;
}

export interface RouteContext {
  regularService?: boolean;
  schoolBus?: boolean;
  taxi?: boolean;
  /** Подтверждён весь набор условий регионального исключения 18.2. */
  regionalBusLaneEligible?: boolean;
  depotExit?: boolean;
  departureStopId?: string;
  laneUse?: 'through' | 'turn' | 'enter-road' | 'passenger-stop';
  routeVehiclesUnimpeded?: boolean;
  departureChecks?: { otherId: string; yieldingVerified?: boolean }[];
}

export interface Road {
  id: string;
  routeLanes?: RouteLane[];
  /** Выезд с прилегающей территории не образует перекрёсток (п. 1.2). */
  role?: 'road' | 'adjacent' | 'roundabout';
  /** Для определения главной по покрытию; неизвестное покрытие не предполагается твёрдым. */
  surfacePriority?: 'hard' | 'unpaved' | 'unknown';
  features?: RoadFeature[];
  /** Установленная дальность видимости дороги, м; отсутствие значения означает неизвестность. */
  visibility?: number;
  /** Полоса разгона/торможения задаётся отдельной полосой дороги. */
  laneRole?: 'ordinary' | 'acceleration' | 'deceleration';
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

export const MOBILITY_SURFACES = ['sidewalk', 'footpath', 'cyclepath', 'sharedpath', 'pedestrian-side', 'cycle-side', 'cycle-lane', 'shoulder', 'pedestrian-zone', 'cycle-zone'] as const;
export type MobilitySurface = typeof MOBILITY_SURFACES[number];

export interface Sidewalk {
  /** Legacy corridors remain sidewalks. A lane/zone is an explicitly measured corridor. */
  mobilityKind?: MobilitySurface;
  /** Direction along drawn corridor, required to establish admission to a cycle lane. */
  travelDirection?: 'forward' | 'reverse' | 'both';
  source?: string;
  id: string;
  pts: Vec[];
  radius?: number;
  width: number;
  smooth: boolean;
}

export interface TramTrack {
  id: string;
  /** Старые сцены содержат трамвайные пути. Железная дорога задаётся явно. */
  kind?: 'tram' | 'railway';
  pts: Vec[];
  radius?: number;
  /** путь выделен бордюром или разделительной полосой */
  separated: boolean;
  smooth: boolean;
}

/** Геометрия и установленные состояния переезда; незаданный факт неизвестен. */
export interface RailwayCrossing {
  id: string;
  x: number;
  y: number;
  /** Курс пересекающей рельсы дороги. */
  angle: number;
  /** Ширина поперёк дороги и расстояние между крайними рельсами вдоль дороги, м. */
  width: number;
  length: number;
  barrier?: 'none' | 'open' | 'closing' | 'closed';
  signal?: 'off' | 'red' | 'white';
  lightPresent?: boolean;
  stopLinePresent?: boolean;
  regulated?: boolean;
  attendantStop?: boolean;
  exitBlocked?: boolean;
  visibleTrainApproaching?: boolean;
  /** Измеренные расстояния от ближайшего крайнего рельса, симметрично с обеих сторон. */
  stopLineDistance?: number;
  controlDistance?: number;
  source?: string;
}

/** Параметры конкретного состава из задания/источника; типовые значения не подставляются. */
export interface RailwayTrain {
  mass: number;
  length: number;
  width: number;
  brakeDecel: number;
  source: string;
  trackId?: string;
}

export interface RailwayContext {
  crossingId?: string;
  bypassingWaitingQueue?: boolean;
  openedBarrier?: boolean;
  machineryTransportPosition?: boolean;
  /** Конструктивная скорость машины менее 8 км/ч, а не её текущая скорость. */
  slowMachinery?: boolean;
  tractorSledge?: boolean;
  trackAuthorityPermission?: boolean;
  forcedStop?: boolean;
  passengersDisembarked?: boolean;
  clearingCrossing?: boolean;
  stopMessengers?: 'both' | 'worse-visibility' | 'none';
  messengersPossible?: boolean;
  stayedByVehicle?: boolean;
  generalAlarm?: boolean;
  trainStopSignal?: boolean;
}

/** Установленные условия применения специальных сигналов; отсутствие bool неизвестно. */
export interface SpecialSignals {
  beacon: 'unknown' | 'none' | 'blue' | 'blue-red' | 'yellow' | 'orange' | 'white';
  siren?: boolean;
  urgentDuty?: boolean;
  colorScheme?: boolean;
  safetyEnsured?: boolean;
  /** Установленное основание обязательного жёлтого/оранжевого маячка по 3.4. */
  warningReason?: 'road-work' | 'recovery' | 'oversized' | 'high-danger-cargo' | 'heavy-sign-exemption'
    | 'oversize-escort' | 'dangerous-escort' | 'cycling-training-escort' | 'children-group';
}

/** Факты для конкретной пары, не распространяющиеся автоматически на остальных. */
export interface SpecialInteraction {
  otherId: string;
  yielded?: boolean;
  yieldingVerified?: boolean;
  beaconVisible?: boolean;
  immediateStopPossible?: boolean;
  organizedMovementObstructed?: boolean;
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

export type Movement = 'straight' | 'right' | 'left' | 'uturn';

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
  mode?: 'cycle' | 'flashing-yellow' | 'off';
  kind?: 'vehicle' | 'bicycle' | 'pedestrian' | 'tram' | 'reversible' | 'controller';
  mainDirections?: Movement[];
  extraSection?: { directions: Movement[]; on: boolean };
  reversibleState?: 'red' | 'yellow' | 'green';
  tramDirections?: Movement[];
  controllerGesture?: 'arms-out' | 'right-arm-forward' | 'arm-up' | 'stop';
  /** Для адресного требования 6.11; angle сохраняет физическое направление груди. */
  controllerTargetHeading?: number;
  /** Внутренний/выходной сигнал без стоп-линии: исключение п. 13.7. */
  stopLine?: boolean;
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
  /** Табличка 8.13: абсолютные азимуты подходов главной дороги к перекрёстку. */
  mainDirections?: number[];
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

export type TurnSignal = 'none' | 'left' | 'right' | 'hazard';

export interface Waypoint {
  x: number;
  y: number;
  /** Скорость в этой точке, км/ч; отрицательное значение у ТС означает задний ход. */
  v: number;
  /** сколько секунд стоять, если скорость в точке нулевая */
  hold?: number;
  signal?: TurnSignal;
  /** Абсолютное время включения сигнала от начала симуляции, с. */
  signalAt?: number;
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

/** Подтверждённые обстоятельства манёвра. Незаданный факт не считается ложным. */
export interface ManeuverContext {
  longVehicleException?: boolean;
  cannotKeepExtreme?: boolean;
  expectedStraight?: boolean;
  oncomingClear?: boolean;
  overtakeReturnClear?: boolean;
  overtakenAccelerates?: boolean;
  opposingObstacle?: boolean;
  steepSlope?: boolean;
  slopeDownhill?: boolean;
  overtakingDifficult?: boolean;
  keptRight?: boolean;
  yieldedByStop?: boolean;
  handSignal?: 'none' | 'left' | 'right' | 'stop';
  indicatorsUnavailable?: boolean;
}

/** Explicit, user-sourced parameters; no confirmed SIM catalogue is bundled. */
export interface SimParameters {
  deviceMass?: number;
  riderMass?: number;
  length?: number;
  width?: number;
  height?: number;
  accel?: number;
  brakeDecel?: number;
  source?: string;
}

/** Facts apply along the authored route; split scenarios if they change with time. */
export interface MobilityContext {
  cycleInfrastructureUnavailable?: boolean;
  carriagewayUnavailable?: boolean;
  shoulderUnavailable?: boolean;
  pedestrianInfrastructureUnavailable?: boolean;
  accompaniesChildUnder14?: boolean;
  carriesChildUnder7?: boolean;
  adultAccompanied?: boolean;
  column?: boolean;
  roadAllowsCycling?: boolean;
  roadSpeedLimit?: number;
  roadEquipmentComplete?: boolean;
  pedestrianObstruction?: boolean;
  pedestrianDanger?: boolean;
  pedestrianPriorityRespected?: boolean;
  pedestrianSpeedKmh?: number;
  singleFile?: boolean;
  leftBypass?: boolean;
  leftTurnPermittedFromRight?: boolean;
  /** Confirmed consequences of a rule violation, NOT an injury simulation output. */
  causedVehicleObstruction?: boolean;
  /** Requirement whose violation caused the confirmed consequence, e.g. pdd:24.8. */
  consequenceRuleRef?: string;
  negligentHarm?: 'none' | 'light' | 'medium';
  source?: string;
}

export interface Actor {
  simParameters?: SimParameters;
  mobilityContext?: MobilityContext;
  /** Walking is represented by kind=pedestrian; this records the led device. */
  leadingDevice?: 'bicycle' | 'sim' | 'moped' | 'motorcycle';
  /** Водитель не может определить наличие покрытия: п. 13.13. */
  coveringUnknown?: boolean;
  /** Возраст в полных годах; для ребёнка без возраста правовой субъект не установлен. */
  age?: number;
  id: string;
  kind: 'vehicle' | 'pedestrian';
  type: VehicleType | PedestrianType;
  x: number;
  y: number;
  heading: number;
  color: string;
  /** Скорость в начальной точке, км/ч; отрицательная у ТС означает задний ход. */
  speed: number;
  /** появление на сцене, с */
  delay: number;
  path: Waypoint[];
  flags: DriverFlags;
  maneuverContext?: ManeuverContext;
  railwayTrain?: RailwayTrain;
  railwayContext?: RailwayContext;
  specialSignals?: SpecialSignals;
  specialInteractions?: SpecialInteraction[];
  routeContext?: RouteContext;
  /** груз (только для ТС) */
  cargo?: Cargo;
  /** трамвай: при сильном ударе возможен сход с путей (иначе едет строго по рельсам) */
  derail?: boolean;
}

/** Локальные дата и время места ДТП, формат datetime-local. */
export function defaultAccidentDate(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export interface Env {
  accidentDate: string;
  federalCity?: 'moscow' | 'saint-petersburg' | 'sevastopol' | 'other';
  /** Параметры модели заблаговременности сигнала; ПДД не задают эти числа. */
  signalLeadSeconds?: number;
  signalLeadMeters?: number;
  surface: SurfaceType;
  duration: number;
}

export interface Scene {
  routeStops?: RouteStop[];
  railwayCrossings?: RailwayCrossing[];
  /** Обмеренные границы по началам закруглений (п. 1.2), заменяют автоматическую оценку. */
  intersectionBounds?: { id: string; roadIds: string[]; boundary: Vec[] }[];
  /** Дата правовой оценки (ISO YYYY-MM-DD). */
  analysisDate?: string;
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
    env: { accidentDate: defaultAccidentDate(), surface: 'dry', duration: 20 },
    roads: [],
    sidewalks: [],
    tracks: [],
    railwayCrossings: [],
    routeStops: [],
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
  if (!l || l.mode === 'off' || l.mode === 'flashing-yellow' || l.kind === 'bicycle' || l.kind === 'controller') return null;
  if (l.kind === 'pedestrian') return lightPhase(l, t) === 'green';
  return lightPhase(l, t) === 'red';
}

export function actorSpec(a: Actor): { length: number; width: number; mass: number } {
  if (a.railwayTrain) {
    validateRailwayTrain(a);
    const { length, width, mass } = a.railwayTrain;
    return { length, width, mass };
  }
  if (a.kind === 'pedestrian') {
    const s = PEDESTRIANS[a.type as PedestrianType];
    return { length: s.size, width: s.size, mass: s.mass };
  }
  if (a.type === 'sim') {
    const p = a.simParameters;
    return { length: p?.length ?? 0, width: p?.width ?? 0, mass: (p?.deviceMass ?? 0) + (p?.riderMass ?? 0) };
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
  const name = a.railwayTrain ? 'Поезд' : a.kind === 'vehicle' ? VEHICLES[a.type as VehicleType].name : PEDESTRIANS[a.type as PedestrianType].name;
  return `${labels.get(a.id) ?? a.id} (${name.toLowerCase()})`;
}

export function cloneScene<T>(s: T): T {
  return JSON.parse(JSON.stringify(s)) as T;
}

export function validateRailwayTrain(a: Actor): void {
  const train = a.railwayTrain;
  if (!train) return;
  if (a.kind !== 'vehicle' || a.type !== 'tram'
    || !['mass', 'length', 'width', 'brakeDecel'].every(key => {
      const value = train[key as 'mass' | 'length' | 'width' | 'brakeDecel'];
      return Number.isFinite(value) && value > 0;
    }) || typeof train.source !== 'string' || !train.source.trim()) {
    throw new Error(`Поезд ${a.id}: нужны положительные масса, длина, ширина, замедление и источник параметров`);
  }
}

export function validateSimParameters(a: Actor): void {
  if (a.kind !== 'vehicle' || a.type !== 'sim') return;
  const p = a.simParameters;
  if (!p || !['deviceMass', 'riderMass', 'length', 'width', 'height', 'brakeDecel'].every(key =>
    Number.isFinite(p[key as keyof SimParameters]) && Number(p[key as keyof SimParameters]) > 0)
    || !Number.isFinite(p.accel) || p.accel! < 0 || !p.source?.trim()) {
    throw new Error(`СИМ ${a.id}: введите массу устройства и ездока, габариты, ускорение, замедление и источник параметров`);
  }
}

/** Достраивает отсутствующие поля при загрузке сохранённой сцены. */
export function normalizeScene(raw: unknown): Scene {
  const base = emptyScene();
  if (!raw || typeof raw !== 'object') throw new Error('Неверный формат файла');
  const r = raw as Partial<Scene>;
  const scene: Scene = {
    ...base,
    name: typeof r.name === 'string' ? r.name : base.name,
    analysisDate: typeof r.analysisDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.analysisDate) ? r.analysisDate : undefined,
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
  for (const field of ['signalLeadSeconds', 'signalLeadMeters'] as const) {
    if (!Number.isFinite(scene.env[field]) || scene.env[field]! <= 0) delete scene.env[field];
  }
  if (!['moscow', 'saint-petersburg', 'sevastopol', 'other'].includes(scene.env.federalCity ?? '')) delete scene.env.federalCity;
  for (const c of COLLECTIONS) {
    const arr = (r as Record<string, unknown>)[c];
    if (Array.isArray(arr)) (scene[c] as unknown[]) = arr.filter((x) => x && typeof x === 'object');
  }
  if (Array.isArray(r.routeStops)) {
    scene.routeStops = r.routeStops.map(stop => {
      if (!stop || typeof stop.id !== 'string' || typeof stop.roadId !== 'string'
        || !scene.roads.some(road => road.id === stop.roadId) || ![stop.x, stop.y, stop.heading].every(Number.isFinite)) {
        throw new Error('Остановочное место: нужны координаты, курс и ссылка на существующую дорогу');
      }
      const result: RouteStop = { id: stop.id, roadId: stop.roadId, x: stop.x, y: stop.y, heading: stop.heading };
      for (const key of ['signId', 'markingId', 'source'] as const) if (typeof stop[key] === 'string') result[key] = stop[key];
      return result;
    });
  } else delete scene.routeStops;
  for (const track of scene.tracks) track.kind = track.kind === 'railway' ? 'railway' : 'tram';
  if (Array.isArray(r.railwayCrossings)) {
    scene.railwayCrossings = r.railwayCrossings.map(crossing => {
      if (!crossing || typeof crossing.id !== 'string'
        || ![crossing.x, crossing.y, crossing.angle, crossing.width, crossing.length].every(Number.isFinite)
        || crossing.width <= 0 || crossing.length <= 0) throw new Error('Переезд: нужны координаты, угол и положительные размеры');
      const result: RailwayCrossing = { id: crossing.id, x: crossing.x, y: crossing.y,
        angle: crossing.angle, width: crossing.width, length: crossing.length };
      if (['none', 'open', 'closing', 'closed'].includes(crossing.barrier ?? '')) result.barrier = crossing.barrier;
      if (['off', 'red', 'white'].includes(crossing.signal ?? '')) result.signal = crossing.signal;
      for (const key of ['lightPresent', 'stopLinePresent', 'regulated', 'attendantStop', 'exitBlocked', 'visibleTrainApproaching'] as const) {
        if (typeof crossing[key] === 'boolean') result[key] = crossing[key];
      }
      for (const key of ['stopLineDistance', 'controlDistance'] as const) {
        if (Number.isFinite(crossing[key]) && crossing[key]! >= 0) result[key] = crossing[key];
      }
      if (typeof crossing.source === 'string') result.source = crossing.source;
      return result;
    });
  } else delete scene.railwayCrossings;
  for (const road of scene.roads) {
    if (Array.isArray(road.routeLanes)) {
      road.routeLanes = road.routeLanes.map(lane => {
        if (!lane || typeof lane.id !== 'string' || ![lane.fromS, lane.toS, lane.offset, lane.width].every(Number.isFinite)
          || lane.fromS < 0 || lane.toS <= lane.fromS || lane.width <= 0 || !['forward', 'reverse'].includes(lane.direction)) {
          throw new Error(`Маршрутная полоса дороги ${road.id}: нужны корректные расстояния, смещение, ширина и направление`);
        }
        const result: RouteLane = { id: lane.id, fromS: lane.fromS, toS: lane.toS, offset: lane.offset,
          width: lane.width, direction: lane.direction, signIds: Array.isArray(lane.signIds) ? [...new Set(lane.signIds.filter(id => typeof id === 'string'))] : [] };
        if (['dashed', 'solid', 'unknown'].includes(lane.boundary ?? '')) result.boundary = lane.boundary;
        if (typeof lane.rightmost === 'boolean') result.rightmost = lane.rightmost;
        if (typeof lane.source === 'string') result.source = lane.source;
        return result;
      });
    } else delete road.routeLanes;
    road.role = ['road', 'adjacent', 'roundabout'].includes(road.role ?? '') ? road.role : 'road';
    road.surfacePriority = ['hard', 'unpaved', 'unknown'].includes(road.surfacePriority ?? '') ? road.surfacePriority : 'hard';
    const features: RoadFeature[] = ['bridge', 'tunnel', 'railway-crossing', 'limited-visibility', 'stop-area', 'motorway'];
    if (Array.isArray(road.features)) road.features = [...new Set(road.features.filter(feature => features.includes(feature)))];
    else delete road.features;
    if (!Number.isFinite(road.visibility) || road.visibility! < 0) delete road.visibility;
    if (!['ordinary', 'acceleration', 'deceleration'].includes(road.laneRole ?? '')) delete road.laneRole;
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
  for (const corridor of scene.sidewalks) {
    if (!MOBILITY_SURFACES.includes(corridor.mobilityKind!)) delete corridor.mobilityKind;
    if (!['forward', 'reverse', 'both'].includes(corridor.travelDirection ?? '')) delete corridor.travelDirection;
    if (typeof corridor.source !== 'string') delete corridor.source;
  }
  for (const g of scene.signs) {
    g.kind = LEGACY_SIGN_KIND[g.kind] ?? g.kind;
    if (!Array.isArray(g.plates)) delete g.plates;
    if (Array.isArray(g.mainDirections)) g.mainDirections = g.mainDirections.filter(Number.isFinite);
    else delete g.mainDirections;
  }
  const movements = (value: unknown): Movement[] | undefined => Array.isArray(value)
    ? [...new Set(value.filter((x): x is Movement => ['straight', 'right', 'left', 'uturn'].includes(x)))] : undefined;
  for (const light of scene.lights) {
    light.mode = ['cycle', 'flashing-yellow', 'off'].includes(light.mode ?? '') ? light.mode : 'cycle';
    light.kind = ['vehicle', 'bicycle', 'pedestrian', 'tram', 'reversible', 'controller'].includes(light.kind ?? '') ? light.kind : 'vehicle';
    light.stopLine = light.stopLine !== false;
    light.mainDirections = movements(light.mainDirections);
    light.tramDirections = movements(light.tramDirections);
    if (light.extraSection && typeof light.extraSection === 'object') {
      light.extraSection = { directions: movements(light.extraSection.directions) ?? [], on: light.extraSection.on === true };
    } else delete light.extraSection;
    if (light.kind === 'reversible' && !['red', 'yellow', 'green'].includes(light.reversibleState ?? '')) light.reversibleState = 'red';
    if (light.kind === 'controller' && !['arms-out', 'right-arm-forward', 'arm-up', 'stop'].includes(light.controllerGesture ?? '')) light.controllerGesture = 'arm-up';
    if (!Number.isFinite(light.controllerTargetHeading)) delete light.controllerTargetHeading;
  }
  const finitePoint = (p: Vec) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (Array.isArray(r.intersectionBounds)) {
    scene.intersectionBounds = r.intersectionBounds.filter(b => b && typeof b.id === 'string'
      && Array.isArray(b.roadIds) && b.roadIds.length >= 2 && b.roadIds.every(id => scene.roads.some(road => road.id === id))
      && Array.isArray(b.boundary) && b.boundary.length >= 3 && b.boundary.every(finitePoint))
      .map(b => ({ id: b.id, roadIds: [...new Set(b.roadIds)], boundary: b.boundary.map(p => ({ x: p.x, y: p.y })) }))
      .filter(b => b.roadIds.length >= 2 && Math.abs(b.boundary.reduce((area, p, i, ps) => {
        const next = ps[(i + 1) % ps.length];
        return area + p.x * next.y - next.x * p.y;
      }, 0)) > 1e-6);
  }
  scene.markings = scene.markings.filter((m) => m && Array.isArray(m.pts) && m.pts.length >= 1 && typeof m.kind === 'string');
  for (const a of scene.actors) {
    if (a.kind !== 'pedestrian' || !['bicycle', 'sim', 'moped', 'motorcycle'].includes(a.leadingDevice ?? '')) delete a.leadingDevice;
    if (a.kind === 'vehicle' && a.type === 'sim' && a.simParameters && typeof a.simParameters === 'object') {
      const p: SimParameters = {};
      for (const key of ['deviceMass', 'riderMass', 'length', 'width', 'height', 'brakeDecel', 'accel'] as const) {
        const value = a.simParameters[key];
        if (Number.isFinite(value) && (key === 'accel' ? value! >= 0 : value! > 0)) p[key] = value;
      }
      if (typeof a.simParameters.source === 'string') p.source = a.simParameters.source.trim();
      a.simParameters = p;
    } else delete a.simParameters;
    if (a.type === 'sim') delete a.cargo;
    const rawMobility = a.mobilityContext;
    if (rawMobility && typeof rawMobility === 'object' && !Array.isArray(rawMobility)) {
      const context: MobilityContext = {};
      for (const key of ['cycleInfrastructureUnavailable', 'carriagewayUnavailable', 'shoulderUnavailable',
        'pedestrianInfrastructureUnavailable', 'accompaniesChildUnder14', 'carriesChildUnder7', 'adultAccompanied',
        'column', 'roadAllowsCycling', 'roadEquipmentComplete', 'pedestrianObstruction', 'pedestrianDanger',
        'pedestrianPriorityRespected', 'singleFile', 'leftBypass', 'leftTurnPermittedFromRight', 'causedVehicleObstruction'] as const) {
        if (typeof rawMobility[key] === 'boolean') context[key] = rawMobility[key];
      }
      for (const key of ['roadSpeedLimit', 'pedestrianSpeedKmh'] as const) if (Number.isFinite(rawMobility[key]) && rawMobility[key]! >= 0) context[key] = rawMobility[key];
      if (['none', 'light', 'medium'].includes(rawMobility.negligentHarm ?? '')) context.negligentHarm = rawMobility.negligentHarm;
      if (typeof rawMobility.source === 'string') context.source = rawMobility.source;
      if (typeof rawMobility.consequenceRuleRef === 'string' && /^pdd:\d/.test(rawMobility.consequenceRuleRef)) context.consequenceRuleRef = rawMobility.consequenceRuleRef;
      a.mobilityContext = context;
    } else delete a.mobilityContext;
    const rawRoute = a.routeContext;
    if (rawRoute && typeof rawRoute === 'object' && !Array.isArray(rawRoute)) {
      const context: RouteContext = {};
      for (const fact of ['regularService', 'schoolBus', 'taxi', 'regionalBusLaneEligible', 'depotExit', 'routeVehiclesUnimpeded'] as const) {
        if (typeof rawRoute[fact] === 'boolean') context[fact] = rawRoute[fact];
      }
      if (typeof rawRoute.departureStopId === 'string') context.departureStopId = rawRoute.departureStopId;
      if (['through', 'turn', 'enter-road', 'passenger-stop'].includes(rawRoute.laneUse ?? '')) context.laneUse = rawRoute.laneUse;
      if (Array.isArray(rawRoute.departureChecks)) {
        const seen = new Set<string>();
        context.departureChecks = rawRoute.departureChecks.filter(check => {
          if (!check || typeof check.otherId !== 'string' || check.otherId === a.id || seen.has(check.otherId)
            || !scene.actors.some(other => other.id === check.otherId)) return false;
          seen.add(check.otherId);
          return true;
        }).map(check => ({ otherId: check.otherId, ...(typeof check.yieldingVerified === 'boolean' ? { yieldingVerified: check.yieldingVerified } : {}) }));
      }
      if (Object.keys(context).length) a.routeContext = context;
      else delete a.routeContext;
    } else delete a.routeContext;
    const rawSignals = a.specialSignals;
    if (rawSignals && typeof rawSignals === 'object' && !Array.isArray(rawSignals)) {
      const signals: SpecialSignals = { beacon: ['unknown', 'none', 'blue', 'blue-red', 'yellow', 'orange', 'white'].includes(rawSignals.beacon)
        ? rawSignals.beacon : 'unknown' };
      for (const fact of ['siren', 'urgentDuty', 'colorScheme', 'safetyEnsured'] as const) {
        if (typeof rawSignals[fact] === 'boolean') signals[fact] = rawSignals[fact];
      }
      if (['road-work', 'recovery', 'oversized', 'high-danger-cargo', 'heavy-sign-exemption',
        'oversize-escort', 'dangerous-escort', 'cycling-training-escort', 'children-group'].includes(rawSignals.warningReason ?? '')) {
        signals.warningReason = rawSignals.warningReason;
      }
      a.specialSignals = signals;
    } else delete a.specialSignals;
    if (Array.isArray(a.specialInteractions)) {
      const seen = new Set<string>();
      a.specialInteractions = a.specialInteractions.filter(pair => {
        if (!pair || typeof pair.otherId !== 'string' || pair.otherId === a.id
          || !scene.actors.some(other => other.id === pair.otherId) || seen.has(pair.otherId)) return false;
        seen.add(pair.otherId);
        return true;
      }).map(pair => {
        const result: SpecialInteraction = { otherId: pair.otherId };
        for (const fact of ['yielded', 'yieldingVerified', 'beaconVisible', 'immediateStopPossible', 'organizedMovementObstructed'] as const) {
          if (typeof pair[fact] === 'boolean') result[fact] = pair[fact];
        }
        return result;
      });
      if (!a.specialInteractions.length) delete a.specialInteractions;
    } else delete a.specialInteractions;
    validateRailwayTrain(a);
    if (a.railwayTrain) {
      a.railwayTrain.source = a.railwayTrain.source.trim();
      if (typeof a.railwayTrain.trackId !== 'string') delete a.railwayTrain.trackId;
      delete a.derail; // Порог схода трамвая не является моделью схода поезда.
    }
    const rawRailway = a.railwayContext;
    if (rawRailway && typeof rawRailway === 'object' && !Array.isArray(rawRailway)) {
      const context: RailwayContext = {};
      const facts = ['bypassingWaitingQueue', 'openedBarrier', 'machineryTransportPosition', 'slowMachinery',
        'tractorSledge', 'trackAuthorityPermission', 'forcedStop', 'passengersDisembarked', 'clearingCrossing',
        'messengersPossible', 'stayedByVehicle', 'generalAlarm', 'trainStopSignal'] as const;
      for (const fact of facts) if (typeof rawRailway[fact] === 'boolean') context[fact] = rawRailway[fact];
      if (typeof rawRailway.crossingId === 'string') context.crossingId = rawRailway.crossingId;
      if (['both', 'worse-visibility', 'none'].includes(rawRailway.stopMessengers ?? '')) context.stopMessengers = rawRailway.stopMessengers;
      if (Object.keys(context).length) a.railwayContext = context;
      else delete a.railwayContext;
    } else delete a.railwayContext;
    a.coveringUnknown = a.coveringUnknown === true;
    // A pedestrian's path already expresses walking direction. The negative
    // speed convention is reserved for reversing transport, not walking back.
    const minimumSpeed = a.kind === 'vehicle' ? -50 : 0;
    const speed = (value: number): number => Number.isFinite(value) ? Math.max(minimumSpeed, Math.min(250, value)) : 0;
    a.speed = speed(a.speed);
    a.path = Array.isArray(a.path) ? a.path.filter(w => w && Number.isFinite(w.x) && Number.isFinite(w.y)) : [];
    for (const waypoint of a.path) {
      waypoint.v = speed(waypoint.v);
      waypoint.signal = ['none', 'left', 'right', 'hazard'].includes(waypoint.signal ?? '') ? waypoint.signal : 'none';
      if (!Number.isFinite(waypoint.signalAt) || waypoint.signalAt! < 0) delete waypoint.signalAt;
      if (!Number.isFinite(waypoint.hold) || waypoint.hold! < 0) delete waypoint.hold;
    }
    const rawContext = a.maneuverContext;
    if (rawContext && typeof rawContext === 'object' && !Array.isArray(rawContext)) {
      const context: ManeuverContext = {};
      const booleanFacts = ['longVehicleException', 'cannotKeepExtreme', 'expectedStraight', 'oncomingClear',
        'overtakeReturnClear', 'overtakenAccelerates', 'opposingObstacle', 'steepSlope', 'slopeDownhill',
        'overtakingDifficult', 'keptRight', 'yieldedByStop', 'indicatorsUnavailable'] as const;
      for (const fact of booleanFacts) if (typeof rawContext[fact] === 'boolean') context[fact] = rawContext[fact];
      if (['none', 'left', 'right', 'stop'].includes(rawContext.handSignal ?? '')) context.handSignal = rawContext.handSignal;
      if (Object.keys(context).length) a.maneuverContext = context;
      else delete a.maneuverContext;
    } else delete a.maneuverContext;
    a.flags = Object.assign({ drunk: false, noLicense: false, flees: false }, a.flags);
    a.delay = a.delay ?? 0;
    if (!Number.isInteger(a.age) || a.age! < 0 || a.age! > 120) delete a.age;
  }
  return scene;
}

/** Габариты участника с учётом свесов груза: длина, ширина, высота, масса и смещение центра кузова вдоль курса. */
export function dimsOf(a: Actor): { length: number; width: number; height: number; mass: number; shift: number } {
  const sp = actorSpec(a);
  if (a.kind !== 'vehicle') return { length: sp.length, width: sp.width, height: 1.7, mass: sp.mass, shift: 0 };
  const vs = VEHICLES[a.type as VehicleType];
  // Высота пока не участвует в отдельной модели поезда. Груз автотранспорта к составу не прибавляется.
  if (a.railwayTrain) return { ...sp, height: vs.height, shift: 0 };
  if (a.type === 'sim') return { ...sp, height: a.simParameters?.height ?? 0, shift: 0 };
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
