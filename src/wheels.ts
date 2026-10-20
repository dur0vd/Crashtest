import { SURFACES, VEHICLES, dimsOf, type Actor, type SurfaceType, type VehicleType } from './scene';

/**
 * Физика колёс: схема осей, нагрузка на каждое колесо, сцепление, торможение,
 * поворот, тяга, углы поворота и вращение. Всё в системе СИ; локальная система ТС:
 * x — вперёд по курсу, y — вправо (экранные координаты), начало — опорная точка ТС.
 */

const G = 9.81;
/** чувствительность сцепления шины к нагрузке: на перегруженном колесе μ падает, на разгруженном растёт */
const LOAD_SENS = 0.12;
/** доля пикового сцепления при заблокированном колесе (скольжение) */
export const SLIDE_RATIO = 0.85;
/** доля пикового сцепления, которую реализует АБС (проскальзывание 10–15 %) */
const ABS_EFF = 0.97;
/** опрокидывание наступает раньше теоретического порога из-за крена подвески */
const ROLL_COMPLIANCE = 0.9;
/** расстояние от центра сдвоенного колеса до каждого из пары, м */
const TWIN_OFFSET = 0.17;

export interface Axle {
  /** продольное положение оси от опорной точки, м */
  x: number;
  /** половина колеи (между центрами колёс; у сдвоенных — между центрами пар), м; 0 — одноколейное ТС */
  half: number;
  /** сдвоенные колёса */
  twin: boolean;
  steer: boolean;
  drive: boolean;
  /** доля тормозной силы ТС, приходящаяся на ось (сумма по осям = 1) */
  brake: number;
}

export interface Layout {
  axles: Axle[];
  /** радиус и ширина шины, м */
  radius: number;
  tyreW: number;
  /** высота центра масс порожнего ТС, м */
  hCg: number;
  /** положение центра масс порожнего ТС, м */
  xCg: number;
  abs: boolean;
  /** качество шины и протектора относительно эталонной легковой (множитель к μ покрытия) */
  grip: number;
  /** доля крена на передней оси (2-осные ТС) */
  rollFront: number;
  /** рельсовое ТС: боковую силу воспринимает гребень колеса, а не сцепление */
  guided: boolean;
}

type DriveKind = 'f' | 'r' | 'a' | 'n';

interface TwoAxle {
  /** передний свес, колёсная база, доля веса на переднюю ось */
  fo: number;
  wb: number;
  wf: number;
  half: number;
  twin?: boolean;
  r: number;
  tw: number;
  h: number;
  drive: DriveKind;
  /** доля тормозной силы на переднюю ось */
  bias: number;
  abs: boolean;
  grip: number;
  roll?: number;
}

function twoAxle(L: number, o: TwoAxle): Layout {
  const xf = L / 2 - o.fo;
  const xr = xf - o.wb;
  const d = o.drive;
  return {
    axles: [
      { x: xf, half: o.half, twin: false, steer: true, drive: d === 'f' || d === 'a', brake: o.bias },
      { x: xr, half: o.half, twin: !!o.twin, steer: false, drive: d === 'r' || d === 'a', brake: 1 - o.bias },
    ],
    radius: o.r,
    tyreW: o.tw,
    hCg: o.h,
    xCg: xf - (1 - o.wf) * o.wb,
    abs: o.abs,
    grip: o.grip,
    rollFront: o.roll ?? 0.55,
    guided: false,
  };
}

