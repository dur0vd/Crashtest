/**
 * Headless physics port (shared contract v1). Uses only the contract types, the
 * physics/expert/video-math modules and the existing scene simulator. The input
 * project is never mutated; calculated observations carry their own provenance.
 */
import type {
  CalculationRecord, EvidenceObservation, FeatureDescriptor, FeatureIssue, FeatureResult, InputDescriptor, JsonObject, JsonValue,
  PhysicsOutput, PhysicsPort, ProjectEnvelope, RunControl,
} from '../parallel/contracts';
import { cloneScene, type Scene } from '../scene';
import { PhysicsUnsupportedError, dynamicMotionMethod, simulate, type Timeline } from '../sim';
import type { BrakingParameters, SimulationOptions, VehiclePhysicsInput } from './extension';
import { validateDynamicParameters } from './parameters';
import { CALCULATORS, toDescriptors } from '../expert/calc';
import { assessAvoidability, yellowServiceStop } from '../expert/stopping';
import { brakeTiming, reactionTime, steadyDeceleration, type ExpertValue, type UserValue } from '../expert/params';
import { hazardMoments, visibilityTimeline, type VisibilityOptions } from '../expert/hazard';
import { MC_MODELS, runMonteCarlo, type MonteCarloResult, type MonteCarloSpec } from './montecarlo';

/** Optional Monte Carlo executor (e.g. a Web Worker); must reproduce runMonteCarlo for the same spec.
 * A cancellation without a partial result rejects with an Error named 'AbortError'. */
export type MonteCarloRunner = (spec: MonteCarloSpec, control?: RunControl) => Promise<MonteCarloResult>;
import { reconstructImpact, reconstructScene, type ImpactProblem } from './inverse';
import { averageSpeed, carrierSpeed, fitHomography, fitTrajectory, imageToPlane, type Correspondence, type Homography } from '../video-math';
import { analyzeTechnical } from '../analysis/technical';
import type { DynamicVehicleParameters } from './types';

export const PHYSICS_METHOD_IDS = [
  'expert.braking', 'expert.skid', 'expert.lateral', 'expert.critical-speed', 'expert.throw', 'expert.momentum', 'expert.ees',
  'reconstruction.inverse', 'reconstruction.monte-carlo', 'video.homography', 'video.trajectory', 'visibility.assess',
] as const;

const json = <T>(v: T): JsonValue => JSON.parse(JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? Array.from(x as unknown as ArrayLike<number>) : x))) as JsonValue;
const isObj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const issue = (code: string, message: string, path?: string): FeatureIssue => ({ code, message, ...(path ? { path } : {}) });

/** Reads extensions.physics into simulation options and per-actor dynamics; never mutates the project. */
export function physicsInputs(project: ProjectEnvelope): { scene: Scene; options: SimulationOptions; issues: FeatureIssue[] } {
  const ext = (project.extensions?.physics ?? {}) as JsonObject;
  const scene = cloneScene(project.scene);
  const issues: FeatureIssue[] = [];
  const vehicles: Record<string, VehiclePhysicsInput> = {};
  const vulnerable: SimulationOptions['vulnerable'] = {};
  if (isObj(ext.vehicles)) for (const [id, raw] of Object.entries(ext.vehicles)) {
    if (!isObj(raw)) continue;
    const actor = scene.actors.find(a => a.id === id);
    const path = `/extensions/physics/vehicles/${id}`;
    if (!actor) { issues.push(issue('unknown-actor', `Параметры для отсутствующего участника ${id}`, path)); continue; }
    if (isObj(raw.dynamics)) {
      if (actor.dynamics && JSON.stringify(actor.dynamics) !== JSON.stringify(raw.dynamics)) {
        issues.push(issue('ambiguous-parameters', `${id}: параметры динамики заданы и в сцене, и в extensions.physics с разными значениями`, `${path}/dynamics`));
      } else {
        try { validateDynamicParameters(raw.dynamics as unknown as DynamicVehicleParameters); actor.dynamics = structuredClone(raw.dynamics) as unknown as DynamicVehicleParameters; }
        catch (e) { issues.push(issue('invalid-input', e instanceof Error ? e.message : String(e), `${path}/dynamics`)); }
      }
    }
    const v: VehiclePhysicsInput = {};
    for (const key of ['braking', 'controller', 'hazard', 'postImpact', 'impact'] as const) if (isObj(raw[key])) (v as Record<string, unknown>)[key] = structuredClone(raw[key]);
    if (Object.keys(v).length) vehicles[id] = v;
    for (const key of ['throw', 'twoWheeler'] as const) if (isObj(raw[key])) (vulnerable[id] ??= {})[key] = structuredClone(raw[key]) as never;
  }
  const options: SimulationOptions = {
    ...(Array.isArray(ext.zones) ? { zones: structuredClone(ext.zones) as unknown as SimulationOptions['zones'] } : {}),
    ...(Array.isArray(ext.barriers) ? { barriers: structuredClone(ext.barriers) as unknown as SimulationOptions['barriers'] } : {}),
    ...(isObj(ext.impact) ? { impact: structuredClone(ext.impact) as unknown as SimulationOptions['impact'] } : {}),
    ...(isObj(ext.vulnerableImpact) ? { vulnerableImpact: structuredClone(ext.vulnerableImpact) as unknown as SimulationOptions['vulnerableImpact'] } : {}),
    ...(Object.keys(vehicles).length ? { vehicles } : {}),
    ...(Object.keys(vulnerable).length ? { vulnerable } : {}),
  };
  return { scene, options, issues };
}

