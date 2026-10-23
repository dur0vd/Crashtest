import { describe, expect, it } from 'vitest';
import { createRulesPort } from '../src/rules/port';
import { readExpertEvidence } from '../src/rules/expert';
import { analyze } from '../src/analysis';
import { rulesFixture } from './parallel-rules-fixtures';
import type { CalculationRecord, EvidenceObservation, PhysicsOutput } from '../src/parallel/contracts';
const port = createRulesPort();
function yellowFixture(stopRange: [number, number] = [4, 5]) {
  const f = rulesFixture();
  f.actor.x = -10; f.actor.speed = 36; f.actor.age = 30;
  f.track.x = Float32Array.from({ length: f.timeline.n }, (_, k) => -10 + 10 * k * f.timeline.dt); f.track.v.fill(10);
  f.project.scene.roads = [{ id: 'road', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }], lanes: 1, center: 'dashed', oneWay: true, zone: 'city', smooth: false }];
  f.project.scene.lights = [{ id: 'light', x: 0, y: 0, angle: 0, lineLength: 10, green: 0.25, yellow: 2, red: 10, offset: 0 }];
  // Independently specified observation: yellow begins at 0.25 s (frame 10).
  // Stopping ranges are fixture evidence, not values copied from our adapter.
  const observation: EvidenceObservation = { id: 'obs', kind: 'yellow-stop-line', geometry: {}, values: { actorId: 'a', lightId: 'light', frame: 10,
    yellowOnsetEstablished: true, availableDistanceRangeM: [5, 5.5] }, source: 'Authored independent observation for rule verification; no empirical validation claim', uncertainty: { availableDistanceUnit: 'm' } };
  const record: CalculationRecord = { id: 'calc', method: 'expert.braking', inputs: { actorId: 'a', observationId: 'obs', brakingMode: 'service', t1: 0.1, t2: 0.1, t3: 0.1 },
    formula: 'Externally supplied service stopping result; the rule adapter only compares interval bounds', result: { stoppingDistanceRangeM: stopRange },
    units: { t1: 's', t2: 's', t3: 's', stoppingDistanceRangeM: 'm' }, sources: ['Independent deterministic fixture (not natural validation)'], assumptions: ['Range declared by external calculation fixture'] };
  f.project.evidence = [observation]; f.project.extensions.rules.expert = { bindings: [{ actorId: 'a', recordId: 'calc', observationId: 'obs' }] };
  const physical: PhysicsOutput = { timeline: f.timeline, calculations: [record], technical: {}, observations: [observation] };
  return { ...f, physical, record, observation };
}
async function report(f: ReturnType<typeof yellowFixture>, physical: PhysicsOutput | undefined = f.physical) {
  const result = await port.evaluate(f.project, f.timeline, physical);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result;
}
describe('6.14 uses external service braking evidence, not legacy v²/2j', () => {
  it.each([
    [[4, 5], true, 'не выполнено'], [[7, 8], false, 'выполнено'], [[5, 7], null, 'не определить'], [[5.5, 5.5], null, 'не определить'], [[5, 5], true, 'не выполнено'],
  ] as [[number, number], boolean | null, string][])('range %j -> canStop=%s, compliance=%s', async (range, canStop, expected) => {
    const f = yellowFixture(range);
    expect(readExpertEvidence(f.project, f.timeline, f.physical).proofs[0].canStop).toBe(canStop);
    const result = await report(f);
    const findings = result.value.findings.filter(f => f.refs.includes('pdd:6.14'));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(f => f.compliance === expected)).toBe(true);
    expect(findings.every(f => !f.causal)).toBe(true);
    expect(findings.some(f => f.refs.includes('koap:12.12.1'))).toBe(canStop === true);
    expect(result.value.technical.calculations).toEqual([f.record]);
    expect(result.value.technical.events.filter(e => e.kind === 'stop-line').every(e => !('S' in (e.trace.yellow as object)))).toBe(true);
  });
  it('without PhysicsOutput even an explicit binding cannot become a successful scientific result', async () => {
    const f = yellowFixture(); const r = await port.evaluate(f.project, f.timeline);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.value.findings.filter(f => f.refs.includes('pdd:6.14')).every(f => f.compliance === 'не определить')).toBe(true);
      expect(r.value.technical.scientific?.status).toBe('insufficient-data');
      expect(r.value.findings.flatMap(f => f.refs)).not.toContain('koap:12.12.1');
    }
  });
  it.each(['units', 't3', 'sources', 'malformed-source', 'onset', 'duplicate', 'timeline'] as const)('invalid %s cannot qualify yellow violation', async defect => {
    const f = yellowFixture();
    if (defect === 'units') f.record.units.t1 = 'ms';
    if (defect === 't3') delete f.record.inputs.t3;
    if (defect === 'sources') f.record.sources = [];
    if (defect === 'malformed-source') f.record.sources = [123 as unknown as string];
    if (defect === 'onset') f.observation.values.yellowOnsetEstablished = false;
    if (defect === 'duplicate') f.project.evidence.push({ ...f.observation, source: 'Conflicting observation with same ID' });
    if (defect === 'timeline') f.physical.timeline = { ...f.timeline, duration: 200 };
    const r = await report(f);
    expect(r.value.findings.filter(f => f.refs.includes('pdd:6.14')).every(f => f.compliance === 'не определить')).toBe(true);
  });
  it('physical data and project facts are not mutated by rule evaluation', async () => {
    const f = yellowFixture(); const before = structuredClone(f.physical), project = structuredClone(f.project);
    await report(f); expect(f.physical).toEqual(before); expect(f.project).toEqual(project);
  });
  it('educational mode explicitly retains the legacy path; legacy analyze remains compatible', async () => {
    const f = yellowFixture(); f.project.extensions.rules.mode = 'educational';
    const r = await report(f);
    expect(r.value.assumptions.some(a => a.includes('Учебный режим'))).toBe(true);
    expect(analyze(f.project.scene, f.timeline).technical.collisions).toEqual(r.value.technical.collisions);
  });
});
describe('technical possibility and injury are distinct from law and fault', () => {
  it('a collision does not manufacture stop feasibility or a medical/legal harm category', async () => {
    const f = yellowFixture(); f.project.scene.lights = [];
    f.project.scene.obstacles = [{ id: 'wall', kind: 'barrier', x: 1, y: 0, w: 1, h: 5, angle: 0 }];
    f.timeline.collisions = [{ idx: 0, t: 1, frame: 40, a: 'a', b: 'wall', kind: 'vo', point: { x: 0.5, y: 0 }, n: { x: 1, y: 0 }, vA: { x: 10, y: 0 }, vB: { x: 0, y: 0 }, rel: 10, dvA: 10, dvB: 0 }];
    const r = await report(f);
    expect(r.value.technical.collisions[0].harm).toEqual([]); expect(r.value.collisions[0].tech).toEqual([]);
    expect(r.value.findings.filter(f => f.refs.includes('pdd:10.1')).every(f => f.compliance === 'не определить')).toBe(true);
    expect(r.value.findings.filter(f => f.refs.includes('pdd:10.1')).every(f => f.trace.compliance === 'не определить')).toBe(true);
    expect(r.value.legal.duties.some(d => d.text.includes('Наличие пострадавших требуется установить'))).toBe(true);
    expect(r.value.verdicts.flatMap(v => v.legal.flatMap(l => l.refs)).some(ref => /^koap:12\.24|^uk:264/.test(ref))).toBe(false);
  });
  it.each([true, false, null])('external stop possibility needs an independent observed failure to brake: %s', async failed => {
    const f = yellowFixture(); f.project.scene.lights = [];
    f.observation.kind = 'collision-avoidance'; Object.assign(f.observation.values, { hazardOnsetEstablished: true, hazardPerceivable: true, driverFailedToBrake: failed });
    const r = await report(f);
    const finding = r.value.findings.find(f => f.trace.expertProof)!;
    expect(finding.severity).toBe(failed === true ? 'violation' : 'contributing'); expect(finding.causal).toBe(false);
  });
});
