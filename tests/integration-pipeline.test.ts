/**
 * End-to-end checks of the integrated build: real PhysicsPort + RulesPort on
 * every preset, explicit unsupported dynamic mode, the physics→rules braking
 * adapter, versions and the reports pipeline. Expected values are computed here
 * independently (closed-form stopping distance), not copied from the code.
 */
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { simulate, DT } from '../src/sim';
import { analyze } from '../src/analysis';
import { createPorts, currentVersions, ENGINE_VERSION, runProject, rulesMode } from '../src/integration/ports';
import { newProject, inputHash } from '../src/project/model';
import { reportDocument } from '../src/reports/model';
import type { ProjectEnvelope } from '../src/parallel/contracts';

const ports = createPorts();
const project = (build: () => ReturnType<(typeof PRESETS)[number]['build']>, rules: Record<string, unknown> = {}): ProjectEnvelope => {
  const p = newProject(build()).project;
  p.extensions.rules = rules as never;
  return p;
};

describe('интеграция: все пресеты через реальные порты', () => {
  it('кинематический режим: Timeline порта совпадает с прежним simulate() побитово', async () => {
    for (const preset of PRESETS) {
      const run = await ports.physics.simulate(project(preset.build));
      expect(run.status, preset.title).toBe('ok');
      if (run.status !== 'ok') continue;
      const legacy = simulate(preset.build());
      expect(run.value.timeline.n, preset.title).toBe(legacy.n);
      expect(run.value.timeline.physics?.mode).toBe('kinematic');
      for (const [id, tr] of legacy.tracks) {
        const got = run.value.timeline.tracks.get(id)!;
        for (const k of ['x', 'y', 'h', 'v'] as const) expect(Array.from(got[k]), `${preset.title} ${id}.${k}`).toEqual(Array.from(tr[k]));
      }
      expect(run.value.timeline.collisions.length, preset.title).toBe(legacy.collisions.length);
    }
  }, 120000);

  it('учебный режим RulesPort сохраняет все прежние выводы analyze(); добавлены только проверки раздела 19', async () => {
    for (const preset of PRESETS) {
      const p = project(preset.build, { mode: 'educational' });
      const run = await runProject(p, ports);
      expect(run.rules?.status, preset.title).toBe('ok');
      if (run.rules?.status !== 'ok' || run.physics.status !== 'ok') continue;
      const legacy = analyze(preset.build(), simulate(preset.build()));
      const key = (f: { actorId: string; refs: string[] }) => `${f.actorId} ${f.refs.join(',')}`;
      const got = run.rules.value.rules.findings.map(key);
      const before = legacy.rules.findings.map(key);
      for (const k of before) expect(got, preset.title).toContain(k);
      const extra = got.filter(k => !before.includes(k));
      for (const k of extra) expect(k, preset.title).toMatch(/ pdd:19\.\d+$/);
      expect(run.rules.value.hasCollision).toBe(legacy.hasCollision);
    }
  }, 120000);

  it('экспертный режим по умолчанию не подставляет учебный остановочный путь и вред', async () => {
    let collisions = 0;
    for (const preset of PRESETS) {
      const p = project(preset.build);
      expect(rulesMode(p)).toBe('expert');
      const run = await runProject(p, ports);
      expect(run.rules?.status, preset.title).toBe('ok');
      if (run.rules?.status !== 'ok') continue;
      for (const c of run.rules.value.technical.collisions) {
        collisions++;
        expect(c.tech).toEqual([]);
        expect(c.harm).toEqual([]);
        expect(c.trace.harmStatus).toBe('unknown');
      }
      expect(JSON.stringify(run.rules.value)).not.toMatch(/виновен/i);
    }
    expect(collisions).toBeGreaterThan(10);
  }, 120000);

  it('динамический режим: либо новое ядро для всех ТС, либо явный unsupported — без скрытой кинематики', async () => {
    const statuses = new Map<string, number>();
    for (const preset of PRESETS) {
      const p = project(preset.build);
      p.scene.env.physics = 'dynamic';
      const run = await ports.physics.simulate(p);
      statuses.set(run.status, (statuses.get(run.status) ?? 0) + 1);
      if (run.status === 'ok') {
        const tl = run.value.timeline;
        expect(tl.physics?.mode, preset.title).toBe('dynamic');
        expect(tl.physics?.substepSeconds).toBeLessThanOrEqual(0.005);
        // Every four-wheel vehicle is integrated by the force model and has samples.
        for (const [id, m] of Object.entries(tl.physics!.methods)) if (m === 'dynamic-four-wheel') expect(tl.tracks.get(id)!.dynamics, `${preset.title} ${id}`).toBeDefined();
        expect(Object.values(tl.physics!.methods)).not.toContain('legacy-kinematic');
        // Rules accept the dynamic Timeline (same DT) and do not recompute it.
        const rules = await ports.rules.evaluate(p, tl, run.value);
        expect(rules.status, preset.title).toBe('ok');
      } else {
        expect(run.status, preset.title).toBe('unsupported');
        expect(run.issues.length).toBeGreaterThan(0);
        for (const i of run.issues) expect(i.path ?? '', preset.title).toMatch(/^\/scene\/actors\/\d+$/);
        // The UI/workbench path never receives a kinematic substitute.
        expect('value' in run).toBe(false);
      }
    }
    expect(statuses.get('unsupported')).toBeGreaterThan(0);
    expect(statuses.get('ok')).toBeGreaterThan(0);
  }, 120000);
});