/** Схема колёс по типу ТС (размеры и развесовка — типичные для класса). */
const LAYOUTS: Record<VehicleType, (L: number) => Layout> = {
  bicycle: (L) => twoAxle(L, { fo: 0.35, wb: 1.05, wf: 0.45, half: 0, r: 0.34, tw: 0.04, h: 1.0, drive: 'r', bias: 0.5, abs: false, grip: 0.9 }),
  moped: (L) => twoAxle(L, { fo: 0.35, wb: 1.15, wf: 0.45, half: 0, r: 0.25, tw: 0.08, h: 0.75, drive: 'r', bias: 0.5, abs: false, grip: 0.95 }),
  motorcycle: (L) => twoAxle(L, { fo: 0.55, wb: 1.45, wf: 0.5, half: 0, r: 0.32, tw: 0.15, h: 0.6, drive: 'r', bias: 0.6, abs: true, grip: 1.0 }),
  car: (L) => twoAxle(L, { fo: 0.9, wb: 2.7, wf: 0.57, half: 0.78, r: 0.32, tw: 0.2, h: 0.55, drive: 'f', bias: 0.68, abs: true, grip: 1.0, roll: 0.58 }),
  suv: (L) => twoAxle(L, { fo: 0.95, wb: 2.85, wf: 0.52, half: 0.82, r: 0.38, tw: 0.25, h: 0.75, drive: 'a', bias: 0.62, abs: true, grip: 1.0 }),
  van: (L) => twoAxle(L, { fo: 1.0, wb: 3.4, wf: 0.5, half: 0.85, r: 0.35, tw: 0.2, h: 1.0, drive: 'r', bias: 0.6, abs: true, grip: 1.0 }),
  truck: (L) => twoAxle(L, { fo: 1.1, wb: 5.0, wf: 0.38, half: 0.95, twin: true, r: 0.5, tw: 0.28, h: 1.5, drive: 'r', bias: 0.5, abs: true, grip: 1.0, roll: 0.45 }),
  bus: (L) => twoAxle(L, { fo: 2.7, wb: 5.9, wf: 0.4, half: 1.0, twin: true, r: 0.5, tw: 0.28, h: 1.2, drive: 'r', bias: 0.45, abs: true, grip: 1.0, roll: 0.45 }),
  trolleybus: (L) => twoAxle(L, { fo: 2.7, wb: 5.9, wf: 0.4, half: 1.0, twin: true, r: 0.5, tw: 0.28, h: 1.2, drive: 'r', bias: 0.45, abs: true, grip: 1.0, roll: 0.45 }),
  cart: (L) => ({
    ...twoAxle(L, { fo: 0.6, wb: 2.0, wf: 0.35, half: 0.65, r: 0.45, tw: 0.05, h: 1.0, drive: 'n', bias: 0, abs: false, grip: 0.7 }),
  }),
  tram: (L) => {
    // два двухосных тележечных вагона: колёсные пары не поворачиваются, ведущие все
    const bog = L / 2 - 3.2;
    const xs = [bog + 0.9, bog - 0.9, -bog + 0.9, -bog - 0.9];
    return {
      axles: xs.map((x) => ({ x, half: 0.76, twin: false, steer: false, drive: true, brake: 0.25 })),
      radius: 0.42,
      tyreW: 0.1,
      hCg: 1.4,
      xCg: 0,
      abs: true,
      grip: 1,
      rollFront: 0.5,
      guided: true,
    };
  },
};

/** Отдельное колесо в локальной системе ТС. */
export interface WheelGeo {
  x: number;
  y: number;
  axle: number;
  steer: boolean;
  drive: boolean;
  /** доля тормозной силы ТС на это колесо */
  bias: number;
}

/** Динамические параметры конкретного ТС с учётом груза. */
export interface Dyn {
  type: VehicleType;
  layout: Layout;
  mass: number;
  /** брейк-фактор тормозной системы, предел замедления рельсового ТС */
  brakeFactor: number;
  brakeCap: number;
  xCg: number;
  hCg: number;
  wheels: WheelGeo[];
  /** доля веса на каждую ось */
  w: number[];
  /** средняя координата осей и сумма квадратов отклонений */
  xm: number;
  sxx: number;
  /** базовая нагрузка на колесо, Н (для чувствительности сцепления) */
  fz0: number;
  /** колёсная база (между первой и последней осью), м */
  wb: number;
  /** x задней неповоротной оси — центр поворота */
  xRef: number;
  /** запас по клевку при торможении, м/с² */
  pitch: number;
}

const wheelCountOf = (ax: Axle): number => (ax.half === 0 ? 1 : ax.twin ? 4 : 2);

