import type { TechnicalContext } from '../analysis/technical';
import type { ActorVerdict, Finding, RulesSection } from '../analysis/types';
import { lawRef } from '../law';
import { DT, type Timeline } from '../sim';
import type { CalculationRecord, EvidenceObservation, FeatureDescriptor, FeatureIssue, PhysicsOutput, ProjectEnvelope } from '../parallel/contracts';
import { number, object, type Known } from './facts';

export interface BrakingProof {
  actorId: string; record: CalculationRecord; observation: EvidenceObservation;
  canStop: Known; stoppingRangeM: [number, number]; availableRangeM: [number, number];
}
export interface ExpertEvidence { proofs: BrakingProof[]; issues: FeatureIssue[] }
const range = (value: unknown): [number, number] | null => Array.isArray(value) && value.length === 2 && value.every(v => number(v) !== null) && value[0] <= value[1] ? value as [number, number] : null;
const nonempty = (value: unknown): boolean => typeof value === 'string' && !!value.trim();
const hasSource = (value: unknown): boolean => Array.isArray(value) && value.some(nonempty);

export function describeExpert(_project: ProjectEnvelope): FeatureDescriptor {
  return { id: 'rules.expert-evidence', title: 'Правила с переданными научными доказательствами', available: true,
    inputs: [
      { path: '/extensions/rules/mode', label: 'Режим (по умолчанию expert)', kind: 'enum', choices: [{ value: 'expert', label: 'Экспертный: только переданные доказательства' }, { value: 'educational', label: 'Учебный: прежние упрощения явно обозначены' }] },
      { path: '/extensions/rules/expert/bindings', label: 'Связи recordId / observationId / actorId (JSON-массив; схема в RULES-EXPERT.md)', kind: 'geometry' },
    ] };
}

/** Equality is checked against the actually evaluated timeline. A stale physical
 * result must not silently justify a rule finding for different observations. */
export function sameTimeline(a: Timeline, b: Timeline): boolean {
  if (a.dt !== b.dt || a.n !== b.n || a.duration !== b.duration || a.mu !== b.mu || a.tracks.size !== b.tracks.size || JSON.stringify(a.collisions) !== JSON.stringify(b.collisions)) return false;
  for (const [id, track] of a.tracks) {
    const other = b.tracks.get(id);
    if (!other) return false;
    if (JSON.stringify(track.waypointTimes) !== JSON.stringify(other.waypointTimes)) return false;
    for (const key of ['x', 'y', 'h', 'v', 'present', 'free', 'reversing'] as const) {
      const left = track[key], right = other[key];
      if (!!left !== !!right || left && right && (left.length !== right.length || left.some((v, k) => v !== right[k]))) return false;
    }
  }
  return true;
}
export function readExpertEvidence(project: ProjectEnvelope, timeline: Timeline, physical?: PhysicsOutput): ExpertEvidence {
  const proofs: BrakingProof[] = [], issues: FeatureIssue[] = [];
  const raw = object(project.extensions.rules.expert).bindings;
  if (raw === undefined || raw === null) return { proofs, issues };
  if (!Array.isArray(raw)) return { proofs, issues: [{ code: 'rules.invalid-expert-bindings', path: '/extensions/rules/expert/bindings', message: 'Ожидается массив связей расчётов и наблюдений.' }] };
  if (!physical || !sameTimeline(timeline, physical.timeline)) return { proofs, issues: [{ code: 'rules.missing-scientific-output', message: 'Нет PhysicsOutput для оцениваемого Timeline; технически зависимые выводы остаются неопределёнными.' }] };
  for (const [index, item] of raw.entries()) {
    const binding = object(item), fail = (message: string) => issues.push({ code: 'rules.unsupported-braking-proof', path: `/extensions/rules/expert/bindings/${index}`, message });
    const records = physical.calculations.filter(c => c.id === binding.recordId);
    const observations = [...project.evidence, ...physical.observations].filter(o => o.id === binding.observationId);
    // An identical observation copied through the physics port is one source,
    // but two different objects sharing an ID must never be selected silently.
    const unique = [...new Map(observations.map(o => [JSON.stringify(o), o])).values()];
    const record = records[0], observation = unique[0];
    if (records.length !== 1 || unique.length !== 1 || !record || !observation) { fail('Расчёт/наблюдение отсутствует или его ID неоднозначен.'); continue; }
    const values = object(observation.values), result = object(record.result), units = object(record.units), inputs = object(record.inputs);
    const stoppingRangeM = range(result.stoppingDistanceRangeM), availableRangeM = range(values.availableDistanceRangeM);
    const valid = record.method === 'expert.braking' && inputs.actorId === binding.actorId && values.actorId === binding.actorId
      // Yellow (6.14) needs service braking; collision avoidance (10.1) is assessed with emergency braking.
      && inputs.observationId === observation.id
      && (inputs.brakingMode === 'service' || inputs.brakingMode === 'emergency' && observation.kind === 'collision-avoidance')
      && ['t1', 't2', 't3'].every(key => number(inputs[key]) !== null && units[key] === 's')
      && units.stoppingDistanceRangeM === 'm' && object(observation.uncertainty).availableDistanceUnit === 'm'
      && nonempty(record.formula) && hasSource(record.sources) && hasSource(record.assumptions)
      && nonempty(observation.source) && stoppingRangeM && availableRangeM
      && Number.isInteger(values.frame) && Number(values.frame) >= 0 && Number(values.frame) < timeline.n;
    if (!valid || !stoppingRangeM || !availableRangeM || typeof binding.actorId !== 'string' || !project.scene.actors.some(a => a.id === binding.actorId)) { fail('Нужен служебный расчёт expert.braking с t1–t3, диапазоном пути, единицами SI, формулой, источниками/предпосылками и связанным наблюдением.'); continue; }
    const canStop: Known = stoppingRangeM[1] <= availableRangeM[0] ? true : stoppingRangeM[0] > availableRangeM[1] ? false : null;
    proofs.push({ actorId: binding.actorId, record, observation, canStop, stoppingRangeM, availableRangeM });
  }
  return { proofs, issues };
}