function unsupportedFrom(error: unknown, scene: Scene): FeatureResult<never> {
  if (error instanceof PhysicsUnsupportedError) {
    return { status: 'unsupported', issues: error.issues.map(i => {
      const idx = scene.actors.findIndex(a => a.id === i.actorId);
      return issue(i.code, `${i.actorId}: ${i.message}`, idx >= 0 ? `/scene/actors/${idx}` : undefined);
    }) };
  }
  return { status: 'error', issues: [issue('invalid-input', error instanceof Error ? error.message : String(error))] };
}

function renderData(tl: Timeline): JsonObject {
  const actors: JsonObject = {};
  for (const [id, tr] of tl.tracks) if (tr.dynamics) {
    const d = tr.dynamics;
    actors[id] = json({ wheels: { order: ['front-left', 'front-right', 'rear-left', 'rear-right'], normalLoadN: d.wheelLoad, fxN: d.wheelFx, fyN: d.wheelFy,
      ellipseUse: d.wheelUse, mode: d.wheelMode, modeLegend: ['rolling', 'locked', 'unloaded'] },
      sideslipRad: d.sideslip, steeringRad: d.steering, drive: d.drive, brake: d.brake, mu: d.mu, muKnown: d.muKnown, zone: d.zone, staticHold: d.staticHold }) as JsonObject;
  }
  return { frames: tl.n, dt: tl.dt, actors, riders: json(tl.physics?.riders ?? {}), rest: json(tl.physics?.rest ?? {}),
    zones: json(tl.physics?.zones ?? []), barriers: json(tl.physics?.barriers ?? []),
    note: 'Данные расчёта для отрисовки колёс, сил, заноса и конечных поз; UI не выполняет вторую симуляцию.' };
}

function collisionRecords(tl: Timeline): CalculationRecord[] {
  return tl.collisions.filter(c => c.impact).map(c => ({
    id: `physics.impact.${c.idx}`, method: 'physics.impact',
    inputs: { a: c.a, b: c.b, t: c.t, point: json(c.point), normal: json(c.n), restitution: c.impact!.restitution,
      ...(c.impact!.contactFriction !== undefined ? { contactFriction: c.impact!.contactFriction } : {}) } as JsonObject,
    formula: Object.values(c.impact!.first.formulas).join('; '),
    result: json({ target: c.impact!.target, sequence: c.impact!.sequence, mode: c.impact!.mode, impulses: c.impact!.impulses, impulse: c.impact!.impulse,
      deltaVA: c.impact!.deltaVA, deltaVB: c.impact!.deltaVB, dvA: c.dvA, dvB: c.dvB, deltaYawRateA: c.impact!.deltaYawRateA, deltaYawRateB: c.impact!.deltaYawRateB,
      pdofA: c.impact!.pdofA ?? null, clockA: c.impact!.clockA ?? null, pdofB: c.impact!.pdofB ?? null, clockB: c.impact!.clockB ?? null,
      energyLoss: c.impact!.energyLoss, energyNormal: c.impact!.energyNormal, energyTangential: c.impact!.energyTangential, energyIncrease: c.impact!.energyIncrease }),
    units: json(c.impact!.first.units) as JsonObject,
    sources: [c.impact!.settingsSource.description, ...c.impact!.first.sources.map(s => s.description)],
    assumptions: c.impact!.first.assumptions,
  }));
}

