/** Shared-boundary checks of the integrated build: seeded determinism, cancel,
 * non-mutation of the project, ZIP round trip of envelope namespaces and the
 * result hash reproducibility used by the verifier. */
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { createPorts, runProject } from '../src/integration/ports';
import { inputHash, newProject } from '../src/project/model';
import { exportProject, importProject } from '../src/project/archive';
import { canonical, resultJSON, sha256, utf8 } from '../src/project/canonical';
import { verifyProject } from '../src/project/verifier';

const ports = createPorts();
const mc = { model: 'expert.braking', seed: 20261023, n: 500,
  inputs: { v0: { kind: 'uniform', min: 13, max: 15 }, available: { kind: 'fixed', value: 40 }, t1: { kind: 'triangular', min: 0.6, mode: 0.8, max: 1.2 },
    t2: { kind: 'fixed', value: 0.1 }, t3: { kind: 'fixed', value: 0.35 }, j: { kind: 'normal', mean: 6.8, sd: 0.4, min: 5.5, max: 8 } } };

describe('границы интеграции', () => {
  it('Монте-Карло через порт детерминирован по seed и меняется при другом seed', async () => {
    const p = newProject(PRESETS[0].build()).project;
    const a = await ports.physics.calculate('reconstruction.monte-carlo', p, mc);
    const b = await ports.physics.calculate('reconstruction.monte-carlo', p, mc);
    const c = await ports.physics.calculate('reconstruction.monte-carlo', p, { ...mc, seed: 1 });
    if (a.status !== 'ok' || b.status !== 'ok' || c.status !== 'ok') throw new Error('mc');
    expect(canonical(resultJSON(a.value))).toBe(canonical(resultJSON(b.value)));
    expect(canonical(resultJSON(a.value))).not.toBe(canonical(resultJSON(c.value)));
  });

  it('отмена Монте-Карло: результат помечен как остановленный, а не полный', async () => {
    const p = newProject(PRESETS[0].build()).project;
    let calls = 0;
    const r = await ports.physics.calculate('reconstruction.monte-carlo', p, { ...mc, n: 5000 }, { isCancelled: () => ++calls > 2 });
    if (r.status !== 'ok') throw new Error('mc');
    expect(r.issues.some(i => i.code === 'cancelled')).toBe(true);
    expect((r.value[0].result as { status: string }).status).toBe('cancelled');
  });

  it('конвейер не изменяет проект и даёт одинаковый хэш результатов при повторе', async () => {
    const f = newProject(PRESETS.find(p => p.title === 'Пешеход выбежал вне перехода')!.build());
    f.project.extensions.rules = { mode: 'educational' };
    const before = canonical(f.project);
    const hash = async () => {
      const run = await runProject(f.project, ports);
      if (run.physics.status !== 'ok' || run.rules?.status !== 'ok') throw new Error('run');
      return sha256(utf8(canonical(resultJSON({ physics: run.physics.value, rules: run.rules.value }))));
    };
    expect(await hash()).toBe(await hash());
    expect(canonical(f.project)).toBe(before);
  });

  it('ZIP сохраняет все namespace extensions и evidence; verifyProject совпадает после импорта', async () => {
    const f = newProject(PRESETS[0].build());
    f.project.extensions = {
      physics: { zones: [{ id: 'z1', boundary: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], mu: 0.42, source: 'измерение' }], custom: { keep: true } },
      rules: { mode: 'educational', lighting: { timeOfDay: 'night' } },
      workspace: { note: 'исходная пометка', nested: { a: [1, 2, 3] } },
    };
    f.project.evidence = [{ id: 'e1', kind: 'rest-pose', geometry: { x: 1.25, y: -3 }, values: { actorId: f.project.scene.actors[0].id }, source: 'схема ДТП', uncertainty: { position: 0.2 } }];
    const run = await runProject(f.project, ports);
    if (run.physics.status !== 'ok') throw new Error(JSON.stringify(run.physics.issues));
    f.savedResults = resultJSON({ physics: run.physics.value, rules: run.rules?.status === 'ok' ? run.rules.value : null }) as never;
    f.resultInputHash = await inputHash(f.project);
    const back = await importProject(await exportProject(f));
    expect(canonical(back.project)).toBe(canonical(f.project));
    const v = await verifyProject(back, ports);
    expect(v.integrity).toBe('verified');
    expect(v.calculation).toBe('match');
  });

  it('старая сцена без extensions рассчитывается без потери полей Scene', async () => {
    for (const preset of PRESETS.slice(0, 10)) {
      const legacy = JSON.parse(JSON.stringify(preset.build()));
      const f = newProject(legacy);
      expect(canonical(f.project.scene)).toBe(canonical(resultJSON(legacy)));
      const run = await ports.physics.simulate(f.project);
      expect(run.status, preset.title).toBe('ok');
    }
  });
});