/** Keep geometric observations, discard the educational braking/harm model in
 * expert mode. No substitute physics or medical calculation is made here. */
export function prepareExpertContext(context: TechnicalContext, evidence: ExpertEvidence, physical?: PhysicsOutput): void {
  for (const collision of context.technical.collisions) {
    collision.tech = []; collision.harm = [];
    collision.trace = { ...collision.trace, harmStatus: 'unknown', avoidanceStatus: 'unknown', scientificModel: 'external-port-required' };
  }
  for (const event of context.technical.events) if (event.kind === 'stop-line') {
    const yellow = object(event.trace.yellow);
    const candidates = evidence.proofs.filter(p => p.actorId === event.actorId && p.observation.kind === 'yellow-stop-line'
      && p.observation.values.lightId === object(event.trace.light).id && p.observation.values.frame === yellow.frame
      && p.observation.values.yellowOnsetEstablished === true);
    const proof = candidates.length === 1 ? candidates[0] : undefined;
    event.trace = { ...event.trace, yellow: { frame: yellow.frame ?? null, v0: yellow.v0 ?? null, available: yellow.available ?? null },
      expertRules: true, expertYellow: proof ? { canStop: proof.canStop, record: proof.record, observation: proof.observation,
        formula: 'max(S) ≤ min(available) → possible; min(S) > max(available) → impossible; otherwise unknown',
        stoppingRangeM: proof.stoppingRangeM, availableRangeM: proof.availableRangeM, units: { distance: 'm', time: 's' } } : null };
  }
  context.technical.calculations = evidence.proofs.map(p => structuredClone(p.record));
  context.technical.scientific = { status: physical && sameTimeline(context.tl, physical.timeline) && evidence.proofs.length > 0 ? 'provided' : 'insufficient-data',
    acceptedProofs: evidence.proofs.length, issues: evidence.issues.map(i => i.message), harmStatus: 'not-established' };
  context.technical.assumptions = ['Положения, скорости и события взяты из переданного Timeline.',
    'Техническая возможность оценивается только по явно связанным PhysicsOutput.calculations с t1–t3, диапазонами, единицами и источниками.',
    'Отсутствие технических доказательств не устанавливает невозможность остановки. Тяжесть вреда и проценты вины не определяются.'];
}

