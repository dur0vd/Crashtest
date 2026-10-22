import { readFile, stat } from 'node:fs/promises';
import { importProject } from '../project/archive';
import { verifyProject } from '../project/verifier';
import { isEncrypted, decryptProject } from '../privacy/crypto';
import { sha256 } from '../project/canonical';
import type { Versions } from '../project/model';
import type { WorkbenchPorts } from '../parallel/contracts';
/** Integrator supplies real factories here or calls main(args, ports, versions).
 * No dynamic execution of code specified by an untrusted project archive.
 */
export async function main(
  args: string[],
  ports: WorkbenchPorts = {},
  versions?: Versions,
): Promise<number> {
  if (args.includes('--help')) {
    console.log(
      'crashtest-verify [--json] [--integrity-only] [--password-env NAME] project.crashtest\nExit: 0 match/integrity-only; 1 mismatch; 2 invalid; 3 engine unavailable; 4 no baseline; 5 engine error.',
    );
    return 0;
  }
  const rest = [...args];
  const json = rest.includes('--json'),
    integrityOnly = rest.includes('--integrity-only');
  let password: string | undefined;
  const pi = rest.indexOf('--password-env');
  if (pi >= 0) {
    const name = rest[pi + 1];
    if (!name || name.startsWith('-')) return 2;
    password = process.env[name];
    rest.splice(pi, 2);
  }
  const files = rest.filter((a) => !['--json', '--integrity-only'].includes(a));
  if (files.length !== 1 || files[0].startsWith('-')) {
    console.error('Нужен один файл проекта; --help');
    return 2;
  }
  try {
    if ((await stat(files[0])).size > 256 * 1024 * 1024)
      throw new Error('Лимит проекта 256 MiB');
    let bytes: Uint8Array = new Uint8Array(await readFile(files[0]));
    if (isEncrypted(bytes)) bytes = await decryptProject(bytes, password ?? '');
    const file = await importProject(bytes);
    const result = await verifyProject(
      file,
      integrityOnly ? {} : ports,
      versions,
    );
    const materials = await Promise.all(
      file.attachments.map(async (a) => ({
        id: a.id,
        name: a.name,
        sha256: await sha256(a.bytes),
      })),
    );
    console.log(
      json
        ? JSON.stringify(
            { ...result, materials, savedBaseline: file.savedResults ?? null },
            null,
            2,
          )
        : `Целостность: ${result.integrity}. SHA-256 входов: ${result.inputHash}\nВерсии: ${JSON.stringify(result.versions)}; сопоставление версий: ${result.versionStatus}\nМатериалы: ${JSON.stringify(materials)}\nПересчёт: ${result.calculation}\nРазличия: ${result.diff.join(', ') || '—'}`,
    );
    if (integrityOnly) return result.integrity === 'verified' ? 0 : 2;
    return {
      match: 0,
      mismatch: 1,
      unavailable: 3,
      'no-baseline': 4,
      error: 5,
    }[result.calculation];
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
