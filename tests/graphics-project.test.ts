import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { canonical, sha256, utf8 } from '../src/project/canonical';
import { exportProject, importProject } from '../src/project/archive';
import { newProject, ProjectHistory, inputHash } from '../src/project/model';
import { emptyScene } from '../src/scene';
import { verifyProject } from '../src/project/verifier';
import { encryptProject, decryptProject } from '../src/privacy/crypto';
import { redactProject } from '../src/privacy/redact';
import { main } from '../src/cli/verify';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { PhysicsPort } from '../src/parallel/contracts';
describe('project files and privacy', () => {
  it('uses round-trip precision, sorted keys and explicit -0, rejects non-JSON', () => {
    expect(canonical({ z: -0, a: 0.12345678901234567 })).toBe(
      '{"a":0.12345678901234566,"z":0}',
    );
    for (const v of [NaN, Infinity, undefined, { x: undefined }, new Map()])
      expect(() => canonical(v)).toThrow();
    expect(JSON.parse(canonical({ x: Number.MIN_VALUE })).x).toBe(
      Number.MIN_VALUE,
    );
  });
  it('SHA256 matches NIST abc vector', async () =>
    expect(await sha256(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    ));
  it('roundtrips originals including zero bytes, envelope, versions and journal', async () => {
    const f = newProject(emptyScene());
    f.attachments.push({
      id: 'photo',
      name: 'Фото.jpg',
      type: 'image/jpeg',
      metadata: { exif: { note: 'original' } },
      bytes: new Uint8Array([0, 255, 4, 0]),
    });
    const h = new ProjectHistory(f);
    const p = structuredClone(f.project);
    p.extensions.physics.zones = [{ mu: 0.12345678901234567 }];
    h.change(p, 'measurement');
    const bytes = await exportProject(f),
      r = await importProject(bytes);
    expect(r).toEqual(f);
    expect(unzipSync(bytes)['manifest.json']).toBeDefined();
  });
  it('detects modified, omitted and extra payload before accepting it', async () => {
    const entries = unzipSync(await exportProject(newProject(emptyScene())));
    entries['scene.json'] = strToU8('{}');
    await expect(importProject(zipSync(entries))).rejects.toThrow('SHA-256');
    entries['x.json'] = strToU8('{}');
    await expect(importProject(zipSync(entries))).rejects.toThrow('payload');
  });
  it('rejects traversal, unsupported versions and non-scenes; migrates legacy', async () => {
    await expect(
      importProject(zipSync({ '../outside': strToU8('x') })),
    ).rejects.toThrow('путь');
    await expect(importProject(utf8('{"contractVersion":2}'))).rejects.toThrow(
      'версия',
    );
    await expect(importProject(utf8('{}'))).rejects.toThrow('Не сцена');
    expect(
      (await importProject(utf8(JSON.stringify(emptyScene())))).project
        .contractVersion,
    ).toBe(1);
  });
  it('undo/redo/restore are auditable; no-op/camera produces no record', () => {
    const h = new ProjectHistory(newProject(emptyScene()), 'Автор');
    expect(h.change(h.file.project, 'camera')).toBe(false);
    const p = structuredClone(h.file.project);
    p.scene.name = 'changed';
    h.change(p, 'rename');
    h.undo();
    expect(h.file.project.scene.name).not.toBe('changed');
    h.redo();
    expect(h.file.project.scene.name).toBe('changed');
    h.restore(1);
    expect(h.file.journal.map((e) => e.action)).toEqual([
      'rename',
      'undo',
      'redo',
      'restore:1',
    ]);
  });
  it('AES-GCM roundtrip, random salt/nonce, wrong password, tampering', async () => {
    const a = await encryptProject(utf8('исходник'), 'пароль'),
      b = await encryptProject(utf8('исходник'), 'пароль');
    expect(a).not.toEqual(b);
    expect(new TextDecoder().decode(await decryptProject(a, 'пароль'))).toBe(
      'исходник',
    );
    await expect(decryptProject(a, 'wrong')).rejects.toThrow('пароль');
    a[a.length - 1] ^= 1;
    await expect(decryptProject(a, 'пароль')).rejects.toThrow('целостность');
  });
  it('redacts original files, EXIF, arbitrary extension, history, IDs and free text', async () => {
    const h = new ProjectHistory(newProject(emptyScene()), 'Иван Петров');
    const p = structuredClone(h.file.project);
    p.scene.name = 'А123АА';
    p.extensions.workspace = { policy: 'SECRET', address: 'Адрес' };
    h.change(p, 'SECRET');
    h.file.attachments = [
      {
        id: 'photo',
        name: 'SECRET.jpg',
        type: 'image/jpeg',
        bytes: utf8('SECRET'),
        metadata: { exif: 'SECRET' },
      },
    ];
    h.file.savedResults = { SECRET: true };
    const r = await importProject(await exportProject(redactProject(h.file)));
    expect(JSON.stringify(r)).not.toMatch(/SECRET|А123АА|Иван Петров|Адрес/);
    expect(r.journal).toEqual([]);
    expect(r.attachments).toEqual([]);
  });
  it('separates archive integrity and unavailable calculation', async () =>
    expect(
      (await verifyProject(newProject(emptyScene()), {})).calculation,
    ).toBe('unavailable'));
  it('uses injected engine and shows actual diff and versions (synthetic UI fixture)', async () => {
    const f = newProject(emptyScene());
    const physics: PhysicsPort = {
      contractVersion: 1,
      describe: () => [],
      calculate: async () => ({ status: 'unsupported', issues: [] }),
      simulate: async () => ({
        status: 'ok',
        issues: [],
        value: {
          timeline: {
            dt: 1,
            n: 1,
            duration: 0,
            mu: 0.5,
            tracks: new Map(),
            collisions: [],
          },
          calculations: [],
          technical: { measured: 1 },
          observations: [],
        },
      }),
    };
    const first = await verifyProject(f, { physics });
    expect(first.calculation).toBe('no-baseline');
    f.savedResults = first.results;
    f.resultInputHash = await inputHash(f.project);
    expect((await verifyProject(f, { physics })).calculation).toBe('match');
    f.resultInputHash = 'changed';
    expect(
      (await verifyProject(f, { physics }, { ...f.versions, engine: 'new' }))
        .diff,
    ).toContain('/resultInputHash');
  });
  it('CLI has distinct codes for absent engine, integrity-only and invalid files', async () => {
    const dir = await mkdtemp(tmpdir() + '/crashtest-');
    try {
      const path = dir + '/test.crashtest';
      await writeFile(path, await exportProject(newProject(emptyScene())));
      expect(await main([path, '--json'])).toBe(3);
      expect(await main([path, '--integrity-only'])).toBe(0);
      expect(await main(['--unknown'])).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('an imported archive loses verified provenance after in-memory mutation', async () => {
  const source = newProject(emptyScene());
  source.attachments.push({
    id: 'original',
    name: 'fixture.bin',
    type: 'application/octet-stream',
    metadata: {},
    bytes: new Uint8Array([1, 2, 3]),
  });
  const imported = await importProject(await exportProject(source));
  expect((await verifyProject(imported, {})).integrity).toBe('verified');
  imported.attachments[0].bytes[0] = 9;
  expect((await verifyProject(imported, {})).integrity).toBe('not-checked');
});
