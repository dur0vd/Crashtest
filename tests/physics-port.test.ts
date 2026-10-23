import { describe, expect, it } from 'vitest';
import { PHYSICS_METHOD_IDS, createPhysicsPort } from '../src/physics/port';
import type { JsonObject, ProjectEnvelope } from '../src/parallel/contracts';
import { emptyScene, type Actor } from '../src/scene';
import { syntheticVehicle } from '../src/physics';
import { PRESETS } from '../src/presets';
import { matmul } from '../src/video-math';

const synthetic = { kind: 'synthetic', description: 'Test fixture only' };
const envelope = (scene = emptyScene(), physics: JsonObject = {}, evidence: ProjectEnvelope['evidence'] = []): ProjectEnvelope =>
  ({ contractVersion: 1, scene, extensions: { physics, rules: {}, workspace: {} }, evidence });
const car = (id: string, opts: Partial<Actor> = {}): Actor => ({ id, kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 36, path: [], color: '#fff', delay: 0,
  flags: { drunk: false, noLicense: false, flees: false }, ...opts });
const dyn = () => { const p = syntheticVehicle(); p.brakes.abs = 'ideal'; return p as unknown as JsonObject; };

describe('physics port: contract v1', () => {
  const port = createPhysicsPort();
  it('describe lists simulate and every method id with JSON-pointer inputs', () => {
    const d = port.describe(envelope());
    expect(port.contractVersion).toBe(1);
    expect(d.map(x => x.id).sort()).toEqual(['physics.simulate', ...PHYSICS_METHOD_IDS].sort());
    for (const f of d) for (const i of f.inputs) expect(i.path.startsWith('/')).toBe(true);
    expect(d.find(x => x.id === 'video.homography')!.available).toBe(false);
  });
  it('kinematic preset simulates with timeline, technical section and calculated observations', async () => {
    const project = envelope(PRESETS[0].build());
    const before = structuredClone(project);
    const r = await port.simulate(project);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.value.timeline.physics!.mode).toBe('kinematic');
      expect(r.value.technical.physics).toBeDefined();
    }
    expect(project).toEqual(before);
  });
  it('dynamic mode: unsupported actors are explicit with paths; extension parameters enable the run without mutating the project', async () => {
    const s = emptyScene(); s.env.physics = 'dynamic'; s.env.duration = 3;
    s.actors = [car('a1', { speed: 54 }), car('a2', { x: 30, heading: Math.PI, speed: 36 })];
    const plain = await port.simulate(envelope(s));
    expect(plain.status).toBe('unsupported');
    if (plain.status !== 'ok') expect(plain.issues.map(i => i.path)).toEqual(['/scene/actors/0', '/scene/actors/1']);
    expect(port.describe(envelope(s))[0].available).toBe(false);
    const project = envelope(s, { vehicles: { a1: { dynamics: dyn() }, a2: { dynamics: dyn(), postImpact: { wheels: 'locked', source: synthetic } } } });
    const before = structuredClone(project);
    const r = await port.simulate(project);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.value.calculations[0].method).toBe('physics.impact');
      expect((r.value.renderData!.actors as JsonObject).a1).toBeDefined();
      expect(r.value.observations.some(o => o.kind === 'calculated-rest-pose')).toBe(true);
      expect(JSON.parse(JSON.stringify(r.value.technical))).toEqual(r.value.technical);
    }
    expect(project).toEqual(before);
    const conflicting = structuredClone(project);
    conflicting.scene.actors[0].dynamics = syntheticVehicle();
    expect((await port.simulate(conflicting)).status).toBe('error');
  });
  it('calculators: ok with records, insufficient-data with paths, unknown method unsupported', async () => {
    const r = await port.calculate('expert.braking', envelope(), { skidLength: 20, j: 6.8, t3: 0.35 });
    expect(r.status).toBe('ok');
    for (const id of ['expert.skid', 'expert.lateral', 'expert.critical-speed', 'expert.throw', 'expert.momentum', 'expert.ees']) {
      const m = await port.calculate(id, envelope(), {});
      expect(m.status).toBe('insufficient-data');
    }
    expect((await port.calculate('expert.critical-speed', envelope({ ...emptyScene() }, { calculators: { 'expert.critical-speed': { radius: 50, mu: 0.6 } } }), {})).status).toBe('ok');
    expect((await port.calculate('physics.magic', envelope(), {})).status).toBe('unsupported');
  });
  it('expert.braking scene and yellow modes use explicit t1–t3/j and never invent table values', async () => {
    const s = emptyScene(); s.env.duration = 8;
    s.roads = [{ id: 'r1', pts: [{ x: -50, y: 0 }, { x: 150, y: 0 }], lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false }];
    const ped: Actor = { id: 'p1', kind: 'pedestrian', type: 'adult', x: 52, y: -9, heading: Math.PI / 2, speed: 7.4, path: [{ x: 52, y: 12, v: 7.4 }], color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } };
    s.actors = [car('a1', { y: 2, path: [{ x: 120, y: 2, v: 36 }] }), ped];
    const missing = await port.calculate('expert.braking', envelope(s), { mode: 'scene', vehicleId: 'a1', otherId: 'p1' });
    expect(missing.status).toBe('insufficient-data');
    const project = envelope(s, { vehicles: { a1: { braking: { t1: { value: 1, min: 0.8, max: 1.2, source: 'эксперт' }, t2: { value: 0.1, source: 'эксперт' }, t3: { value: 0.35, source: 'эксперт' }, j: { value: 6.8, source: 'эксперт' } } } } });
    const r = await port.calculate('expert.braking', project, { mode: 'scene', vehicleId: 'a1', otherId: 'p1' });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.value.map(x => x.id)).toContain('expert.braking.avoidability.entered-carriageway');
    const y = await port.calculate('expert.braking', envelope(), { mode: 'yellow', v0: 14, distanceToStopLine: 40, t1: 1, t2: 0.1, t3: 0.35, jService: { value: 3, source: 'эксперт' } });
    expect(y.status).toBe('ok');
  });
  it('monte-carlo and inverse through the port; progress callback', async () => {
    let progressed = 0;
    const mc = await port.calculate('reconstruction.monte-carlo', envelope(), { model: 'expert.braking.skid-speed', seed: 1, n: 200,
      inputs: { skidLength: { kind: 'uniform', min: 18, max: 22 }, j: { kind: 'triangular', min: 6, mode: 6.8, max: 7.5 }, t3: { kind: 'fixed', value: 0.35 } } },
      { onProgress: () => { progressed++; } });
    expect(mc.status).toBe('ok'); expect(progressed).toBeGreaterThan(0);
    expect((await port.calculate('reconstruction.monte-carlo', envelope(), { model: 'nope', seed: 1, inputs: {} })).status).toBe('insufficient-data');
    expect((await port.calculate('reconstruction.inverse', envelope(), { model: 'impact' })).status).toBe('insufficient-data');
  });
  it('video homography/trajectory from evidence with true PTS; visibility assessment', async () => {
    const K = [[1000, 0, 960], [0, 1000, 540], [0, 0, 1]], pitch = 0.3, C = [0, -20, 6];
    const zc = [0, Math.cos(pitch), -Math.sin(pitch)], xc = [1, 0, 0], yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
    const R = [xc, yc, zc], t = R.map(r => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2]));
    const H = matmul(K, [[R[0][0], R[0][1], t[0]], [R[1][0], R[1][1], t[1]], [R[2][0], R[2][1], t[2]]]);
    const proj = (x: number, y: number) => { const w = H[2][0] * x + H[2][1] * y + H[2][2]; return { u: (H[0][0] * x + H[0][1] * y + H[0][2]) / w, v: (H[1][0] * x + H[1][1] * y + H[1][2]) / w }; };
    const points = [[-3, 5], [3, 5], [-3, 25], [3, 25], [0, 15]].map(([x, y]) => ({ image: proj(x, y), plane: { x, y } }));
    const clicks = Array.from({ length: 40 }, (_, i) => { const tt = i * 0.04; const q = proj(1, 6 + 10 * tt); return { pts: tt, u: q.u, v: q.v }; });
    const evidence: ProjectEnvelope['evidence'] = [
      { id: 'cal1', kind: 'video-calibration', geometry: { points } as unknown as JsonObject, values: { pixelSigma: 0.5 }, source: 'кадр 12, разметка' },
      { id: 'trk1', kind: 'video-track', geometry: { clicks } as unknown as JsonObject, values: { pixelSigma: 0.7, calibrationId: 'cal1', actorId: 'a1' }, source: 'покадровая разметка' },
    ];
    const project = envelope(emptyScene(), {}, evidence);
    const hom = await port.calculate('video.homography', project, {});
    expect(hom.status).toBe('ok');
    const tr = await port.calculate('video.trajectory', project, { halfWindow: 0.3 });
    expect(tr.status).toBe('ok');
    if (tr.status === 'ok') {
      const res = tr.value[0].result as { averageSpeed: { speed: number }; observations: { source: string }[] };
      expect(res.averageSpeed.speed).toBeCloseTo(10, 3);
      expect(res.observations[0].source).toMatch(/рассчитано/);
    }
    expect(project.evidence).toEqual(evidence);
    const s = emptyScene(); s.env.duration = 4;
    s.actors = [car('a1', { path: [{ x: 60, y: 0, v: 36 }] }), { id: 'p1', kind: 'pedestrian', type: 'adult', x: 30, y: -6, heading: Math.PI / 2, speed: 5, path: [{ x: 30, y: 6, v: 5 }], color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } }];
    const vis = await port.calculate('visibility.assess', envelope(s), { observerId: 'a1', targetId: 'p1', visibilityDistance: { value: 50, source: 'эксперимент' } });
    expect(vis.status).toBe('ok');
  });
  it('wrong contract version and cancellation are explicit errors', async () => {
    expect((await port.simulate({ ...envelope(), contractVersion: 2 as 1 })).status).toBe('error');
    expect((await port.simulate(envelope(), { isCancelled: () => true })).status).toBe('error');
  });
});