describe('интеграция: единицы и границы', () => {
  it('скорость сцены км/ч → Timeline м/с', async () => {
    const preset = PRESETS.find(p => p.build().actors.some(a => a.path.length > 1 && a.path.every(w => w.v === a.path[0].v) && a.path[0].v > 0))!;
    const scene = preset.build();
    const actor = scene.actors.find(a => a.path.length > 1 && a.path.every(w => w.v === a.path[0].v) && a.path[0].v > 0)!;
    const run = await ports.physics.simulate(project(preset.build));
    if (run.status !== 'ok') throw new Error('physics');
    const tr = run.value.timeline.tracks.get(actor.id)!;
    const k = tr.present.findIndex((p, i) => p === 1 && !tr.free[i] && i > 4);
    expect(tr.v[k]).toBeCloseTo(actor.path[0].v / 3.6, 3);
    expect(run.value.timeline.dt).toBe(DT);
  });

  it('повреждённые параметры физики дают error с путём, а не расчёт', async () => {
    const p = project(PRESETS[0].build);
    p.extensions.physics = { vehicles: { 'нет-такого': { braking: {} } } };
    const run = await ports.physics.simulate(p);
    expect(run.status).toBe('error');
    expect(run.issues[0].path).toBe('/extensions/physics/vehicles/нет-такого');
  });

  it('неизвестные факты света остаются неизвестными, а не false', async () => {
    const run = await runProject(project(PRESETS[0].build, { mode: 'educational' }), ports);
    if (run.rules?.status !== 'ok') throw new Error('rules');
    const lighting = run.rules.value.rules.findings.filter(f => f.refs.some(r => r.startsWith('pdd:19.')));
    expect(lighting.length).toBeGreaterThan(0);
    for (const f of lighting) expect(f.compliance).toBe('не определить');
  });

  it('версии: SemVer движка и хэш корпуса норм, стабильные между вызовами', async () => {
    const a = await currentVersions(), b = await currentVersions();
    expect(a.engine).toBe(ENGINE_VERSION);
    expect(a.engine).toMatch(/^\d+\.\d+\.\d+$/);
    expect(a.corpus).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b).toEqual(a);
  });
});

