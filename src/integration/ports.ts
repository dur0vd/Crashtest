/**
 * Integrator-owned wiring of the real ports (shared contract v1). The UI, the
 * workbench, the report pipeline and the CLI all obtain their ports here, so a
 * project is always calculated by the same physics and rules implementations.
 */
import type {
  CalculationRecord, EvidenceObservation, FeatureIssue, FeatureResult, JsonObject, PhysicsOutput, PhysicsPort,
  ProjectEnvelope, RulesPort, RunControl,
} from '../parallel/contracts';
import type { Report } from '../analysis/types';
import { createPhysicsPort, type MonteCarloRunner } from '../physics/port';
import { createRulesPort } from '../rules/port';
import { corpus } from '../corpus';
import { LAW } from '../law';
import { SUPPLEMENTAL_NORMS } from '../law-supplement';
import { canonical, sha256, utf8 } from '../project/canonical';
import { UI_VERSION, type Versions } from '../project/model';

/** SemVer of the calculation engine (physics + rules), separate from the UI version. */
export const ENGINE_VERSION = '0.3.0';

export interface IntegratedPorts { physics: PhysicsPort; rules: RulesPort }

const isObj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const range = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x)) && v[0] <= v[1] ? [v[0], v[1]] as [number, number] : null;

/** Observation kind accepted by RulesPort → braking mode of the physics calculation. */
const PROOF_KINDS: Record<string, 'service' | 'emergency'> = { 'yellow-stop-line': 'service', 'collision-avoidance': 'emergency' };

/**
 * Adapter between the two independently developed schemas (docs/INTEGRATION.md):
 * for every rules binding {actorId, recordId, observationId} whose record is not
 * already in the physics output, the physics port calculates the stopping-distance
 * range (service braking for 6.14, emergency braking for 10.1) and the result is
 * re-expressed in the record shape that RulesPort validates. Numbers come only
 * from the physics port; v0 is the simulated speed of the bound Timeline frame.
 */
export async function deriveBrakingProofs(project: ProjectEnvelope, output: PhysicsOutput, physics: PhysicsPort,
  control?: RunControl): Promise<{ calculations: CalculationRecord[]; issues: FeatureIssue[] }> {
  const calculations: CalculationRecord[] = [], issues: FeatureIssue[] = [];
  const bindings = isObj(project.extensions.rules?.expert) ? (project.extensions.rules.expert as JsonObject).bindings : undefined;
  if (!Array.isArray(bindings)) return { calculations, issues };
  const vehicles = isObj(project.extensions.physics?.vehicles) ? project.extensions.physics.vehicles as JsonObject : {};
  for (const [index, raw] of bindings.entries()) {
    if (!isObj(raw) || typeof raw.actorId !== 'string' || typeof raw.recordId !== 'string' || typeof raw.observationId !== 'string') continue;
    const { actorId, recordId, observationId } = raw;
    if (output.calculations.some(c => c.id === recordId) || calculations.some(c => c.id === recordId)) continue;
    const observation: EvidenceObservation | undefined = [...project.evidence, ...output.observations].find(o => o.id === observationId);
    const mode = observation ? PROOF_KINDS[observation.kind] : undefined;
    if (!observation || !mode) continue; // RulesPort reports the unresolved binding itself.
    const path = `/extensions/rules/expert/bindings/${index}`;
    const available = range(observation.values.availableDistanceRangeM), frame = observation.values.frame;
    const track = output.timeline.tracks.get(actorId);
    if (!available || !Number.isInteger(frame) || !track || (frame as number) < 0 || (frame as number) >= output.timeline.n) {
      issues.push({ code: 'integration.braking-observation', path, message: `${observationId}: нужны values.frame в пределах Timeline и availableDistanceRangeM [min,max] м для участника ${actorId}.` });
      continue;
    }
    const v0 = track.v[frame as number];
    const braking = isObj(vehicles[actorId]) && isObj((vehicles[actorId] as JsonObject).braking) ? (vehicles[actorId] as JsonObject).braking as JsonObject : {};
    const parameters: JsonObject = mode === 'service'
      ? { mode: 'yellow', vehicleId: actorId, v0, distanceToStopLine: available[0], ...(braking.jService !== undefined ? { jService: braking.jService } : {}) }
      : { mode: 'observed', vehicleId: actorId, v0, available: available[0] };
    const result = await physics.calculate('expert.braking', project, parameters, control);
    if (result.status !== 'ok' || !result.value.length) {
      issues.push(...result.issues.map(i => ({ ...i, code: `integration.${i.code}`, path: i.path?.startsWith('/') ? i.path : `/extensions/physics/vehicles/${actorId}/braking/${i.path ?? ''}`,
        message: `${observationId}: ${i.message}` })));
      if (!result.issues.length) issues.push({ code: 'integration.braking-unavailable', path, message: `${observationId}: расчёт торможения не выполнен (${result.status}).` });
      continue;
    }
    const record = result.value[0], res = record.result as JsonObject, inp = record.inputs as JsonObject;
    const stopping = mode === 'service' ? range(res.range)
      : isObj(res.best) && isObj(res.worst) ? range([res.best.S, res.worst.S]) : null;
    const t = (k: string) => isObj(inp[k]) ? (inp[k] as JsonObject).value : undefined;
    if (!stopping || [t('t1'), t('t2'), t('t3')].some(x => typeof x !== 'number')) {
      issues.push({ code: 'integration.braking-schema', path, message: `${observationId}: результат ${record.id} не содержит диапазона остановочного пути и t1–t3.` });
      continue;
    }
    calculations.push({
      id: recordId, method: 'expert.braking',
      inputs: { actorId, observationId, brakingMode: mode, t1: t('t1') as number, t2: t('t2') as number, t3: t('t3') as number,
        v0, frame: frame as number, physicsRecordId: record.id, physicsInputs: record.inputs },
      formula: record.formula,
      result: { stoppingDistanceRangeM: stopping, physics: record.result },
      units: { ...record.units, t1: 's', t2: 's', t3: 's', v0: 'm/s', stoppingDistanceRangeM: 'm' },
      sources: record.sources,
      assumptions: [...record.assumptions,
        `Адаптер интеграции: v0 = ${v0} м/с — скорость участника ${actorId} в кадре ${frame} рассчитанного Timeline; диапазон пути — ${mode === 'service' ? 'служебное' : 'экстренное'} торможение по крайним значениям t1–t3/j.`],
    });
  }
  return { calculations, issues };
}