function observationsOf(tl: Timeline): EvidenceObservation[] {
  const out: EvidenceObservation[] = [];
  for (const [id, r] of Object.entries(tl.physics?.rest ?? {})) {
    out.push({ id: `calc-rest-${id}`, kind: 'calculated-rest-pose', geometry: { x: r.x, y: r.y, heading: r.heading }, values: { actorId: id, atRest: r.atRest },
      source: 'physics.simulate (рассчитано, не наблюдение)' });
  }
  for (const c of tl.collisions) out.push({ id: `calc-impact-${c.idx}`, kind: 'calculated-impact', geometry: { x: c.point.x, y: c.point.y },
    values: { a: c.a, b: c.b, t: c.t, dvA: c.dvA, dvB: c.dvB }, source: 'physics.simulate (рассчитано, не наблюдение)' });
  return out;
}

// ---------------------------------------------------------------------------

function descriptorsForSimulate(project: ProjectEnvelope): FeatureDescriptor {
  const { scene, issues } = physicsInputs(project);
  const inputs: InputDescriptor[] = [
    { path: '/scene/env/physics', label: 'Режим движения', kind: 'enum', choices: [{ value: 'kinematic', label: 'Кинематический (упрощённый)' }, { value: 'dynamic', label: 'Динамический (силы шин)' }] },
    { path: '/extensions/physics/zones', label: 'Измеренные зоны: контур, μ, направление, уклоны, неровность, источник', kind: 'geometry' },
    { path: '/extensions/physics/barriers', label: 'Бордюры и отбойники: ломаная, k, μc, источник', kind: 'geometry' },
    { path: '/extensions/physics/impact/restitution', label: 'Коэффициент восстановления ТС–ТС/препятствие', kind: 'number', minimum: 0, maximum: 1 },
    { path: '/extensions/physics/impact/contactFriction', label: 'Трение в плоскости контакта μc', kind: 'number', minimum: 0 },
    { path: '/extensions/physics/vulnerableImpact/restitution', label: 'Восстановление ТС–пешеход/двухколёсное', kind: 'number', minimum: 0, maximum: 1 },
  ];
  scene.actors.forEach(a => {
    const base = `/extensions/physics/vehicles/${a.id}`;
    const m = dynamicMotionMethod(a);
    if (m === 'dynamic-four-wheel' || typeof m !== 'string' && m.code !== 'unsupported-class') {
      inputs.push(
        { path: `${base}/dynamics`, label: `${a.id}: параметры динамики (масса, Iz, lf/lr, колея, ЦМ, шины, тормоза, ABS, привод, источники)`, kind: 'geometry', required: true },
        { path: `${base}/braking/t2/value`, label: `${a.id}: запаздывание привода t2`, kind: 'number', unit: 's', minimum: 0 },
        { path: `${base}/braking/t3/value`, label: `${a.id}: нарастание замедления t3`, kind: 'number', unit: 's', minimum: 0 },
        { path: `${base}/controller/method`, label: `${a.id}: регулятор`, kind: 'enum', choices: [{ value: 'pure-pursuit', label: 'Pure pursuit' }, { value: 'stanley', label: 'Stanley' }] },
        { path: `${base}/hazard/at`, label: `${a.id}: момент опасности`, kind: 'number', unit: 's', minimum: 0 },
        { path: `${base}/hazard/reaction`, label: `${a.id}: время реакции t1`, kind: 'number', unit: 's', minimum: 0 },
        { path: `${base}/postImpact/wheels`, label: `${a.id}: колёса после удара`, kind: 'enum', choices: [{ value: 'free', label: 'Свободное качение' }, { value: 'locked', label: 'Заблокированы' }] },
      );
    }
    if (m === 'pedestrian-kinematic') inputs.push(
      { path: `${base}/throw/launchAngle`, label: `${a.id}: угол вылета`, kind: 'number', unit: 'rad' },
      { path: `${base}/throw/launchHeight`, label: `${a.id}: высота ЦМ при вылете`, kind: 'number', unit: 'm', minimum: 0 },
      { path: `${base}/throw/friction`, label: `${a.id}: μ скольжения тела`, kind: 'number', minimum: 0 });
    if (m === 'two-wheeler-or-sim-kinematic') inputs.push(
      { path: `${base}/twoWheeler/vehicleFriction`, label: `${a.id}: μ скольжения упавшего ТС`, kind: 'number', minimum: 0 },
      { path: `${base}/twoWheeler/riderFriction`, label: `${a.id}: μ скольжения ездока`, kind: 'number', minimum: 0 },
      { path: `${base}/twoWheeler/riderMass`, label: `${a.id}: масса ездока`, kind: 'number', unit: 'kg', minimum: 0 });
  });
  let available = true, reason: string | undefined;
  if (issues.length) { available = false; reason = issues.map(i => i.message).join('; '); }
  else if (scene.env.physics === 'dynamic') {
    const bad = scene.actors.map(a => dynamicMotionMethod(a)).filter(m => typeof m !== 'string');
    if (bad.length) { available = false; reason = `Динамический режим: ${bad.map(b => typeof b === 'string' ? '' : `${b.actorId} — ${b.message}`).join('; ')}`; }
  }
  return { id: 'physics.simulate', title: 'Моделирование движения и удара', available, ...(reason ? { reason } : {}), inputs };
}

