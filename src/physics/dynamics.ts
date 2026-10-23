import type { DynamicControl, DynamicRoad, DynamicState, DynamicStepTrace, DynamicVehicleParameters, ForceEvaluation, WheelForce, WheelId } from './types';
import { finite, validateDynamicParameters, validateSource } from './parameters';
import { dugoffTyre, elasticDemand, lockedTyre } from './tyre';
import { dm } from '../dmath';

export const GRAVITY = 9.81;
export const DYNAMIC_FRAME_DT = 0.025;
export const DYNAMIC_SUBSTEP = 0.005;
/** Numerical regularisation, not a measured tyre or driver parameter. */
export const LOW_SPEED = 0.1;
/** Numerical zero only after passive dissipation; not applied to force-free motion. */
export const REST_EPSILON = 1e-10;
/** Ideal force regulator approaches Dugoff's asymptote, which has no finite-slip peak. */
export const IDEAL_GRIP_FRACTION = 0.999;

export const DYNAMICS_LIMITATIONS = [
  'Плоская жёсткая модель: без подвески, опрокидывания и аэродинамики. Сопротивление качению — только явно заданное; уклон — только измеренная плоскость зоны, координаты как развёртка поверхности.',
  'Квазистатический привод: нет вращательной инерции колёс, коробки передач и гидравлики тормозов.',
  'ABS ideal — идеальное ограничение сил, не модель аппаратного ABS; неизвестный ABS не считается выключенным.',
  'Перенос нагрузки использует ускорение предыдущего подшага и явно заданную долю момента крена.',
  'Ниже 0.1 м/с угловое скольжение регуляризовано; импульс ограничен по пассивной энергии, это не измеренная шина.',
  'Dugoff с постоянным mu: без падения сцепления со скоростью скольжения, температурой или нагрузкой.',
  'Подъём колеса помечается; расчёт после потери контакта не моделирует пространственное движение.',
  'Натурная валидация конкретных ТС/ДТП отсутствует.',
];

export function bodyVelocity(s: DynamicState): { u: number; v: number } {
  const c = dm.cos(s.heading), sn = dm.sin(s.heading);
  return { u: c * s.vx + sn * s.vy, v: -sn * s.vx + c * s.vy };
}

export function kineticEnergy(s: DynamicState, p: DynamicVehicleParameters): number {
  return (p.body.mass * (s.vx ** 2 + s.vy ** 2) + p.body.yawInertia * s.yawRate ** 2) / 2;
}

/** Four normal loads in FL, FR, RL, RR order; sum is always m*g. */
export function normalLoads(p: DynamicVehicleParameters, ax: number, ay: number, slopeWeight?: number): { loads: number[]; wheelLift: boolean } {
  const b = p.body, weight = slopeWeight ?? b.mass * GRAVITY;
  // On a grade, ax/ay are tyre specific forces (tyre force/m); gravity acts at
  // the CG and adds no pitch/roll moment about it. Flat-road expression unchanged.
  const frontRaw = slopeWeight === undefined ? b.mass * (GRAVITY * b.lr - ax * b.cgHeight) / (b.lf + b.lr)
    : (slopeWeight * b.lr - b.mass * ax * b.cgHeight) / (b.lf + b.lr);
  const front = Math.max(0, Math.min(weight, frontRaw)), rear = weight - front;
  const roll = b.mass * ay * b.cgHeight;
  const df = roll * p.loadTransfer.frontRollFraction / b.trackFront;
  const dr = roll * (1 - p.loadTransfer.frontRollFraction) / b.trackRear;
  const fl = Math.max(0, Math.min(front, front / 2 + df));
  const rl = Math.max(0, Math.min(rear, rear / 2 + dr));
  return { loads: [fl, front - fl, rl, rear - rl], wheelLift: frontRaw <= 0 || frontRaw >= weight || Math.abs(df) >= front / 2 || Math.abs(dr) >= rear / 2 };
}

function validateState(s: DynamicState): void {
  for (const key of ['x', 'y', 'heading', 'vx', 'vy', 'yawRate', 'ax', 'ay'] as const) finite(s[key], key);
}

