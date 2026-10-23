import type { DynamicControl, DynamicState, DynamicVehicleParameters, ParameterSource } from './types';
import { integrateSubstep, DYNAMIC_SUBSTEP } from './dynamics';
import { validateDynamicParameters } from './parameters';
import { planarImpact, type V2 } from './impact';
import { type Bounds, multiStart } from './optimize';
import type { Scene } from '../scene';
import type { SimulationOptions } from './extension';
import { simulate } from '../sim';

/** Observed rest pose with its stated uncertainty (1σ). Never overwritten by results. */
export interface RestEvidence {
  id: string;
  x: number;
  y: number;
  heading?: number;
  sigmaPosition: number;
  sigmaHeading?: number;
  source?: string;
}

export interface ReconVehicle {
  id: string;
  parameters: DynamicVehicleParameters;
  /** CG pose at the instant of impact (from the established impact configuration). */
  x: number;
  y: number;
  heading: number;
  /** Direction of the pre-impact velocity, rad; default = heading. */
  travelAngle?: number;
  /** Fixed pre-impact speed, m/s, when it is not a variable. */
  speed?: number;
  postImpact: 'free' | 'locked' | [boolean, boolean, boolean, boolean];
  steering?: number;
}

export type ImpactVariable = 'speed0' | 'speed1' | 'restitution' | 'contactFriction' | 'mu' | 'contactOffset';

export interface ImpactProblem {
  vehicles: [ReconVehicle, ReconVehicle];
  contact: { point: V2; normal: V2 };
  restitution: number;
  contactFriction?: number;
  mu: number;
  muSource: ParameterSource;
  variables: { name: ImpactVariable; min: number; max: number }[];
  evidence: (RestEvidence & { vehicle: 0 | 1 })[];
  seed: number;
  starts?: number;
  maxSeconds?: number;
}

const wrap = (a: number) => { let x = (a + Math.PI) % (2 * Math.PI); if (x < 0) x += 2 * Math.PI; return x - Math.PI; };

function rollOut(p: DynamicVehicleParameters, s: DynamicState, control: DynamicControl, mu: number, source: ParameterSource, maxSeconds: number): { state: DynamicState; t: number; atRest: boolean } {
  const road = { mu, source };
  let t = 0;
  while (t < maxSeconds) {
    if (!s.vx && !s.vy && !s.yawRate) return { state: s, t, atRest: true };
    s = integrateSubstep(s, p, control, road, DYNAMIC_SUBSTEP).state;
    t += DYNAMIC_SUBSTEP;
  }
  return { state: s, t, atRest: !s.vx && !s.vy && !s.yawRate };
}

/** Forward model: impulse at the given configuration, then each vehicle rolls out alone (no secondary contacts). */
export function impactForward(problem: ImpactProblem, values: Partial<Record<ImpactVariable, number>>) {
  const v = problem.vehicles;
  const speed = [values.speed0 ?? v[0].speed, values.speed1 ?? v[1].speed];
  if (speed.some(s => s === undefined)) throw new Error('Обратная задача: скорость ТС не задана и не является переменной');
  const n = problem.contact.normal, t = { x: -n.y, y: n.x }, off = values.contactOffset ?? 0;
  const point = { x: problem.contact.point.x + off * t.x, y: problem.contact.point.y + off * t.y };
  const body = (i: 0 | 1) => {
    const a = v[i].travelAngle ?? v[i].heading;
    return { mass: v[i].parameters.body.mass, yawInertia: v[i].parameters.body.yawInertia, position: { x: v[i].x, y: v[i].y },
      velocity: { x: speed[i]! * Math.cos(a), y: speed[i]! * Math.sin(a) }, yawRate: 0, heading: v[i].heading };
  };
  const impact = planarImpact({ a: body(0), b: body(1), point, normal: n, restitution: values.restitution ?? problem.restitution,
    contactFriction: values.contactFriction ?? problem.contactFriction });
  const mu = values.mu ?? problem.mu;
  const rest = ([0, 1] as const).map(i => {
    const out = i === 0 ? impact.a : impact.b;
    const s: DynamicState = { x: v[i].x, y: v[i].y, heading: v[i].heading, vx: out.velocity.x, vy: out.velocity.y, yawRate: out.yawRate, ax: 0, ay: 0 };
    const w = v[i].postImpact;
    const control: DynamicControl = { steering: v[i].steering ?? 0, drive: 0, brake: 0,
      ...(w === 'free' ? {} : { wheelLock: w === 'locked' ? [true, true, true, true] : [...w] as [boolean, boolean, boolean, boolean] }) };
    return rollOut(v[i].parameters, s, control, mu, problem.muSource, problem.maxSeconds ?? 15);
  });
  return { impact, rest };
}

function residuals(evidence: (RestEvidence & { pred: { x: number; y: number; heading: number } })[]) {
  return evidence.map(e => {
    const rx = (e.pred.x - e.x) / e.sigmaPosition, ry = (e.pred.y - e.y) / e.sigmaPosition;
    const rh = e.heading !== undefined && e.sigmaHeading ? wrap(e.pred.heading - e.heading) / e.sigmaHeading : 0;
    return { id: e.id, predicted: e.pred, observed: { x: e.x, y: e.y, heading: e.heading ?? null },
      dx: e.pred.x - e.x, dy: e.pred.y - e.y, dHeading: e.heading !== undefined ? wrap(e.pred.heading - e.heading) : null,
      normalized: [rx, ry, rh], cost: rx * rx + ry * ry + rh * rh, weights: { position: 1 / e.sigmaPosition ** 2, heading: e.sigmaHeading ? 1 / e.sigmaHeading ** 2 : 0 } };
  });
}

