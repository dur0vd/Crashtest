import { emptyScene, type Actor } from '../src/scene';
import { DT, type Timeline, type Track } from '../src/sim';
import type { JsonObject, ProjectEnvelope } from '../src/parallel/contracts';

/** Independently authored 1 m/s observations, without simulate() or its defaults. */
export function rulesFixture(lighting: JsonObject = {}, overrides: Partial<Actor> = {}) {
  const scene = emptyScene(); scene.env.accidentDate = '2026-10-22';
  const actor: Actor = { id: 'a', kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 3.6, delay: 0,
    color: '#123456', path: [{ x: 10, y: 0, v: 3.6 }], flags: { drunk: false, noLicense: false, flees: false },
    warningContext: { towedMechanical: false }, ...overrides };
  scene.actors = [actor];
  const n = 41;
  const track: Track = { id: actor.id, x: Float32Array.from({ length: n }, (_, k) => k * DT), y: new Float32Array(n),
    h: new Float32Array(n), v: new Float32Array(n).fill(1), present: new Uint8Array(n).fill(1), free: new Uint8Array(n), waypointTimes: [10] };
  const timeline: Timeline = { dt: DT, n, duration: 1, mu: 0.8, tracks: new Map([[actor.id, track]]), collisions: [] };
  const project: ProjectEnvelope = { contractVersion: 1, scene, extensions: { physics: {}, rules: { lighting }, workspace: {} }, evidence: [] };
  return { project, actor, track, timeline };
}