function validateControlRoad(c: DynamicControl, road: DynamicRoad, p: DynamicVehicleParameters): void {
  finite(c.steering, 'steering', -Math.PI / 3, Math.PI / 3);
  finite(c.drive, 'drive', -1, 1);
  finite(c.brake, 'brake', 0, 1);
  finite(road.mu, 'mu', 0);
  validateSource(road.source);
  if (c.drive !== 0 && c.brake !== 0) throw new Error('Динамика: одновременный привод и тормоз не поддержаны');
  if (c.brake && p.brakes.abs === 'unknown') throw new Error('Динамика: для торможения явно задайте ABS');
  if (c.wheelLock !== undefined && (!Array.isArray(c.wheelLock) || c.wheelLock.length !== 4
    || c.wheelLock.some(v => typeof v !== 'boolean'))) throw new Error('Динамика: wheelLock — четыре логических значения FL, FR, RL, RR');
  if (road.wheelMu !== undefined) {
    if (!Array.isArray(road.wheelMu) || road.wheelMu.length !== 4) throw new Error('Динамика: wheelMu — четыре значения FL, FR, RL, RR');
    road.wheelMu.forEach(mu => finite(mu, 'wheelMu', 0));
  }
  if (road.grade !== undefined) {
    finite(road.grade.x, 'grade.x', -1, 1);
    finite(road.grade.y, 'grade.y', -1, 1);
    validateSource(road.grade.source);
  }
}

function validateInputs(s: DynamicState, c: DynamicControl, road: DynamicRoad, p: DynamicVehicleParameters): void {
  validateState(s);
  validateControlRoad(c, road, p);
}

function forces(s: DynamicState, p: DynamicVehicleParameters, control: DynamicControl, road: DynamicRoad, slopeWeight?: number): ForceEvaluation {
  const { u, v } = bodyVelocity(s);
  const b = p.body, tyres = p.tyres;
  const { loads, wheelLift } = normalLoads(p, s.ax, s.ay, slopeWeight);
  const positions: [WheelId, number, number][] = [
    ['front-left', b.lf, -b.trackFront / 2], ['front-right', b.lf, b.trackFront / 2],
    ['rear-left', -b.lr, -b.trackRear / 2], ['rear-right', -b.lr, b.trackRear / 2],
  ];
  const wheels = positions.map(([id, x, y], index): WheelForce => {
    const mu = road.wheelMu?.[index] ?? road.mu;
    const muX = mu * tyres.frictionScaleX, muY = mu * tyres.frictionScaleY;
    const front = index < 2, delta = front ? control.steering : 0;
    const cs = dm.cos(delta), sn = dm.sin(delta);
    const ux = u - s.yawRate * y, uy = v + s.yawRate * x;
    const vx = cs * ux + sn * uy, vy = -sn * ux + cs * uy;
    const direction = (vx < 0 ? -1 : 1) as 1 | -1;
    const normalLoad = loads[index];
    const capacity = muX * normalLoad;
    const tanAlpha = vy / Math.max(Math.abs(vx), LOW_SPEED);
    const driveShare = p.drive.axle === 'all' ? 0.25 : (front === (p.drive.axle === 'front') ? 0.5 : 0);
    const brakeShare = (front ? p.brakes.frontFraction : 1 - p.brakes.frontFraction) / 2;
    const brakeDemand = control.brake * p.brakes.maxForce * brakeShare;
    const longitudinalDemand = control.drive * p.drive.maxForce * driveShare - Math.sign(vx) * brakeDemand;
    let fx = 0, fy = 0, kappa: number | null = 0, lambda: number | null = null;
    let mode: WheelForce['mode'] = 'rolling';
    if (!capacity || !muY) {
      mode = 'unloaded';
    } else if (control.wheelLock?.[index] || brakeDemand >= capacity && p.brakes.abs === 'disabled') {
      // Locked tyres obey the maximum-dissipation friction ellipse. This is an
      // explicit branch, not mislabeled as finite-slip Dugoff or real ABS.
      ({ fx, fy } = lockedTyre(vx, vy, normalLoad, muX, muY));
      mode = 'locked';
      kappa = null;
    } else {
      const demand = direction * longitudinalDemand;
      const target = Math.max(-capacity * IDEAL_GRIP_FRACTION, Math.min(capacity * IDEAL_GRIP_FRACTION, demand));
      let qx = elasticDemand(target, capacity);
      // Positive kappa has qx<Cx. This traction limit follows from the declared
      // slip convention; excessive motor demand cannot bypass the tyre model.
      qx = Math.min(qx, tyres.longitudinalStiffness * IDEAL_GRIP_FRACTION);
      kappa = qx / (tyres.longitudinalStiffness - qx);
      ({ fx, fy, lambda } = dugoffTyre({
        kappa, tanAlpha, direction, normalLoad, muX, muY,
        longitudinalStiffness: tyres.longitudinalStiffness,
        corneringStiffness: front ? tyres.corneringStiffnessFront : tyres.corneringStiffnessRear,
      }));
      if (p.rollingResistance) {
        // Explicit passive rolling resistance, saturated below LOW_SPEED; the
        // energy-limited impulse below prevents it from reversing motion.
        fx -= p.rollingResistance.coefficient * normalLoad * Math.max(-1, Math.min(1, vx / LOW_SPEED));
      }
    }
    const bodyFx = cs * fx - sn * fy, bodyFy = sn * fx + cs * fy;
    return { id, x, y, normalLoad, vx, vy, fx, fy, bodyFx, bodyFy,
      moment: x * bodyFy - y * bodyFx, longitudinalDemand, kappa, tanAlpha, lambda, mode,
      ellipseUse: capacity && muY ? dm.hypot(fx / capacity, fy / (muY * normalLoad)) : 0,
      power: fx * vx + fy * vy };
  });
  return { fx: wheels.reduce((v, w) => v + w.bodyFx, 0), fy: wheels.reduce((v, w) => v + w.bodyFy, 0),
    moment: wheels.reduce((v, w) => v + w.moment, 0), wheels, wheelLift };
}