function validateEvidence(evidence: RestEvidence[]): void {
  if (!evidence.length) throw new Error('Обратная задача: нет наблюдений');
  for (const e of evidence) {
    if (![e.x, e.y].every(Number.isFinite) || !(e.sigmaPosition > 0)) throw new Error(`Наблюдение ${e.id}: координаты и σ > 0`);
    if (e.heading !== undefined && !(e.sigmaHeading! > 0)) throw new Error(`Наблюдение ${e.id}: для курса нужна σ`);
  }
}

export interface InverseResult {
  variables: Record<string, number>;
  cost: number;
  residuals: ReturnType<typeof residuals>;
  alternatives: { variables: Record<string, number>; cost: number }[];
  evaluations: number;
  seed: number;
  method: string;
  assumptions: string[];
}

/**
 * Seeded multi-start Nelder–Mead: minimises Σ((pred−obs)/σ)² over the rest
 * poses. Evidence and the scene are never modified; alternatives with a close
 * cost are reported (ambiguity).
 */
export function reconstructImpact(problem: ImpactProblem): InverseResult {
  problem.vehicles.forEach(v => validateDynamicParameters(v.parameters));
  validateEvidence(problem.evidence);
  if (!problem.variables.length) throw new Error('Обратная задача: нет неизвестных');
  const bounds: Bounds[] = problem.variables.map(v => ({ name: v.name, min: v.min, max: v.max }));
  for (const b of bounds) if (!(b.min < b.max)) throw new Error(`Переменная ${b.name}: min < max`);
  const toValues = (x: number[]) => Object.fromEntries(bounds.map((b, i) => [b.name, x[i]])) as Partial<Record<ImpactVariable, number>>;
  const predict = (x: number[]) => {
    const f = impactForward(problem, toValues(x));
    return problem.evidence.map(e => ({ ...e, pred: { x: f.rest[e.vehicle].state.x, y: f.rest[e.vehicle].state.y, heading: f.rest[e.vehicle].state.heading } }));
  };
  const cost = (x: number[]) => residuals(predict(x)).reduce((s, r) => s + r.cost, 0);
  const opt = multiStart(cost, bounds, problem.seed, { starts: problem.starts ?? 6 });
  return {
    variables: toValues(opt.best.x) as Record<string, number>, cost: opt.best.cost, residuals: residuals(predict(opt.best.x)),
    alternatives: opt.alternatives.map(a => ({ variables: toValues(a.x) as Record<string, number>, cost: a.cost })),
    evaluations: opt.runs.reduce((s, r) => s + r.evaluations, 0), seed: problem.seed, method: 'seeded multi-start Nelder–Mead, weighted least squares',
    assumptions: ['Конфигурация удара (позы ЦМ, точка и нормаль контакта) задана как установленная; после удара ТС движутся без повторных контактов.',
      'Вес наблюдения — 1/σ² по заявленной погрешности; невязка приводится по каждому наблюдению.',
      'Альтернативные решения с близкой невязкой сохраняются как неоднозначность; исходные наблюдения не изменяются.'],
  };
}

export interface SceneProblem {
  scene: Scene;
  options?: SimulationOptions;
  /** Unknown initial speeds (km/h, scene convention); the sign of the authored speed is kept. */
  variables: { actorId: string; min: number; max: number }[];
  evidence: (RestEvidence & { actorId: string })[];
  seed: number;
  starts?: number;
}

/** Same estimator with the full scene simulation as forward model; the input scene is cloned, never changed. */
export function reconstructScene(problem: SceneProblem): InverseResult {
  validateEvidence(problem.evidence);
  const bounds: Bounds[] = problem.variables.map(v => ({ name: `${v.actorId}.speed`, min: v.min, max: v.max }));
  const frozen = JSON.stringify(problem.scene);
  const run = (x: number[]) => {
    const s = JSON.parse(frozen) as Scene;
    problem.variables.forEach((v, i) => {
      const a = s.actors.find(q => q.id === v.actorId);
      if (!a) throw new Error(`Обратная задача: нет участника ${v.actorId}`);
      a.speed = Math.sign(a.speed || 1) * x[i];
    });
    const tl = simulate(s, problem.options);
    return problem.evidence.map(e => {
      const tr = tl.tracks.get(e.actorId)!, k = tl.n - 1;
      return { ...e, pred: { x: tr.x[k], y: tr.y[k], heading: tr.h[k] } };
    });
  };
  const cost = (x: number[]) => residuals(run(x)).reduce((s, r) => s + r.cost, 0);
  const opt = multiStart(cost, bounds, problem.seed, { starts: problem.starts ?? 4, maxEvaluations: 120 * bounds.length });
  const vals = (x: number[]) => Object.fromEntries(bounds.map((b, i) => [b.name, x[i]]));
  return {
    variables: vals(opt.best.x), cost: opt.best.cost, residuals: residuals(run(opt.best.x)),
    alternatives: opt.alternatives.map(a => ({ variables: vals(a.x), cost: a.cost })),
    evaluations: opt.runs.reduce((s, r) => s + r.evaluations, 0), seed: problem.seed, method: 'seeded multi-start Nelder–Mead over the scene simulation',
    assumptions: ['Неизвестные — начальные скорости участников; остальные входы сцены неизменны.', 'Вес наблюдения — 1/σ²; невязка по каждому наблюдению.',
      'Исходная сцена копируется и не изменяется; результат — отдельная запись расчёта.'],
  };
}
