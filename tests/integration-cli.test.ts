/** End-to-end CLI: a separate Node process (no DOM) recalculates the archive with the real ports. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS } from '../src/presets';
import { createPorts, currentVersions, runProject } from '../src/integration/ports';
import { inputHash, newProject, type ProjectFile } from '../src/project/model';
import { exportProject } from '../src/project/archive';
import { resultJSON } from '../src/project/canonical';
import { encryptProject } from '../src/privacy/crypto';

const dir = mkdtempSync(join(tmpdir(), 'crashtest-cli-'));
const ports = createPorts();

async function saved(title: string, mutate?: (f: ProjectFile) => void): Promise<ProjectFile> {
  const f = newProject(PRESETS.find(p => p.title === title)!.build());
  f.project.extensions.rules = { mode: 'educational' };
  mutate?.(f);
  const run = await runProject(f.project, ports);
  if (run.physics.status !== 'ok') return f;
  f.savedResults = resultJSON({ physics: run.physics.value, rules: run.rules?.status === 'ok' ? run.rules.value : null }) as never;
  f.resultInputHash = await inputHash(f.project);
  f.versions = await currentVersions();
  return f;
}
function cli(bytes: Uint8Array, name: string, args: string[] = [], env: Record<string, string> = {}) {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  const r = spawnSync(process.execPath, ['src/cli/bin.mjs', '--json', ...args, file], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}
const title = 'Пешеход выбежал вне перехода';

describe('CLI crashtest-verify с реальными портами', () => {
  it('сохранённый результат воспроизводится в отдельном процессе: exit 0, версии совпадают', async () => {
    const r = cli(await exportProject(await saved(title)), 'match.crashtest');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.integrity).toBe('verified');
    expect(r.out.calculation).toBe('match');
    expect(r.out.versionStatus).toBe('same');
    expect(r.out.diff).toEqual([]);
  }, 120000);

  it('изменённый сохранённый результат — mismatch с путём различия: exit 1', async () => {
    const f = await saved(title);
    (f.savedResults as { physics: { timeline: { duration: number } } }).physics.timeline.duration += 1;
    const r = cli(await exportProject(f), 'mismatch.crashtest');
    expect(r.code).toBe(1);
    expect(r.out.diff).toContain('/physics/timeline/duration');
  }, 120000);

  it('без базового результата — no-baseline: exit 4', async () => {
    const f = newProject(PRESETS[0].build());
    const r = cli(await exportProject(f), 'nobase.crashtest');
    expect(r.code).toBe(4);
    expect(r.out.calculation).toBe('no-baseline');
  }, 120000);

  it('динамический режим без параметров ТС — явная недоступность: exit 3', async () => {
    const f = await saved(title, x => { x.project.scene.env.physics = 'dynamic'; });
    const r = cli(await exportProject(f), 'dynamic.crashtest');
    expect(r.code).toBe(3);
    expect(r.out.calculation).toBe('unavailable');
    expect(r.out.issues.length).toBeGreaterThan(0);
  }, 120000);

  it('AES-GCM: верный пароль из переменной окружения — match; неверный — exit 2 без вывода пароля', async () => {
    const bytes = await encryptProject(await exportProject(await saved(title)), 'верный пароль');
    const ok = cli(bytes, 'enc.crashtest', ['--password-env', 'CT_PW'], { CT_PW: 'верный пароль' });
    expect(ok.code).toBe(0);
    const bad = spawnSync(process.execPath, ['src/cli/bin.mjs', '--password-env', 'CT_PW', join(dir, 'enc.crashtest')], { encoding: 'utf8', env: { ...process.env, CT_PW: 'неверный' } });
    expect(bad.status).toBe(2);
    expect(bad.stdout + bad.stderr).not.toContain('неверный');
  }, 120000);
});