export function dynOf(a: Actor): Dyn | null {
  if (a.kind !== 'vehicle') return null;
  const type = a.type as VehicleType;
  const vs = VEHICLES[type];
  const lay = LAYOUTS[type](vs.length);
  const dm = dimsOf(a);
  const c = a.cargo;
  const mCargo = c ? c.mass : 0;
  const mVeh = dm.mass - mCargo;
  // груз смещает центр масс: вдоль ТС — к своему центру, по высоте — на 60 % высоты загрузки
  const xCg = c && dm.mass > 0 ? (mVeh * lay.xCg + mCargo * dm.shift) / dm.mass : lay.xCg;
  const hCg = c && dm.mass > 0 ? (mVeh * lay.hCg + mCargo * Math.max(0.4, 0.6 * c.height)) / dm.mass : lay.hCg;
  const ax = lay.axles;
  const n = ax.length;
  const xm = ax.reduce((s, q) => s + q.x, 0) / n;
  const sxx = ax.reduce((s, q) => s + (q.x - xm) ** 2, 0);
  const w = ax.map((q) => 1 / n + ((xCg - xm) * (q.x - xm)) / sxx);
  const wheels: WheelGeo[] = [];
  ax.forEach((q, i) => {
    const cnt = wheelCountOf(q);
    const ys: number[] = [];
    if (q.half === 0) ys.push(0);
    else for (const side of [-1, 1]) {
      if (q.twin) ys.push(side * q.half - TWIN_OFFSET, side * q.half + TWIN_OFFSET);
      else ys.push(side * q.half);
    }
    for (const y of ys) wheels.push({ x: q.x, y, axle: i, steer: q.steer, drive: q.drive, bias: q.brake / cnt });
  });
  // опрокидывание вперёд при торможении: нагрузка задней оси обращается в ноль
  let pitch = Infinity;
  ax.forEach((q, i) => {
    if (q.x < xm - 1e-6) pitch = Math.min(pitch, (G * w[i] * sxx) / (hCg * (xm - q.x)));
  });
  const fixed = ax.filter((q) => !q.steer);
  const xRef = fixed.length ? Math.min(...fixed.map((q) => q.x)) : Math.min(...ax.map((q) => q.x));
  return {
    type,
    layout: lay,
    mass: dm.mass,
    brakeFactor: vs.brakeFactor,
    brakeCap: vs.brakeCap ?? Infinity,
    xCg,
    hCg,
    wheels,
    w,
    xm,
    sxx,
    fz0: (dm.mass * G) / wheels.length,
    wb: Math.max(...ax.map((q) => q.x)) - Math.min(...ax.map((q) => q.x)),
    xRef,
    pitch,
  };
}

/** Коэффициент сцепления колеса с учётом нагрузки, покрытия и качества шины. */
function muOf(d: Dyn, mu: number, fz: number): number {
  const k = 1 - LOAD_SENS * (fz / d.fz0 - 1);
  return mu * d.layout.grip * Math.min(1.15, Math.max(0.5, k));
}

/**
 * Нормальные нагрузки на колёса, Н.
 * @param aBrake продольное замедление, м/с² (+ торможение, − разгон): нагрузка переходит к передним (задним) осям
 * @param ay поперечное ускорение со знаком: + к правому борту; нагрузка переходит на наружные колёса
 */