function evidenceOf(project: ProjectEnvelope, kind: string): EvidenceObservation[] {
  return (project.evidence ?? []).filter(e => e.kind === kind);
}

export function describePhysics(project: ProjectEnvelope): FeatureDescriptor[] {
  const out: FeatureDescriptor[] = [descriptorsForSimulate(project)];
  for (const c of Object.values(CALCULATORS)) out.push({ id: c.id, title: c.title, available: true, inputs: toDescriptors(c.inputs, `/extensions/physics/calculators/${c.id}`) });
  const base = (id: string) => `/extensions/physics/calculators/${id}`;
  out.push({ id: 'reconstruction.inverse', title: 'Обратная задача: подбор неизвестных по наблюдениям', available: true, inputs: [
    { path: `${base('reconstruction.inverse')}/model`, label: 'Модель прогноза', kind: 'enum', required: true, choices: [{ value: 'impact', label: 'Конфигурация удара и выбег' }, { value: 'scene', label: 'Полная симуляция сцены' }] },
    { path: `${base('reconstruction.inverse')}/seed`, label: 'Seed', kind: 'number', required: true },
    { path: '/evidence', label: 'Наблюдения конечных положений (kind=rest-pose) с погрешностью', kind: 'geometry', required: true },
  ] });
  out.push({ id: 'reconstruction.monte-carlo', title: 'Монте-Карло: распределения входов', available: true, inputs: [
    { path: `${base('reconstruction.monte-carlo')}/model`, label: 'Модель', kind: 'enum', required: true, choices: Object.values(MC_MODELS).map(m => ({ value: m.id, label: m.title })) },
    { path: `${base('reconstruction.monte-carlo')}/n`, label: 'Число прогонов (по умолчанию 1000)', kind: 'number', minimum: 10 },
    { path: `${base('reconstruction.monte-carlo')}/seed`, label: 'Seed', kind: 'number', required: true },
    { path: `${base('reconstruction.monte-carlo')}/inputs`, label: 'Распределения: uniform/normal/triangular с границами', kind: 'geometry', required: true },
  ] });
  const calib = evidenceOf(project, 'video-calibration'), track = evidenceOf(project, 'video-track'), marks = evidenceOf(project, 'video-mark-crossings');
  out.push({ id: 'video.homography', title: 'Калибровка неподвижной камеры (гомография)', available: calib.length > 0,
    ...(calib.length ? {} : { reason: 'Нет наблюдения kind=video-calibration (≥4 точки изображение↔план)' }),
    inputs: [{ path: '/evidence', label: 'video-calibration: geometry.points[{image{u,v}, plane{x,y}}], values.pixelSigma', kind: 'geometry', required: true }] });
  out.push({ id: 'video.trajectory', title: 'Траектория, скорость и ускорение по кадрам', available: track.length > 0 && calib.length > 0 || marks.length > 0,
    ...(track.length && calib.length || marks.length ? {} : { reason: 'Нет наблюдений video-track с калибровкой или video-mark-crossings' }),
    inputs: [
      { path: '/evidence', label: 'video-track: geometry.clicks[{pts,u,v}], values.calibrationId, values.pixelSigma; либо video-mark-crossings', kind: 'geometry', required: true },
      { path: `${base('video.trajectory')}/halfWindow`, label: 'Полуширина окна сглаживания', kind: 'number', unit: 's', minimum: 0 },
    ] });
  out.push({ id: 'visibility.assess', title: 'Обзорность 2D и кандидаты момента опасности', available: true, inputs: [
    { path: `${base('visibility.assess')}/observerId`, label: 'Наблюдатель (ТС)', kind: 'text', required: true },
    { path: `${base('visibility.assess')}/targetId`, label: 'Цель', kind: 'text', required: true },
    { path: `${base('visibility.assess')}/visibilityDistance`, label: 'Измеренная дальность видимости (свет/погода) с источником', kind: 'number', unit: 'm', minimum: 0 },
    { path: `${base('visibility.assess')}/pillars`, label: 'Секторы стоек кузова (град) с источником', kind: 'geometry' },
    { path: `${base('visibility.assess')}/eyeOffset`, label: 'Точка глаз в осях ТС', kind: 'geometry' },
  ] });
  return out;
}