/** Evaluate without a route or a controller. The result is inspectable in wheel and body axes. */
export function evaluateForces(s: DynamicState, p: DynamicVehicleParameters, control: DynamicControl, road: DynamicRoad): ForceEvaluation {
  validateDynamicParameters(p);
  validateInputs(s, control, road, p);
  return forces(s, p, control, road, slopeOf(p, road).weight);
}

/** World slope force and normal weight; no change of the flat-road expressions. */
export function slopeOf(p: DynamicVehicleParameters, road: DynamicRoad): { gx: number; gy: number; weight?: number } {
  if (!road.grade || !road.grade.x && !road.grade.y) return { gx: 0, gy: 0 };
  const k = Math.sqrt(1 + road.grade.x ** 2 + road.grade.y ** 2), w = p.body.mass * GRAVITY;
  return { gx: -w * road.grade.x / k, gy: -w * road.grade.y / k, weight: w / k };
}

/**
 * Static hold on a slope at rest. Aggregate body-axis ellipse: braked or locked
 * wheels resist along x up to min(demand, muX*Fz), every loaded wheel resists
 * laterally up to muY*Fz. Static mu is taken equal to the supplied mu (assumption).
 */
export function staticHold(s: DynamicState, p: DynamicVehicleParameters, control: DynamicControl, road: DynamicRoad): boolean {
  const g = slopeOf(p, road);
  if (!g.gx && !g.gy) return true;
  if (control.drive !== 0) return false;
  const c = dm.cos(s.heading), sn = dm.sin(s.heading), m = p.body.mass;
  const gxBody = c * g.gx + sn * g.gy, gyBody = -sn * g.gx + c * g.gy;
  const { loads } = normalLoads(p, -gxBody / m, -gyBody / m, g.weight);
  let fxCap = 0, fyCap = 0;
  loads.forEach((load, i) => {
    const mu = road.wheelMu?.[i] ?? road.mu;
    const muX = mu * p.tyres.frictionScaleX, muY = mu * p.tyres.frictionScaleY;
    const share = (i < 2 ? p.brakes.frontFraction : 1 - p.brakes.frontFraction) / 2;
    const demand = control.brake * p.brakes.maxForce * share;
    fxCap += control.wheelLock?.[i] ? muX * load : Math.min(demand, muX * load);
    fyCap += muY * load;
  });
  const rx = gxBody ? (fxCap ? gxBody / fxCap : Infinity) : 0;
  const ry = gyBody ? (fyCap ? gyBody / fyCap : Infinity) : 0;
  return rx * rx + ry * ry <= 1;
}

export interface SubstepResult {
  state: DynamicState;
  forces: ForceEvaluation;
  impulseScale: number;
  motionSeconds: number;
  energyBefore: number;
  energyAfter: number;
  staticHold: boolean;
  gravity?: { x: number; y: number };
}