export function wheelLoads(d: Dyn, aBrake: number, ay: number, out: number[] = []): number[] {
  const ax = d.layout.axles;
  const m = d.mass;
  const axleF = ax.map((q, i) => Math.max(0, m * G * d.w[i] + (m * aBrake * d.hCg * (q.x - d.xm)) / d.sxx));
  const total = axleF.reduce((s, f) => s + f, 0);
  const norm = total > 0 ? (m * G) / total : 1;
  const roll = ax.map((_, i) => (ax.length === 2 ? (i === 0 ? d.layout.rollFront : 1 - d.layout.rollFront) : d.w[i]));
  const cnt = ax.map(wheelCountOf);
  d.wheels.forEach((wh, idx) => {
    const q = ax[wh.axle];
    const F = axleF[wh.axle] * norm;
    if (q.half === 0) {
      out[idx] = F;
      return;
    }
    // перенос m·a·h/T (доля оси по крену): наружный борт оси получает ΔF, внутренний столько же теряет
    const dF = (m * Math.abs(ay) * d.hCg * roll[wh.axle]) / (2 * q.half);
    const outer = ay * wh.y < 0;
    let side = F / 2 + (outer ? dF : -dF);
    if (side < 0) side = 0;
    if (side > F) side = F;
    out[idx] = side / (cnt[wh.axle] / 2);
  });
  return out;
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

/** Предельное замедление, м/с²: пиковое (колесо на грани блокировки) и при заблокированных колёсах. */
export interface BrakeLimit {
  peak: number;
  slide: number;
}

export function brakeLimit(d: Dyn, mu: number): BrakeLimit {
  let a = mu * G * d.layout.grip;
  const fz: number[] = [];
  for (let i = 0; i < 40; i++) {
    wheelLoads(d, a, 0, fz);
    const cap = sum(fz.map((f) => muOf(d, mu, f) * f));
    a = 0.5 * a + 0.5 * Math.min(cap / d.mass, d.pitch);
  }
  const eff = d.layout.abs ? ABS_EFF : 1;
  const peak = Math.min(d.brakeCap, a * d.brakeFactor * eff);
  return { peak, slide: Math.min(d.brakeCap, peak * (d.layout.abs ? 1 : SLIDE_RATIO)) };
}

/** Предельное ускорение по сцеплению ведущих колёс, м/с² (Infinity, если ведущих колёс нет). */
export function tractionLimit(d: Dyn, mu: number): number {
  if (!d.wheels.some((w) => w.drive)) return Infinity;
  let a = mu * G;
  const fz: number[] = [];
  for (let i = 0; i < 40; i++) {
    wheelLoads(d, -a, 0, fz);
    let cap = 0;
    d.wheels.forEach((w, k) => {
      if (w.drive) cap += muOf(d, mu, fz[k]) * fz[k];
    });
    a = 0.5 * a + 0.5 * (cap / d.mass);
  }
  return a;
}

export type LossKind = 'understeer' | 'oversteer' | 'rollover';

export interface LateralLimit {
  /** предельное боковое ускорение по сцеплению, м/с² */
  grip: number;
  /** какая ось теряет сцепление первой: передняя — снос, задняя — занос */
  mode: 'understeer' | 'oversteer';
  /** предельное боковое ускорение до опрокидывания, м/с² */
  roll: number;
}

export function lateralLimit(d: Dyn, mu: number): LateralLimit {
  const T = d.layout.axles.reduce((s, q, i) => s + d.w[i] * 2 * q.half, 0);
  const roll = T > 0 ? (ROLL_COMPLIANCE * G * T) / (2 * d.hCg) : Infinity;
  if (d.layout.guided) return { grip: Infinity, mode: 'understeer', roll };
  const n = d.layout.axles.length;
  const fz: number[] = [];
  const util = (ay: number): number[] => {
    wheelLoads(d, 0, ay, fz);
    const cap = new Array<number>(n).fill(0);
    d.wheels.forEach((w, k) => (cap[w.axle] += muOf(d, mu, fz[k]) * fz[k]));
    return cap.map((c, i) => (c > 1e-6 ? (d.mass * ay * d.w[i]) / c : Infinity));
  };
  let lo = 0;
  let hi = 3 * G;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (Math.max(...util(mid)) >= 1) hi = mid;
    else lo = mid;
  }
  const u = util(hi);
  const front = u[0];
  const rear = Math.max(...u.slice(1));
  return { grip: lo, mode: front >= rear ? 'understeer' : 'oversteer', roll };
}

