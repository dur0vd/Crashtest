import type { Ctx } from '../analysis/context';
import type { FindingInput } from '../analysis/types';
import { lawRef } from '../law';
import { vehicleSignalAt } from '../maneuver-signals';
import { tOf } from '../analysis/technical';
import type { FeatureDescriptor, FeatureIssue, InputDescriptor, JsonObject, ProjectEnvelope } from '../parallel/contracts';
import { bool, compliance, object, pointer, severity, validateFields } from './facts';

export function describeStopping(project: ProjectEnvelope): FeatureDescriptor {
  const inputs: InputDescriptor[] = [{ path: '/scene/env/federalCity', label: 'Установлено: Москва, Санкт-Петербург или другое место', kind: 'enum', choices: ['moscow', 'saint-petersburg', 'other'].map(value => ({ value, label: value })) }];
  for (const [index, a] of project.scene.actors.entries()) if (a.kind === 'vehicle' && !a.railwayTrain) {
    const path = `/extensions/rules/stopping/actors/${pointer(a.id)}`;
    inputs.push({ path: `${path}/doorPassengerId`, label: `${a.id}: ID пассажира, открывшего дверь`, kind: 'text' },
      { path: `${path}/triangleAttachedRear`, label: `${a.id}: знак закреплён сзади буксируемого ТС`, kind: 'boolean' });
    for (const [context, fields] of Object.entries({ stopContext: ['driverLeft', 'rollawaySecured', 'unauthorizedUsePrevented', 'childUnder7Present', 'adultPresent', 'relocationMeasuresTaken', 'relocationPossible', 'onCarriageway'],
      doorContext: ['opened', 'createsObstruction'], warningContext: ['towedMechanical', 'hazardAvailable', 'trianglePlaced', 'trianglePromptly', 'timelyWarningEnsured'] }))
      for (const key of fields) inputs.push({ path: `/scene/actors/${index}/${context}/${key}`, label: `${a.id}: ${context}.${key} (null — неизвестно)`, kind: 'boolean' });
    inputs.push({ path: `/scene/actors/${index}/doorContext/operator`, label: `${a.id}: кто открыл дверь`, kind: 'enum', choices: ['driver', 'passenger'].map(value => ({ value, label: value })) },
      { path: `/scene/actors/${index}/doorContext/otherId`, label: `${a.id}: ID участника, которому создана помеха дверью`, kind: 'text' });
  }
  return { id: 'rules.stopping-personal', title: 'Дверь, уход, ребёнок и меры вынужденной остановки', available: true, inputs };
}
export function validateStoppingSupplement(raw: unknown): FeatureIssue[] {
  return Object.entries(object(object(raw).actors)).flatMap(([id, facts]) => validateFields(object(facts), `/extensions/rules/stopping/actors/${pointer(id)}`, ['triangleAttachedRear'], []));
}

/** Refine the existing observations instead of repeating the parking geometry.
 * Evidence of a door obstruction is not evidence of collision causation. */
export function refineStopping(ctx: Ctx, input: JsonObject, add: (finding: FindingInput) => unknown): void {
  for (const f of ctx.findings) {
    if (!f.trace?.stopping || !f.trace.personalDuty) continue;
    const a = ctx.infos.get(f.actorId)!.a, facts = object(object(input.actors)[a.id]);
    const kind = f.trace.personalDutyKind;
    const sources = f.refs.filter(r => r.startsWith('pdd:')).map(ref => lawRef(ref, ctx.scene.env.accidentDate));
    let legalSubject = 'driver', qualificationBasis: string | null = null, passengerId: string | null = null;
    if (kind === 'door') {
      if (a.doorContext?.operator === 'passenger') {
        legalSubject = 'passenger'; passengerId = typeof facts.doorPassengerId === 'string' ? facts.doorPassengerId : null;
      } else if (a.doorContext?.operator === 'driver') {
        const other = ctx.scene.actors.find(other => other.id === a.doorContext?.otherId);
        if (a.stopContext?.onCarriageway === true && other?.kind === 'vehicle') qualificationBasis = 'door-vehicle-obstruction';
      } else legalSubject = 'unknown-operator';
    } else if (kind === 'driver-left' || kind === 'child-left') qualificationBasis = 'personal-general';
    if (sources.some(s => !s.revision)) { f.severity = 'contributing'; f.trace.compliance = 'не определить'; qualificationBasis = null; }
    f.trace = { ...f.trace, legalSubject, passengerId, personalQualificationBasis: qualificationBasis, sources,
      legalCheck: qualificationBasis || legalSubject === 'passenger' && passengerId ? null : 'TODO(legal-check): установить субъекта двери, помеху именно ТС/положение на проезжей части либо точную применимую норму',
      causalAssessment: { status: 'unknown', reason: 'Открытая дверь/уход/ребёнок и контакт сами по себе не доказывают причинность ДТП.' } };
    f.causal = false;
  }
  for (const i of ctx.infos.values()) {
    if (i.k0 >= ctx.tl.n || i.a.warningContext?.towedMechanical !== true || i.a.warningContext.hazardAvailable !== false) continue;
    const facts = object(object(input.actors)[i.a.id]), source = lawRef('pdd:7.3', ctx.scene.env.accidentDate);
    const state = source.revision ? bool(facts.triangleAttachedRear) : null;
    add({ actorId: i.a.id, t: tOf(i.k0), severity: severity(state), causal: false, title: 'Знак сзади буксируемого ТС при отсутствии/неисправности аварийной сигнализации',
      detail: `${compliance(state)}. Требование 7.3 отличается от установки знака на дороге по 7.2.`,
      refs: ['pdd:7.3', ...(state === false ? ['rule:lighting'] : [])], trace: { warningOnly: true, legalSubject: 'driver', source,
        triangleAttachedRear: bool(facts.triangleAttachedRear), vehicleSignal: vehicleSignalAt(i.a, tOf(i.k0), i.tr.waypointTimes ?? []), compliance: compliance(state), causal: false } });
  }
}