/**
 * One fixed substep. Parameters must already be validated; control/road are
 * validated here because a scene runner may change them inside a frame.
 */
export function integrateSubstep(state: DynamicState, p: DynamicVehicleParameters, control: DynamicControl,
  road: DynamicRoad, dt: number): SubstepResult {
  validateInputs(state, control, road, p);
  finite(dt, 'substepSeconds', 0.0001, DYNAMIC_SUBSTEP);
  const g = slopeOf(p, road);
  const sloped = g.weight !== undefined;
  const energyBefore = kineticEnergy(state, p);
  const atRest = !state.vx && !state.vy && !state.yawRate;
  if (sloped && atRest && staticHold(state, p, control, road)) {
    const f = forces(state, p, control, road, g.weight);
    const c = dm.cos(state.heading), sn = dm.sin(state.heading), m = p.body.mass;
    // Tyres balance the slope force; their specific force drives load transfer.
    const held = { ...state, ax: -(c * g.gx + sn * g.gy) / m, ay: -(-sn * g.gx + c * g.gy) / m };
    return { state: held, forces: f, impulseScale: 0, motionSeconds: 0, energyBefore,
      energyAfter: energyBefore, staticHold: true, gravity: { x: g.gx, y: g.gy } };
  }
  const f = forces(state, p, control, road, g.weight);
  const cs = dm.cos(state.heading), sn = dm.sin(state.heading);
  const fx = cs * f.fx - sn * f.fy, fy = sn * f.fx + cs * f.fy;
  const power = fx * state.vx + fy * state.vy + f.moment * state.yawRate;
  const q = (fx ** 2 + fy ** 2) / p.body.mass + f.moment ** 2 / p.body.yawInertia;
  const scale = power < 0 && q > 0 ? Math.min(1, -power / (dt * q)) : 1;
  let vx = state.vx + dt * scale * fx / p.body.mass;
  let vy = state.vy + dt * scale * fy / p.body.mass;
  let yawRate = state.yawRate + dt * scale * f.moment / p.body.yawInertia;
  const tyreStopped = power < 0 && control.drive === 0 && dm.hypot(vx, vy) < REST_EPSILON && Math.abs(yawRate) < REST_EPSILON;
  let stopped = tyreStopped;
  let held = false;
  if (sloped) {
    if (tyreStopped && staticHold(state, p, control, road)) held = true;
    else {
      // The conservative slope force is not part of the passive energy limit.
      stopped = false;
      vx += dt * g.gx / p.body.mass;
      vy += dt * g.gy / p.body.mass;
    }
  }
  if (stopped) {
    vx = 0; vy = 0; yawRate = 0;
  }
  // When all motion stops inside a step, integrate only to the stopping
  // event, then hold. Using the full dt would overstate low-speed distance.
  const motionSeconds = stopped ? dt * scale : dt;
  const heading = state.heading + motionSeconds * (state.yawRate + yawRate) / 2;
  // ax/ay store tyre specific force (inertial acceleration on a flat road).
  const axWorld = scale * fx / p.body.mass, ayWorld = scale * fy / p.body.mass;
  const next = {
    x: state.x + motionSeconds * (state.vx + vx) / 2, y: state.y + motionSeconds * (state.vy + vy) / 2,
    heading, vx, vy, yawRate,
    ax: dm.cos(heading) * axWorld + dm.sin(heading) * ayWorld,
    ay: -dm.sin(heading) * axWorld + dm.cos(heading) * ayWorld,
  };
  return { state: next, forces: f, impulseScale: scale, motionSeconds, energyBefore, energyAfter: kineticEnergy(next, p),
    staticHold: held, ...(sloped ? { gravity: { x: g.gx, y: g.gy } } : {}) };
}

/**
 * Fixed-step impulse integration in inertial axes; trapezoidal pose update.
 * A passive generalized force may not reverse motion along its own impulse:
 * scale=min(1,-P/(dt*Q)), Q=|F|²/m+Mz²/Iz. Then deltaE=dt*scale*P+
 * dt²*scale²*Q/2 <=0. This numerical stopping treatment never increases mu.
 * control/road may be per-substep functions (actuator delay, zone boundaries).
 */
export type ControlInput = DynamicControl | ((substep: number, state: DynamicState, seconds: number) => DynamicControl);
export type RoadInput = DynamicRoad | ((state: DynamicState) => DynamicRoad);