/** Углы поворота колёс (рад) при кривизне траектории kappa (1/м, + вправо): геометрия Аккермана вокруг задней оси. */
export function steerAngles(d: Dyn, kappa: number, out: number[] = []): number[] {
  d.wheels.forEach((w, i) => {
    if (!w.steer || d.layout.guided) {
      out[i] = 0;
      return;
    }
    const den = Math.max(0.2, 1 - kappa * w.y);
    out[i] = Math.max(-0.65, Math.min(0.65, Math.atan((kappa * (w.x - d.xRef)) / den)));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Состояние колёс на кадре

/** 0 — катится, 1 — на пределе (АБС / ограничение сцеплением), 2 — заблокировано, скользит (след юза), 3 — оторвано от дороги */
export type WheelMode = 0 | 1 | 2 | 3;

export interface WheelIn {
  /** скорость опорной точки, м/с */
  v: number;
  /** кривизна траектории, 1/м (+ вправо) */
  kappa: number;
  /** продольное замедление, м/с² (+ торможение, − разгон) */
  aBrake: number;
  /** тормоз работает на пределе сцепления */
  sat: boolean;
  /** колёса без АБС уже заблокированы */
  locked: boolean;
  /** ТС скользит (после удара или потери управляемости) */
  sliding: boolean;
  /** ТС опрокинуто */
  rolled: boolean;
}

/**
 * Считает нагрузку, режим и угол поворота вращения каждого колеса на кадре.
 * `spin` — накопленный угол качения (рад) всех колёс: на входе значения предыдущего кадра, на выходе — текущего.
 */
export function wheelFrame(d: Dyn, inp: WheelIn, mu: number, dt: number, spin: Float32Array, fz: Float32Array, st: Uint8Array): void {
  const nw = d.wheels.length;
  if (inp.rolled) {
    for (let i = 0; i < nw; i++) {
      fz[i] = 0;
      st[i] = 3;
    }
    return;
  }
  const loads = wheelLoads(d, inp.aBrake, inp.v * inp.v * inp.kappa);
  // на пределе водитель давит на педаль сильнее, чем держит шина: спрос втрое выше предельного
  const aReq = inp.sat ? 3 * mu * G : Math.max(0, inp.aBrake);
  for (let i = 0; i < nw; i++) {
    const w = d.wheels[i];
    fz[i] = loads[i];
    if (inp.sliding) {
      st[i] = inp.v > 0.3 ? 2 : 0;
      continue;
    }
    let mode: WheelMode = 0;
    if (inp.sat && inp.aBrake > 0.3) {
      const demand = w.bias * d.mass * aReq;
      if (demand > muOf(d, mu, loads[i]) * loads[i]) mode = d.layout.abs ? 1 : inp.locked ? 2 : 0;
    }
    st[i] = mode;
    if (mode === 2) continue;
    // скорость точки касания колеса: вращение вокруг мгновенного центра поворота
    const f = 1 - inp.kappa * w.y;
    const g = inp.kappa * w.x;
    const speed = inp.v * Math.sqrt(f * f + g * g);
    spin[i] += ((mode === 1 ? 0.9 : 1) * speed * dt) / d.layout.radius;
  }
}

// ---------------------------------------------------------------------------
// Сводка по ТС для интерфейса и разбора

/** Замедление ТС при экстренном торможении на покрытии, м/с². */
export function emergencyDecel(a: Actor, mu: number): number {
  const d = dynOf(a);
  if (!d) return 3;
  return brakeLimit(d, mu).peak;
}

export interface WheelRow {
  /** подпись колеса: «1Л», «2П» (ось и борт) */
  label: string;
  /** статическая нагрузка, кг */
  load: number;
  /** нагрузка при экстренном торможении, кг */
  loadBraking: number;
}

export interface WheelsReport {
  wheels: WheelRow[];
  abs: boolean;
  drive: string;
  /** масса на каждую ось, кг */
  axleLoad: number[];
  decel: number;
  decelLocked: number;
  /** остановочный путь с 50 км/ч от начала торможения, м */
  stop50: number;
  /** предельное боковое ускорение по сцеплению / до опрокидывания, м/с² */
  ayGrip: number;
  ayRoll: number;
  /** предельная скорость на повороте радиусом 30 м, км/ч */
  vTurn30: number;
  /** предельное ускорение по тяге, м/с² */
  traction: number;
  limit: 'grip' | 'roll';
  limitMode: 'understeer' | 'oversteer';
}

export function wheelReport(a: Actor, surface: SurfaceType): WheelsReport | null {
  const d = dynOf(a);
  if (!d) return null;
  const mu = SURFACES[surface].mu;
  const st = wheelLoads(d, 0, 0);
  const br = brakeLimit(d, mu);
  const stb = wheelLoads(d, br.peak, 0);
  const lat = lateralLimit(d, mu);
  const cnt = new Map<number, number>();
  const wheels = d.wheels.map((w, i) => {
    const n = (cnt.get(w.axle) ?? 0) + 1;
    cnt.set(w.axle, n);
    const side = w.y === 0 ? '' : w.y < 0 ? 'Л' : 'П';
    return { label: `${w.axle + 1}${side}${d.layout.axles[w.axle].twin ? (n % 2 ? 'в' : 'н') : ''}`, load: st[i] / G, loadBraking: stb[i] / G };
  });
  const ay = Math.min(lat.grip, lat.roll);
  const drive = d.layout.guided ? 'все оси (рельсы)' : d.wheels.every((w) => !w.drive) ? 'тяга животного' : d.wheels.every((w) => w.drive) ? 'полный' : d.layout.axles[0].drive ? 'передний' : 'задний';
  const axleLoad = d.layout.axles.map((_, i) => d.mass * d.w[i]);
  return {
    wheels,
    abs: d.layout.abs,
    drive,
    axleLoad,
    decel: br.peak,
    decelLocked: br.slide,
    stop50: (50 / 3.6) ** 2 / (2 * Math.max(0.1, br.peak)),
    ayGrip: lat.grip,
    ayRoll: lat.roll,
    vTurn30: Math.sqrt(Math.min(ay, 1e4) * 30) * 3.6,
    traction: tractionLimit(d, mu),
    limit: lat.roll < lat.grip ? 'roll' : 'grip',
    limitMode: lat.mode,
  };
}