/** Physics port whose simulate() also carries the braking proofs requested by rules bindings. */
function withRulesEvidence(base: PhysicsPort): PhysicsPort {
  return {
    contractVersion: 1,
    describe: project => base.describe(project),
    calculate: (method, project, parameters, control) => base.calculate(method, project, parameters, control),
    async simulate(project, control) {
      const result = await base.simulate(project, control);
      if (result.status !== 'ok') return result;
      const derived = await deriveBrakingProofs(project, result.value, base, control);
      if (!derived.calculations.length && !derived.issues.length) return result;
      return { status: 'ok', value: { ...result.value, calculations: [...result.value.calculations, ...derived.calculations] },
        issues: [...result.issues, ...derived.issues] };
    },
  };
}

export function createPorts(options: { monteCarlo?: MonteCarloRunner } = {}): IntegratedPorts {
  return { physics: withRulesEvidence(createPhysicsPort(options)), rules: createRulesPort() };
}

let corpusVersion: Promise<string> | undefined;
/** Engine SemVer, UI version and a content hash of the legal corpus actually bundled. */
export function currentVersions(): Promise<Versions> {
  corpusVersion ??= sha256(utf8(canonical(JSON.parse(JSON.stringify({ corpus, law: LAW, supplemental: SUPPLEMENTAL_NORMS })))))
    .then(h => `sha256:${h}`);
  return corpusVersion.then(c => ({ engine: ENGINE_VERSION, ui: UI_VERSION, corpus: c }));
}

export interface ProjectRun {
  physics: FeatureResult<PhysicsOutput>;
  /** Absent when physics did not produce a Timeline: rules never run on a substitute. */
  rules?: FeatureResult<Report>;
}

/** The single calculation pipeline: physics, then rules on that exact Timeline. */
export async function runProject(project: ProjectEnvelope, ports: IntegratedPorts, control?: RunControl): Promise<ProjectRun> {
  const physics = await ports.physics.simulate(project, control);
  if (physics.status !== 'ok') return { physics };
  const rules = await ports.rules.evaluate(project, physics.value.timeline, physics.value);
  return { physics, rules };
}

export type RulesMode = 'expert' | 'educational';
/** RulesPort default is expert; only an explicit 'educational' changes it. */
export function rulesMode(project: ProjectEnvelope): RulesMode {
  return project.extensions.rules?.mode === 'educational' ? 'educational' : 'expert';
}
export const issueText = (issues: FeatureIssue[]): string => issues.map(i => i.message).join('; ');