function stored(project: ProjectEnvelope, method: string): JsonObject {
  const c = (project.extensions?.physics as JsonObject | undefined)?.calculators;
  return isObj(c) && isObj(c[method]) ? c[method] as JsonObject : {};
}

function expertValue(name: 't1' | 't2' | 't3' | 'j', raw: JsonValue | undefined, fallback?: UserValue): ExpertValue | { insufficient: string } {
  const u = isObj(raw) ? raw as unknown as UserValue : typeof raw === 'number' ? { value: raw, source: `${name}: значение параметра расчёта` } : fallback;
  if (name === 't1') return reactionTime('other', u);
  if (name === 'j') return steadyDeceleration({ user: u });
  return brakeTiming(name, u);
}

function ok(records: CalculationRecord[], issues: FeatureIssue[] = []): FeatureResult<CalculationRecord[]> {
  return { status: 'ok', value: records, issues };
}

function run(project: ProjectEnvelope, control?: RunControl): { tl: Timeline; scene: Scene } {
  const { scene, options, issues } = physicsInputs(project);
  if (issues.length) throw new Error(issues.map(i => i.message).join('; '));
  if (control?.isCancelled?.()) throw new Error('Отменено');
  return { tl: simulate(scene, options), scene };
}

async function calculateImpl(method: string, project: ProjectEnvelope, parameters: JsonObject, control?: RunControl, monteCarlo?: MonteCarloRunner): Promise<FeatureResult<CalculationRecord[]>> {
  const p: JsonObject = { ...stored(project, method), ...parameters };
  if (CALCULATORS[method] && !(method === 'expert.braking' && (p.mode === 'scene' || p.mode === 'yellow' || p.mode === 'observed'))) {
    const r = CALCULATORS[method].run(p);
    return r.status === 'ok' ? ok(r.records) : { status: r.status, issues: r.issues };
  }
  if (method === 'expert.braking') {
    const braking = (id: string) => ((project.extensions?.physics as JsonObject | undefined)?.vehicles as JsonObject | undefined)?.[id] as JsonObject | undefined;
    const vehicleId = typeof p.vehicleId === 'string' ? p.vehicleId : undefined;
    const storedBraking = vehicleId ? (braking(vehicleId)?.braking ?? {}) as unknown as BrakingParameters : {};
    const vals = (['t1', 't2', 't3', 'j'] as const).map(k => [k, expertValue(k, p[k], storedBraking[k] as UserValue | undefined)] as const);
    const missing = vals.filter(([, v]) => 'insufficient' in v);
    if (p.mode === 'yellow') {
      const jService = expertValue('j', p.jService);
      const miss = [...missing.filter(([k]) => k !== 'j'), ...('insufficient' in jService ? [['jService', jService] as const] : [])];
      if (miss.length || typeof p.v0 !== 'number' || typeof p.distanceToStopLine !== 'number') {
        return { status: 'insufficient-data', issues: [...miss.map(([k, v]) => issue('missing-input', (v as { insufficient: string }).insufficient, k)),
          ...(typeof p.v0 !== 'number' ? [issue('missing-input', 'Нет v0', 'v0')] : []), ...(typeof p.distanceToStopLine !== 'number' ? [issue('missing-input', 'Нет расстояния до стоп-линии', 'distanceToStopLine')] : [])] };
      }
      const [t1, t2, t3] = vals.map(([, v]) => v as ExpertValue);
      return ok([yellowServiceStop({ v0: p.v0, distanceToStopLine: p.distanceToStopLine, t1, t2, t3, jService: jService as ExpertValue })]);
    }
    if (p.mode === 'observed') {
      // v0 and the available distance come from an observation, not from a scene run.
      if (missing.length || typeof p.v0 !== 'number' || typeof p.available !== 'number') {
        return { status: 'insufficient-data', issues: [...missing.map(([k, v]) => issue('missing-input', (v as { insufficient: string }).insufficient, k)),
          ...(typeof p.v0 !== 'number' ? [issue('missing-input', 'Нет v0', 'v0')] : []), ...(typeof p.available !== 'number' ? [issue('missing-input', 'Нет расстояния до места конфликта', 'available')] : [])] };
      }
      const [t1, t2, t3, j] = vals.map(([, v]) => v as ExpertValue);
      return ok([assessAvoidability({ v0: p.v0, available: p.available, t1, t2, t3, j, ...(typeof p.criterion === 'string' ? { hazardCriterion: p.criterion } : {}) })]);
    }
    if (!vehicleId || typeof p.otherId !== 'string') return { status: 'insufficient-data', issues: [issue('missing-input', 'Нужны vehicleId и otherId', 'vehicleId')] };
    if (missing.length) return { status: 'insufficient-data', issues: missing.map(([k, v]) => issue('missing-input', (v as { insufficient: string }).insufficient, `/extensions/physics/vehicles/${vehicleId}/braking/${k}`)) };
    const { tl, scene } = run(project, control);
    const hz = hazardMoments(scene, tl, vehicleId, p.otherId, { ...(typeof p.directionChangeDeg === 'number' ? { directionChangeDeg: p.directionChangeDeg } : {}) });
    const chosen = typeof p.criterion === 'string' ? hz.candidates.filter(c => c.criterion === p.criterion) : hz.candidates;
    if (!chosen.length) return { status: 'insufficient-data', issues: [issue('no-hazard-moment', 'Нет кандидата момента опасности по выбранному критерию', 'criterion')] };
    const [t1, t2, t3, j] = vals.map(([, v]) => v as ExpertValue);
    return ok(chosen.map(c => ({ ...assessAvoidability({ v0: c.v0, available: c.available, t1, t2, t3, j, hazardCriterion: c.criterion }), id: `expert.braking.avoidability.${c.criterion}` })),
      [issue('expert-choice', 'Момент опасности выбирает эксперт; приведены расчёты для кандидатов', 'criterion')]);
  }
  if (method === 'reconstruction.monte-carlo') {
    try {
      const result = monteCarlo ? await monteCarlo(p as unknown as MonteCarloSpec, control)
        : await runMonteCarlo(p as unknown as MonteCarloSpec, { onProgress: control?.onProgress, isCancelled: control?.isCancelled, yieldEvery: 200 });
      return ok([{ id: 'reconstruction.monte-carlo', method, inputs: p, formula: 'Сэмплирование входов по распределениям (mulberry32, seed), перцентили типа 7, tornado по 5/95 квантилям',
        result: json(result), units: {}, sources: ['Модель: ' + (MC_MODELS[String(p.model)]?.title ?? String(p.model))], assumptions: [result.interpretation] }],
        result.status === 'cancelled' ? [issue('cancelled', `Остановлено на ${result.completed} из ${result.n}`)] : []);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return { status: 'error', issues: [issue('cancelled', 'Расчёт отменён до получения результата')] };
      return { status: 'insufficient-data', issues: [issue('invalid-input', e instanceof Error ? e.message : String(e))] };
    }
  }
  if (method === 'reconstruction.inverse') {
    if (typeof p.seed !== 'number') return { status: 'insufficient-data', issues: [issue('missing-input', 'Нужен seed', 'seed')] };
    if (p.model === 'impact') {
      if (!isObj(p.problem)) return { status: 'insufficient-data', issues: [issue('missing-input', 'Нужна постановка problem', 'problem')] };
      const out = reconstructImpact({ ...(structuredClone(p.problem) as unknown as ImpactProblem), seed: p.seed });
      return ok([{ id: 'reconstruction.inverse.impact', method, inputs: p, formula: 'min Σ((прогноз − наблюдение)/σ)²', result: json(out), units: { speed: 'm/s', position: 'm', heading: 'rad' }, sources: [], assumptions: out.assumptions }],
        out.alternatives.length ? [issue('ambiguous', `Есть ${out.alternatives.length} альтернативных решений с близкой невязкой`)] : []);
    }
    if (p.model === 'scene') {
      const evidence = evidenceOf(project, 'rest-pose').map(e => ({ id: e.id, actorId: String(e.values.actorId), x: Number(e.geometry.x), y: Number(e.geometry.y),
        ...(typeof e.geometry.heading === 'number' ? { heading: e.geometry.heading, sigmaHeading: Number(e.uncertainty?.heading) } : {}),
        sigmaPosition: Number(e.uncertainty?.position), source: e.source }));
      if (!evidence.length || !Array.isArray(p.variables)) return { status: 'insufficient-data', issues: [issue('missing-input', 'Нужны наблюдения rest-pose и переменные', '/evidence')] };
      const { scene, options, issues } = physicsInputs(project);
      if (issues.length) return { status: 'error', issues };
      const out = reconstructScene({ scene, options, variables: structuredClone(p.variables) as never, evidence, seed: p.seed, ...(typeof p.starts === 'number' ? { starts: p.starts } : {}) });
      return ok([{ id: 'reconstruction.inverse.scene', method, inputs: p, formula: 'min Σ((прогноз − наблюдение)/σ)²', result: json(out), units: { speed: 'km/h', position: 'm' }, sources: evidence.flatMap(e => e.source ? [e.source] : []), assumptions: out.assumptions }],
        out.alternatives.length ? [issue('ambiguous', `Есть ${out.alternatives.length} альтернативных решений с близкой невязкой`)] : []);
    }
    return { status: 'insufficient-data', issues: [issue('missing-input', 'model: impact или scene', 'model')] };
  }
  if (method === 'video.homography' || method === 'video.trajectory') {
    const calibEv = (typeof p.calibrationId === 'string' ? evidenceOf(project, 'video-calibration').find(e => e.id === p.calibrationId) : evidenceOf(project, 'video-calibration')[0]);
    const pairs: Correspondence[] | undefined = Array.isArray(p.correspondences) ? p.correspondences as unknown as Correspondence[]
      : calibEv && Array.isArray(calibEv.geometry.points) ? calibEv.geometry.points as unknown as Correspondence[] : undefined;
    let h: Homography | undefined;
    if (pairs) h = fitHomography(pairs);
    if (method === 'video.homography') {
      if (!h) return { status: 'insufficient-data', issues: [issue('missing-input', 'Нет соответствий (≥4) для калибровки', '/evidence')] };
      return ok([{ id: 'video.homography', method, inputs: { points: pairs!.length, ...(calibEv ? { evidenceId: calibEv.id } : {}) }, formula: 'нормализованный DLT; ошибка репроекции',
        result: json({ H: h.H, rmsPlane: h.rmsPlane, rmsImage: h.rmsImage, calibrationSigma: h.calibrationSigma, residuals: h.residuals }), units: { plane: 'm', image: 'px' },
        sources: [calibEv?.source ?? 'параметры расчёта', 'Hartley & Zisserman, Multiple View Geometry, 2nd ed., alg. 4.2'], assumptions: h.assumptions }]);
    }
    const marksEv = evidenceOf(project, 'video-mark-crossings').find(e => typeof p.marksId !== 'string' || e.id === p.marksId);
    if (p.camera === 'moving' || (!h && marksEv)) {
      if (!marksEv) return { status: 'insufficient-data', issues: [issue('missing-input', 'Нет наблюдения video-mark-crossings', '/evidence')] };
      const out = carrierSpeed({ crossings: marksEv.geometry.crossings as never, spacing: Number(marksEv.values.spacing), spacingSigma: Number(marksEv.values.spacingSigma ?? 0),
        ...(typeof marksEv.values.frameInterval === 'number' ? { frameInterval: marksEv.values.frameInterval } : {}), source: marksEv.source ?? '' });
      return ok([{ id: 'video.trajectory.moving-camera', method, inputs: { evidenceId: marksEv.id }, formula: 's(t)=k·шаг, взвешенная прямая; σt = Δt/√12', result: json(out), units: { speed: 'm/s' },
        sources: [marksEv.source ?? ''], assumptions: out.assumptions }], out.warnings.map(w => issue('pts-warning', w)));
    }
    const trackEv = evidenceOf(project, 'video-track').find(e => typeof p.trackId !== 'string' || e.id === p.trackId);
    if (!h || !trackEv) return { status: 'insufficient-data', issues: [issue('missing-input', 'Нужны калибровка и наблюдение video-track', '/evidence')] };
    const clicks = (trackEv.geometry.clicks as JsonObject[]).map(c => ({ pts: Number(c.pts), image: { u: Number(c.u), v: Number(c.v) } }));
    const sigma = Number(trackEv.values.pixelSigma ?? p.pixelSigma);
    if (!(sigma > 0)) return { status: 'insufficient-data', issues: [issue('missing-input', 'Нужна погрешность клика pixelSigma', '/evidence')] };
    const traj = fitTrajectory(h, clicks, sigma, typeof p.halfWindow === 'number' ? p.halfWindow : 0.3);
    const avg = averageSpeed(h, clicks, sigma);
    const observations: EvidenceObservation[] = traj.samples.map((s, i) => ({ id: `calc-video-${trackEv.id}-${i}`, kind: 'calculated-video-speed',
      geometry: { x: s.position.x, y: s.position.y, t: s.t }, values: { speed: s.speed, acceleration: s.acceleration, ...(trackEv.values.actorId ? { actorId: trackEv.values.actorId } : {}) },
      uncertainty: { speed: s.speedSigma, acceleration: s.accelerationSigma, positionX: Math.sqrt(s.positionCov[0][0]), positionY: Math.sqrt(s.positionCov[1][1]) },
      source: `video.trajectory по ${trackEv.id} (рассчитано)` }));
    return ok([{ id: 'video.trajectory', method, inputs: { trackId: trackEv.id, calibration: calibEv?.id ?? 'correspondences', pixelSigma: sigma, halfWindow: typeof p.halfWindow === 'number' ? p.halfWindow : 0.3 },
      formula: 'локальная взвешенная квадратичная регрессия по PTS; σ из (XᵀWX)⁻¹', result: json({ samples: traj.samples, averageSpeed: avg, pts: traj.pts, observations,
        firstPosition: imageToPlane(h, clicks[0].image) }), units: { speed: 'm/s', acceleration: 'm/s²', position: 'm', time: 's' },
      sources: [trackEv.source ?? '', calibEv?.source ?? ''].filter(Boolean), assumptions: [...h.assumptions, ...traj.assumptions] }], traj.pts.warnings.map(w => issue('pts-warning', w)));
  }
  if (method === 'visibility.assess') {
    if (typeof p.observerId !== 'string' || typeof p.targetId !== 'string') return { status: 'insufficient-data', issues: [issue('missing-input', 'Нужны observerId и targetId', 'observerId')] };
    const { tl, scene } = run(project, control);
    const opts: VisibilityOptions = {
      ...(isObj(p.eyeOffset) ? { eyeOffset: p.eyeOffset as unknown as VisibilityOptions['eyeOffset'] } : {}),
      ...(Array.isArray(p.pillars) ? { pillars: p.pillars as unknown as VisibilityOptions['pillars'] } : {}),
      ...(isObj(p.visibilityDistance) ? { visibilityDistance: p.visibilityDistance as unknown as VisibilityOptions['visibilityDistance'] } : {}),
      ...(typeof p.occludingActors === 'string' ? { occludingActors: p.occludingActors as VisibilityOptions['occludingActors'] } : {}),
    };
    const vis = visibilityTimeline(scene, tl, p.observerId, p.targetId, opts);
    const hz = hazardMoments(scene, tl, p.observerId, p.targetId, { visibility: opts, ...(typeof p.directionChangeDeg === 'number' ? { directionChangeDeg: p.directionChangeDeg } : {}) });
    return ok([{ id: 'visibility.assess', method, inputs: p, formula: '2D линия видимости до углов и центра контура цели; перекрытия прямоугольниками; секторы стоек; измеренная дальность',
      result: json({ firstVisible: vis.firstVisible, frames: vis.frames, hazardCandidates: hz.candidates, conflict: hz.conflict }), units: { t: 's', distance: 'm' },
      sources: vis.sources, assumptions: vis.assumptions }]);
  }
  return { status: 'unsupported', issues: [issue('unsupported-method', `Метод ${method} не поддерживается физическим портом`)] };
}