export function applyExpertResults(project: ProjectEnvelope, rules: RulesSection, evidence: ExpertEvidence): void {
  for (const f of rules.findings) {
    if (f.refs.includes('pdd:10.1')) {
      const remaining = f.refs.filter(ref => ref !== 'pdd:10.1');
      const independent = remaining.some(ref => /^pdd:(?:8\.|9\.9|13\.|14\.)/.test(ref));
      if (independent) { f.refs = remaining; f.requirement = `Требование ${remaining.join(', ')}`; }
      else { f.severity = 'contributing'; f.compliance = 'не определить'; f.title = 'Недостаточно научных данных для технически зависимого вывода';
        f.detail = 'Контакт и упрощённый расчёт не устанавливают возможность остановки, момент обнаружения опасности и нарушение 10.1.';
        f.trace.ruleCodes = []; f.trace.compliance = 'не определить'; }
      f.causal = false; f.prevention = null;
      f.trace = { ...f.trace, technicalDependency: 'external-proof-required', causal: false };
    }
    if (f.refs.includes('pdd:6.14')) { f.causal = false; f.prevention = null; f.trace.causal = false; }
  }
  for (const proof of evidence.proofs.filter(p => p.observation.kind === 'collision-avoidance')) {
    const values = proof.observation.values;
    const normKnown = !!lawRef('pdd:10.1', project.scene.env.accidentDate).revision;
    const breach = normKnown && proof.canStop === true && values.hazardOnsetEstablished === true && values.hazardPerceivable === true && values.driverFailedToBrake === true;
    const finding: Finding = { actorId: proof.actorId, t: Number(values.frame) * DT,
      severity: breach ? 'violation' : 'contributing', compliance: breach ? 'не выполнено' : 'не определить',
      title: 'Техническая возможность и отдельная проверка мер по 10.1', detail: 'Возможность остановки сравнивается по диапазонам; нарушение требует отдельно установленных момента опасности, её доступности и отсутствия мер.',
      refs: ['pdd:10.1'], requirement: 'п.10.1 ПДД', causal: breach && values.causalLinkEstablished === true, prevention: null,
      trace: { actorId: proof.actorId, expertProof: true, canStop: proof.canStop, record: proof.record, observation: proof.observation,
        source: lawRef('pdd:10.1', project.scene.env.accidentDate), ruleCodes: [], units: { distance: 'm', time: 's' },
        formula: 'possible = max(S) ≤ min(available); impossible = min(S) > max(available); overlap = unknown',
        legalCausalityRequiresSeparateEvidence: true, compliance: breach ? 'не выполнено' : 'не определить' } };
    rules.findings.push(finding);
  }
  for (const collision of rules.collisions) {
    collision.harm = []; collision.tech = [];
    collision.trace = { ...collision.trace, harmStatus: 'unknown', avoidanceStatus: 'external-proof-only' };
    collision.notes = ['Техническая возможность не выводится из контакта. См. переданные научные расчёты и пределы их применимости.',
      'Тяжесть вреда не установлена; судебно-медицинская экспертиза и причинность оцениваются отдельно.'];
  }
  refreshRuleActors(rules);
}

export function refreshRuleActors(rules: RulesSection): void {
  for (const actor of rules.actors) {
    const own = rules.findings.filter(f => f.actorId === actor.actorId && (!f.trace.legalSubject || f.trace.legalSubject === 'driver'));
    const violations = own.filter(f => f.severity === 'violation');
    const status: ActorVerdict['status'] = violations.some(f => f.causal) ? 'causal-violation' : violations.length ? 'noncausal-violation'
      : own.some(f => f.compliance === 'не определить') || actor.status === 'insufficient-data' ? 'insufficient-data' : 'no-violations';
    actor.status = status;
    actor.text = status === 'causal-violation' ? 'Установлены нарушения с отдельно обоснованной причинной связью.' : status === 'noncausal-violation' ? 'Выявлены нарушения; причинная связь с ДТП отдельно не установлена.'
      : status === 'insufficient-data' ? 'Недостаточно данных для полной оценки требований.' : 'В пределах проверенных наблюдений нарушений не выявлено.';
    actor.trace = { ...actor.trace, findings: own.map(f => f.trace) };
  }
}
