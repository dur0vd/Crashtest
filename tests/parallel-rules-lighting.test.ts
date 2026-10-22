import { describe, expect, it } from 'vitest';
import { createRulesPort } from '../src/rules/port';
import { rulesFixture } from './parallel-rules-fixtures';
import type { JsonObject } from '../src/parallel/contracts';
const port = createRulesPort();
async function run(global: JsonObject, actor: JsonObject = {}) {
  const fixture = rulesFixture({ ...global, actors: { a: actor } });
  const result = await port.evaluate(fixture.project, fixture.timeline);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}
const ordinary = { inTunnel: false, frontFog: false, rearFog: false, highBeam: false, oncomingEncounter: false,
  inSettlement: false, dazzleRisk: false, searchlight: false, hornUsed: false, overtakeFlash: false };
describe('06.6 — independently specified device/condition tables', () => {
  it.each([
    ['day', true, false, false, 'выполнено'], ['day', false, true, false, 'выполнено'],
    ['day', false, false, true, 'выполнено'], ['day', false, false, false, 'не выполнено'],
  ])('%s low=%s DRL=%s fog=%s -> %s', async (time, low, drl, fog, state) => {
    const report = await run({ timeOfDay: time, insufficientVisibility: false }, { ...ordinary, lowBeam: low, drl, frontFog: fog });
    const finding = report.findings.find(f => f.trace.lightingRequirement === 'day-identification')!;
    expect(finding.compliance).toBe(state);
    expect(finding.refs.includes('koap:12.20')).toBe(state === 'не выполнено');
  });
  it.each(['night', 'day'])('DRL alone does not satisfy headlights at %s with poor visibility', async time => {
    const report = await run({ timeOfDay: time, insufficientVisibility: true }, { ...ordinary, lowBeam: false, drl: true });
    expect(report.findings.find(f => f.trace.lightingRequirement === 'headlights')?.compliance).toBe('не выполнено');
  });
  it('a tunnel requires headlights during daylight', async () => {
    expect((await run({ timeOfDay: 'day', insufficientVisibility: false }, { ...ordinary, inTunnel: true, lowBeam: false, drl: true }))
      .findings.find(f => f.trace.lightingRequirement === 'headlights')?.compliance).toBe('не выполнено');
  });
  it.each([149.999, 150, 150.001])('150 m switching boundary, distance=%s', async distance => {
    const report = await run({ timeOfDay: 'night', insufficientVisibility: false }, { ...ordinary, highBeam: true, oncomingEncounter: true, oncomingDistanceM: distance, oncomingRequestsDip: false });
    expect(report.findings.some(f => f.trace.lightingRequirement === 'dip' && f.severity === 'violation')).toBe(distance <= 150);
    expect(report.findings.some(f => f.trace.lightingRequirement === 'dazzled-response')).toBe(false);
  });
  it('a request at 300 m also requires switching', async () => {
    expect((await run({}, { ...ordinary, highBeam: true, oncomingEncounter: true, oncomingDistanceM: 300, oncomingRequestsDip: true }))
      .findings.find(f => f.trace.lightingRequirement === 'dip')?.compliance).toBe('не выполнено');
  });
  it('rear fog is forbidden without poor visibility; front fog may replace low beam in daylight', async () => {
    const r = await run({ timeOfDay: 'day', insufficientVisibility: false }, { ...ordinary, lowBeam: false, frontFog: true, rearFog: true });
    expect(r.findings.find(f => f.trace.lightingRequirement === 'front-fog')?.compliance).toBe('выполнено');
    expect(r.findings.find(f => f.trace.lightingRequirement === 'rear-fog')?.compliance).toBe('не выполнено');
  });
  it('unknown state, twilight and unsupported historical edition stay unknown', async () => {
    const report = await run({ timeOfDay: 'twilight' });
    expect(report.findings.filter(f => f.trace.lighting).every(f => f.compliance === 'не определить')).toBe(true);
    expect(report.findings.flatMap(f => f.refs)).not.toContain('koap:12.20');
    const { project, timeline } = rulesFixture({ timeOfDay: 'night', insufficientVisibility: false, actors: { a: { ...ordinary, lowBeam: false } } });
    project.scene.env.accidentDate = '1900-01-01';
    const r = await port.evaluate(project, timeline);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.value.findings.filter(f => f.trace.lighting).every(f => f.compliance === 'не определить')).toBe(true);
  });
  it('moving dazzled driver uses actual hazard command without a second switch', async () => {
    const { project, actor, timeline } = rulesFixture({ actors: { a: { slowedAfterDazzle: true, stoppedAfterDazzle: true, laneKeptAfterDazzle: true } } });
    actor.warningContext = { dazzled: true };
    actor.path[0].signal = 'hazard'; actor.path[0].signalAt = 0;
    const result = await port.evaluate(project, timeline);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.findings.find(f => f.trace.lightingRequirement === 'moving-hazard')?.compliance).toBe('выполнено');
      expect(result.value.findings.find(f => f.trace.lightingRequirement === 'dazzled-response')?.causal).toBe(false);
      expect(JSON.stringify(result.value)).not.toContain('undefined');
    }
  });
  it('rejects malformed facts and timeline, descriptors escape actor IDs', async () => {
    const { project, timeline } = rulesFixture({ actors: { a: { lowBeam: 'false', hazard: true } } });
    expect((await port.evaluate(project, timeline)).status).toBe('insufficient-data');
    project.scene.actors[0].id = 'x/y~z';
    expect(port.describe(project)[0].inputs.some(i => i.path === '/extensions/rules/lighting/actors/x~1y~0z/lowBeam')).toBe(true);
    expect((await port.evaluate(project, { ...timeline, dt: 0.1 })).status).toBe('insufficient-data');
  });
});