export function createPhysicsPort(options: { monteCarlo?: MonteCarloRunner } = {}): PhysicsPort {
  return {
    contractVersion: 1,
    describe: project => describePhysics(project),
    async simulate(project, control) {
      if (project?.contractVersion !== 1) return { status: 'error', issues: [issue('contract-version', 'Ожидается contractVersion 1')] };
      if (control?.isCancelled?.()) return { status: 'error', issues: [issue('cancelled', 'Отменено до начала расчёта')] };
      const { scene, options, issues } = physicsInputs(project);
      if (issues.length) return { status: 'error', issues };
      let tl: Timeline;
      try { tl = simulate(scene, options); } catch (e) { return unsupportedFrom(e, scene); }
      control?.onProgress?.(1, 1);
      let technical: JsonObject;
      try {
        const ctx = analyzeTechnical(scene, tl);
        technical = { physics: json(tl.physics ?? null), collisions: json(ctx.technical.collisions.map(c => ({ collision: c.collision, harm: c.harm }))),
          assumptions: json(ctx.technical.assumptions) } as JsonObject;
      } catch (e) {
        technical = { physics: json(tl.physics ?? null), technicalError: e instanceof Error ? e.message : String(e) };
      }
      const output: PhysicsOutput = { timeline: tl, calculations: collisionRecords(tl), technical, observations: observationsOf(tl), renderData: renderData(tl) };
      return { status: 'ok', value: output, issues: [] };
    },
    async calculate(method, project, parameters, control) {
      if (project?.contractVersion !== 1) return { status: 'error', issues: [issue('contract-version', 'Ожидается contractVersion 1')] };
      try { return await calculateImpl(method, project, parameters ?? {}, control, options.monteCarlo); }
      catch (e) {
        const scene = project.scene;
        return unsupportedFrom(e, scene);
      }
    },
  };
}
