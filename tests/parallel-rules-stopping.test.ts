import { describe, expect, it } from 'vitest';
import { createRulesPort } from '../src/rules/port';
import { rulesFixture } from './parallel-rules-fixtures';
import type { ProjectEnvelope } from '../src/parallel/contracts';
const port = createRulesPort();
function rest() {
  const f = rulesFixture(); f.track.v.fill(0); f.track.x.fill(0); f.actor.speed = 0;
  f.actor.stopContext = { reason: 'other-voluntary', intentional: true, durationBeforeStart: 600, onCarriageway: true };
  return f;
}
async function evaluate(f: ReturnType<typeof rulesFixture>) {
  const result = await port.evaluate(f.project, f.timeline);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}
describe('06.4 — personal stopping duties without repeated geometry', () => {
  it.each([['other', '1'], ['moscow', '5'], ['saint-petersburg', '5'], [undefined, undefined]] as const)('leaving unsecured vehicle: city=%s part=%s', async (city, part) => {
    const f = rest(); f.project.scene.env.federalCity = city;
    Object.assign(f.actor.stopContext!, { driverLeft: true, rollawaySecured: false, unauthorizedUsePrevented: true });
    const finding = (await evaluate(f)).findings.find(f => f.trace.personalDutyKind === 'driver-left')!;
    expect(finding.compliance).toBe('не выполнено'); expect(finding.causal).toBe(false);
    expect(finding.refs.filter(ref => ref.startsWith('koap:'))).toEqual(part ? [`koap:12.19#${part}`] : []);
  });
  it.each([true, false, undefined])('adult present with child under seven: %s', async adultPresent => {
    const f = rest(); f.project.scene.env.federalCity = 'other';
    Object.assign(f.actor.stopContext!, { driverLeft: true, rollawaySecured: true, unauthorizedUsePrevented: true, childUnder7Present: true, adultPresent });
    const finding = (await evaluate(f)).findings.find(f => f.trace.personalDutyKind === 'child-left')!;
    expect(finding.compliance).toBe(adultPresent === true ? 'выполнено' : adultPresent === false ? 'не выполнено' : 'не определить');
    expect(finding.refs.includes('koap:12.19#1')).toBe(adultPresent === false);
  });
  it.each([['other', '4'], ['moscow', '6']] as const)('driver door obstructs a vehicle on carriageway: %s', async (city, part) => {
    const f = rest(); f.project.scene.env.federalCity = city;
    f.actor.doorContext = { opened: true, createsObstruction: true, operator: 'driver', otherId: 'other' };
    f.project.scene.actors.push({ ...f.actor, id: 'other', x: 30, doorContext: undefined });
    f.timeline.tracks.set('other', { ...f.track, id: 'other', x: new Float32Array(f.timeline.n).fill(30) });
    const finding = (await evaluate(f)).findings.find(f => f.trace.personalDutyKind === 'door')!;
    expect(finding.refs).toContain(`koap:12.19#${part}`); expect(finding.causal).toBe(false);
  });
  it('a passenger door is assessed for its established passenger and never assigned to the driver', async () => {
    const f = rest(); f.project.scene.env.federalCity = 'moscow';
    f.actor.doorContext = { opened: true, createsObstruction: true, operator: 'passenger' };
    f.actor.passengers = [{ id: 'p', age: 20 }]; f.actor.passengerContext = { beltsProvided: false };
    f.project.extensions.rules.stopping = { actors: { a: { doorPassengerId: 'p' } } };
    const report = await evaluate(f);
    const duty = report.legal.duties.find(d => d.trace.personalDutyKind === 'door')!;
    expect(duty.refs).toContain('koap:12.29.1');
    expect(report.legal.verdicts.flatMap(v => v.legal.flatMap(l => l.refs))).not.toContain('koap:12.29.1');
    expect(report.findings.find(f => f.trace.personalDutyKind === 'door')?.causal).toBe(false);
  });
  it('unknown door operator/age/date cannot create a personal administrative subject', async () => {
    const f = rest(); f.actor.doorContext = { opened: true, createsObstruction: true };
    f.project.scene.env.accidentDate = '1900-01-01';
    expect((await evaluate(f)).findings.find(f => f.trace.personalDutyKind === 'door')?.compliance).toBe('не определить');
    f.project.scene.env.accidentDate = '2026-10-22'; f.actor.doorContext.operator = 'passenger';
    const r = await evaluate(f); expect(r.legal.duties.flatMap(d => d.refs)).not.toContain('koap:12.29.1');
  });
  it.each([true, false, null])('7.3: rear attached triangle=%s, independent from roadside triangle', async triangleAttachedRear => {
    const f = rulesFixture(); f.actor.warningContext = { towedMechanical: true, hazardAvailable: false, trianglePlaced: true };
    f.project.extensions.rules.stopping = { actors: { a: { triangleAttachedRear } } };
    const finding = (await evaluate(f)).findings.find(f => f.refs.includes('pdd:7.3'))!;
    expect(finding.compliance).toBe(triangleAttachedRear === true ? 'выполнено' : triangleAttachedRear === false ? 'не выполнено' : 'не определить');
  });
  it('descriptors point at existing contexts and the single passenger list', () => {
    const f = rest(); const snapshot = JSON.stringify(f.project); const d = port.describe(f.project as ProjectEnvelope);
    expect(d.flatMap(d => d.inputs).some(i => i.path === '/scene/actors/0/doorContext/operator')).toBe(true);
    expect(JSON.stringify(f.project)).toBe(snapshot);
  });
  it.each([false, [], { actors: [] }, { actors: { a: false } }, { actors: { a: { doorPassengerId: 3 } } }])('invalid stopping namespace %j is rejected rather than erased', async stopping => {
    const f = rest(); f.project.extensions.rules.stopping = stopping;
    const result = await port.evaluate(f.project, f.timeline);
    expect(result.status).toBe('insufficient-data'); expect(result.issues.length).toBeGreaterThan(0);
  });
});