describe('интеграция: адаптер торможения физика → правила', () => {
  // Pedestrian preset with a vehicle collision.
  const preset = PRESETS.find(p => p.title === 'Пешеход выбежал вне перехода')!;
  const vehicleId = (() => { const s = preset.build(); return s.actors.find(a => !a.kind.startsWith('ped'))!.id; })();
  const t = { t1: 1.0, t2: 0.1, t3: 0.35, j: 6.8 };
  const src = 'Значение задано в проверочном сценарии (не методика)';

  async function scenario(availableDistanceRangeM: [number, number], extra: Record<string, unknown> = {}) {
    const p = project(preset.build);
    const base = await ports.physics.simulate(p);
    if (base.status !== 'ok') throw new Error('physics');
    const c = base.value.timeline.collisions[0];
    const frame = Math.round(c.t / DT) - 40;
    p.extensions.physics = { vehicles: { [vehicleId]: { braking: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { value: v, source: src }])) } } } as never;
    p.evidence = [{ id: 'avoid-1', kind: 'collision-avoidance', geometry: {}, source: 'Протокол осмотра (проверочный сценарий)',
      values: { actorId: vehicleId, frame, availableDistanceRangeM, hazardOnsetEstablished: true, hazardPerceivable: true, driverFailedToBrake: true, ...extra },
      uncertainty: { availableDistanceUnit: 'm' } }];
    p.extensions.rules = { expert: { bindings: [{ actorId: vehicleId, recordId: 'braking-avoid-1', observationId: 'avoid-1' }] } } as never;
    const run = await runProject(p, ports);
    const v0 = base.value.timeline.tracks.get(vehicleId)!.v[frame];
    return { run, v0, frame };
  }
  // Closed form, written independently of src/expert/stopping.ts.
  const S = (v: number) => v * (t.t1 + t.t2 + t.t3 / 2) + v * v / (2 * t.j);

  it('остановка возможна: диапазон пути ≤ доступного', async () => {
    const probe = await scenario([0, 0]);
    const need = S(probe.v0);
    const { run } = await scenario([need + 1, need + 2]);
    if (run.physics.status !== 'ok' || run.rules?.status !== 'ok') throw new Error(JSON.stringify(run));
    const rec = run.physics.value.calculations.find(c => c.id === 'braking-avoid-1')!;
    const [lo, hi] = (rec.result as { stoppingDistanceRangeM: number[] }).stoppingDistanceRangeM;
    expect(lo).toBeCloseTo(need, 6);
    expect(hi).toBeCloseTo(need, 6);
    expect(rec.inputs).toMatchObject({ actorId: vehicleId, brakingMode: 'emergency', t1: 1, t2: 0.1, t3: 0.35 });
    const f = run.rules.value.rules.findings.find(x => x.trace.expertProof);
    expect(f?.trace.canStop).toBe(true);
    expect(f?.severity).toBe('violation');
    expect(run.rules.value.technical.scientific?.status).toBe('provided');
  });

  it('остановка невозможна и пересечение диапазонов — неизвестность', async () => {
    const probe = await scenario([0, 0]);
    const need = S(probe.v0);
    const no = await scenario([need - 3, need - 2]);
    if (no.run.rules?.status !== 'ok') throw new Error('rules');
    const fNo = no.run.rules.value.rules.findings.find(x => x.trace.expertProof);
    expect(fNo?.trace.canStop).toBe(false);
    expect(fNo?.severity).not.toBe('violation');
    const mid = await scenario([need - 1, need + 1]);
    if (mid.run.rules?.status !== 'ok') throw new Error('rules');
    expect(mid.run.rules.value.rules.findings.find(x => x.trace.expertProof)?.trace.canStop).toBeNull();
  });

  it('без t3 расчёт не выполняется и правила не получают доказательства', async () => {
    const p = project(preset.build);
    p.extensions.physics = { vehicles: { [vehicleId]: { braking: { t1: { value: 1, source: src }, t2: { value: 0.1, source: src }, j: { value: 6.8, source: src } } } } } as never;
    p.evidence = [{ id: 'avoid-1', kind: 'collision-avoidance', geometry: {}, source: 'x', values: { actorId: vehicleId, frame: 10, availableDistanceRangeM: [10, 20] }, uncertainty: { availableDistanceUnit: 'm' } }];
    p.extensions.rules = { expert: { bindings: [{ actorId: vehicleId, recordId: 'r', observationId: 'avoid-1' }] } } as never;
    const run = await runProject(p, ports);
    if (run.physics.status !== 'ok' || run.rules?.status !== 'ok') throw new Error('run');
    expect(run.physics.value.calculations.some(c => c.id === 'r')).toBe(false);
    expect(run.physics.issues.some(i => i.code === 'integration.missing-input' && /t3/.test(i.message))).toBe(true);
    expect(run.rules.value.rules.findings.some(x => x.trace.expertProof)).toBe(false);
  });
});

describe('интеграция: отчёт и сохранённые результаты', () => {
  it('отчёт строится из результатов реальных портов; правовая часть по умолчанию выключена', async () => {
    const f = newProject(PRESETS.find(p => p.title === 'Пешеход выбежал вне перехода')!.build());
    f.project.extensions.rules = { mode: 'educational' };
    const run = await runProject(f.project, ports);
    if (run.physics.status !== 'ok' || run.rules?.status !== 'ok') throw new Error('run');
    const opts = { template: 'specialist' as const, author: 'a', request: 'r', date: '2026-10-23', questions: [] };
    const doc = await reportDocument(f, run.physics.value.calculations, run.rules.value, opts);
    expect(doc.inputHash).toBe(await inputHash(f.project));
    expect(doc.sections.map(x => x.title)).not.toContain('Legal — переданная правовая оценка');
    const withLegal = await reportDocument(f, run.physics.value.calculations, run.rules.value, { ...opts, template: 'commissioner', includeLegal: true });
    expect(withLegal.sections.map(x => x.title)).toContain('Legal — переданная правовая оценка');
    expect(doc.sections.some(x => x.lines.some(l => /Правовой порт не подключён/.test(l)))).toBe(false);
    expect(doc.text).not.toMatch(/виновен/i);
  });
});