export function stepDynamics(initial: DynamicState, p: DynamicVehicleParameters, controlInput: ControlInput,
  roadInput: RoadInput, options: { substepSeconds?: number; trace?: boolean } = {}): { state: DynamicState; trace?: DynamicStepTrace } {
  validateDynamicParameters(p);
  validateState(initial);
  const dt = options.substepSeconds ?? DYNAMIC_SUBSTEP;
  finite(dt, 'substepSeconds', 0.0001, DYNAMIC_SUBSTEP);
  const count = Math.round(DYNAMIC_FRAME_DT / dt);
  if (Math.abs(count * dt - DYNAMIC_FRAME_DT) > 1e-12) throw new Error('Динамика: подшаг должен делить 25 мс без остатка');
  const controlAt = (i: number, s: DynamicState): DynamicControl => typeof controlInput === 'function' ? controlInput(i, s, i * dt) : controlInput;
  const roadAt = (s: DynamicState): DynamicRoad => typeof roadInput === 'function' ? roadInput(s) : roadInput;
  const control0 = controlAt(0, initial), road0 = roadAt(initial);
  validateControlRoad(control0, road0, p);
  const varying = typeof controlInput === 'function' || typeof roadInput === 'function';
  const trace: DynamicStepTrace | undefined = options.trace ? {
    method: 'four-wheel-dugoff-quasistatic-v1',
    units: { position: 'm', velocity: 'm/s', acceleration: 'm/s²', heading: 'rad', yawRate: 'rad/s', mass: 'kg', inertia: 'kg m²', force: 'N', moment: 'N m', energy: 'J', power: 'W', time: 's', grade: '1 (dz/dx)' },
    formulas: {
      motion: 'm*dV_world/dt=R(heading)*sum(F_body)+G; Iz*dr/dt=sum(x*Fy-y*Fx)',
      loads: 'Fzf=(W*lr-m*ax*h)/(lf+lr), W=m*g/sqrt(1+|grad z|²) (m*g flat); Fzr=W-Fzf; dFz_front=m*ay*h*frontRollFraction/trackFront',
      tyre: 'qx=Cx*kappa/(1+kappa); qy=-Ca*tanAlpha/(1+kappa); lambda=1/(2*hypot(qx/(muX*Fz),qy/(muY*Fz))); f=lambda<1?lambda*(2-lambda):1',
      energy: 'E=(m*(vx²+vy²)+Iz*r²)/2; scale=min(1,-P/(dt*(|F|²/m+Mz²/Iz))) for P<0',
      slope: 'G=-m*g*grad z/sqrt(1+|grad z|²); coordinates are distances along the surface (developed plane)',
      rolling: 'Fx_rr=-c_rr*Fz*sat(vx/0.1 m/s) per rolling wheel, only when rollingResistance is supplied',
    },
    sources: [p.body.source, p.body.bodyCenterSource, p.tyres.source, p.brakes.source, p.drive.source, p.loadTransfer.source, road0.source,
      ...(road0.grade ? [road0.grade.source] : []), ...(p.rollingResistance ? [p.rollingResistance.source] : []),
      { kind: 'reference', description: 'Brandt 2007, §§2.2.2, 2.3–2.4; constant-mu envelope with explicit slip conversion', url: 'https://digital.ub.uni-paderborn.de/hsmig/download/pdf/5000' }],
    parameters: structuredClone(p), road: structuredClone(road0), control: structuredClone(control0), initial: { ...initial },
    substepSeconds: dt, substeps: [], limitations: [...DYNAMICS_LIMITATIONS],
  } : undefined;
  let state = { ...initial };
  for (let step = 0; step < count; step++) {
    const control = step ? controlAt(step, state) : control0;
    const road = step ? roadAt(state) : road0;
    const r = integrateSubstep(state, p, control, road, dt);
    state = r.state;
    if (trace) trace.substeps.push({ state: { ...state }, forces: r.forces, impulseScale: r.impulseScale, motionSeconds: r.motionSeconds,
      energyBefore: r.energyBefore, energyAfter: r.energyAfter,
      ...(varying ? { road: structuredClone(road), control: structuredClone(control) } : {}),
      ...(r.staticHold ? { staticHold: true } : {}), ...(r.gravity ? { gravity: r.gravity } : {}) });
  }
  return { state, ...(trace ? { trace } : {}) };
}
