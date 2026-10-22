import { describe, expect, it } from 'vitest';
import { actorSpec, dimsOf, emptyScene, normalizeScene, NO_CARGO, type Actor } from '../src/scene';
import { dynamicSupport, initialDynamicState, parametersFromReference, syntheticVehicle, validateDynamicParameters, VEHICLE_REFERENCES } from '../src/physics';
import { simulate } from '../src/sim';
import { analyzeTechnical } from '../src/analysis/technical';
import { PRESETS } from '../src/presets';

function car(): Actor {
  return { id: 'a1', kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 36, path: [],
    color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } };
}

describe('explicit dynamic parameters, scene compatibility and provenance', () => {
  it('no parameters are manufactured during migration; absent ABS stays unknown', () => {
    const scene = emptyScene(); scene.actors = [car()];
    const loaded = normalizeScene(JSON.parse(JSON.stringify(scene)));
    expect(loaded.actors[0].dynamics).toBeUndefined();
    expect(dynamicSupport(loaded.actors[0]).supported).toBe(false);
    expect(syntheticVehicle().brakes.abs).toBe('unknown');
    loaded.actors[0].dynamics = syntheticVehicle();
    const roundtrip = normalizeScene(JSON.parse(JSON.stringify(loaded)));
    expect(roundtrip.actors[0].dynamics).toEqual(loaded.actors[0].dynamics);
    expect(roundtrip.env.accidentDate).toBe(loaded.env.accidentDate);
  });
  it('reference chassis and synthetic/measured equipment keep distinct provenance', () => {
    const fixture = syntheticVehicle();
    for (const ref of VEHICLE_REFERENCES) {
      const p = parametersFromReference(ref.id, fixture);
      expect(p.body.source.kind).toBe('reference');
      expect(p.tyres.source.kind).toBe('synthetic');
      expect(p.brakes.abs).toBe('unknown');
      expect(p.body.source.url).toContain('8de058935fdf5b404eef0836785b4cc1830e6d09');
      expect(p.vehicleTypes).not.toContain('bus');
      p.body.mass = 999;
      expect(ref.body.mass).not.toBe(999);
    }
    const measured = structuredClone(fixture);
    measured.body.source = { kind: 'measured', description: 'Test-only provenance example, not actual measurement' };
    expect(() => validateDynamicParameters(measured)).not.toThrow();
  });
  it('never applies car references to buses/trains/pedestrians/two-wheelers; custom four-wheel sets are explicit', () => {
    const actor = car(); actor.dynamics = parametersFromReference('commonroad-vehicle1', syntheticVehicle());
    for (const type of ['bus', 'tram', 'bicycle', 'motorcycle'] as const) {
      actor.type = type;
      expect(dynamicSupport(actor).supported).toBe(false);
      expect(() => actorSpec(actor)).toThrow();
    }
    actor.type = 'bus'; actor.dynamics = syntheticVehicle(); actor.dynamics.vehicleTypes = ['bus'];
    expect(dynamicSupport(actor).supported).toBe(true); // explicit synthetic fixture, not a measured bus
    actor.kind = 'pedestrian'; actor.type = 'adult';
    expect(dynamicSupport(actor).supported).toBe(false);
  });
  it.each(['mass', 'yawInertia', 'lf', 'lr', 'trackFront', 'length', 'width'] as const)('rejects missing/nonpositive/nonfinite %s on import', key => {
    const scene = emptyScene(), a = car(); scene.actors = [a]; a.dynamics = syntheticVehicle();
    for (const value of [0, -1, NaN, Infinity]) {
      a.dynamics.body[key] = value;
      expect(() => normalizeScene(structuredClone(scene))).toThrow();
    }
  });
  it('rejects invalid geometry, missing source/ABS and separately added cargo mass', () => {
    const a = car(); a.dynamics = syntheticVehicle();
    a.dynamics.body.lf = 5;
    expect(() => actorSpec(a)).toThrow(/кузова/);
    a.dynamics = syntheticVehicle(); a.dynamics.tyres.source.description = '';
    expect(() => actorSpec(a)).toThrow(/источника/);
    a.dynamics = syntheticVehicle();
    delete (a.dynamics.brakes as Partial<typeof a.dynamics.brakes>).abs;
    expect(() => actorSpec(a)).toThrow(/ABS/);
    a.dynamics = syntheticVehicle(); a.cargo = { ...NO_CARGO, mass: 100 };
    expect(() => actorSpec(a)).toThrow(/груза/);
  });
  it('single mass/geometry source reaches actorSpec, collision impulses, technical and trace', () => {
    const scene = emptyScene(); scene.env.duration = 3;
    const a = car(), b = car();
    a.dynamics = parametersFromReference('commonroad-vehicle1', syntheticVehicle());
    b.id = 'a2'; b.x = 40; b.heading = Math.PI;
    b.dynamics = syntheticVehicle(); b.dynamics.body.mass = 2400;
    scene.actors = [a, b];
    const spec = actorSpec(a), dims = dimsOf(a);
    expect(spec.mass).toBe(a.dynamics.body.mass);
    expect(dims.length).toBe(a.dynamics.body.length);
    expect(dims.width).toBe(a.dynamics.body.width);
    const tl = simulate(scene), impact = tl.collisions[0];
    expect(impact).toBeDefined();
    expect(impact.dvA / impact.dvB).toBeCloseTo(b.dynamics.body.mass / a.dynamics.body.mass, 10);
    const ctx = analyzeTechnical(scene, tl);
    expect(ctx.infos.get(a.id)!.mass).toBe(spec.mass);
    expect(ctx.infos.get(a.id)!.hl * 2).toBe(spec.length);
    const participants = ctx.technical.collisions[0].trace.participants as { physicalParameters: { massKg: number; motionMethod: string } }[];
    expect(participants[0].physicalParameters.massKg).toBe(spec.mass);
    expect(participants[0].physicalParameters.motionMethod).toBe('legacy-kinematic');
  });
  it('CG pose and OBB offset are explicit; signed speed converts km/h to SI once', () => {
    const a = car(); a.dynamics = syntheticVehicle(); a.dynamics.body.bodyCenterOffset = 0.2;
    expect(dimsOf(a).shift).toBe(0.2);
    a.speed = -36; a.heading = Math.PI / 2;
    const s = initialDynamicState(a);
    expect(s.vx).toBeCloseTo(0, 12); expect(s.vy).toBeCloseTo(-10, 12);
    expect(s.heading).toBe(a.heading);
  });
});

describe('all existing presets retain the kinematic path without manufactured physics', () => {
  it.each(PRESETS.map(p => [p.id, p] as const))('%s', (_id, preset) => {
    const scene = preset.build(), before = structuredClone(scene);
    const tl = simulate(scene);
    expect(scene).toEqual(before);
    expect(scene.actors.every(a => a.dynamics === undefined)).toBe(true);
    for (const track of tl.tracks.values()) {
      for (const series of [track.x, track.y, track.h, track.v]) expect([...series].every(Number.isFinite)).toBe(true);
    }
  });
});
