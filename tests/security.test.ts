/**
 * Stage 18 checks owned by the integrator: no network APIs to third parties in
 * the source, strict CSP, URL sharing of project data disabled, and the
 * redacted export of a project that was actually calculated by the real ports
 * carries no saved results, history, originals or personal fields.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS } from '../src/presets';
import { createPorts, runProject } from '../src/integration/ports';
import { inputHash, newProject } from '../src/project/model';
import { resultJSON, utf8 } from '../src/project/canonical';
import { canShareByURL, redactProject } from '../src/privacy/redact';
import { exportProject, importProject } from '../src/project/archive';

const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|js|mjs)$/.test(n) ? [p] : [];
});

describe('безопасность интегрированной сборки', () => {
  it('исходники приложения не используют сетевые API, кроме локального шрифта', () => {
    const uses = walk('src').filter(f => !f.startsWith(join('src', 'cli')))
      .flatMap(f => [...readFileSync(f, 'utf8').matchAll(/\b(fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts\()/g)].map(m => `${f}:${m[1]}`));
    expect(uses).toEqual([join('src', 'workbench', 'mount.ts') + ':fetch(']);
    const mount = readFileSync('src/workbench/mount.ts', 'utf8');
    expect(mount).toMatch(/fetch\(\s*new URL\('fonts\/DejaVuSans\.ttf', document\.baseURI\)/);
    // Service worker answers only same-origin GETs from the build's own list.
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain('url.origin!==self.location.origin)return;');
  });

  it('CSP: только свой источник, без eval/inline-скриптов и внешних соединений', () => {
    const html = readFileSync('index.html', 'utf8');
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    const directive = (name: string) => csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' ')) ?? '';
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|\*/);
  });

  it('ссылка с данными проекта не создаётся', () => {
    const f = newProject(PRESETS[0].build());
    expect(canShareByURL(f)).toBe(false);
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).not.toMatch(/location\.hash\s*=|#s=\$\{|history\.(push|replace)State/);
  });

  it('обезличенный экспорт рассчитанного проекта: без результатов, журнала, оригиналов и ПДн', async () => {
    const f = newProject(PRESETS.find(p => p.title === 'Пешеход выбежал вне перехода')!.build());
    f.project.scene.name = 'Иванов И. И., А123АА 77';
    f.project.extensions.workspace = { participants: [{ name: 'Иванов Иван', plate: 'А123АА77', policy: 'XXX 0123456789' }] };
    f.project.extensions.rules = { mode: 'educational' };
    f.attachments.push({ id: 'ph1', name: 'IMG_0001.jpg', type: 'image/jpeg', bytes: utf8('Exif Иванов'), metadata: { gps: '55.75,37.61' } });
    f.journal.push({ at: '2026-10-23T10:00:00Z', who: 'Петров', action: 'Правка', before: f.project, after: f.project });
    const run = await runProject(f.project, createPorts());
    if (run.physics.status !== 'ok') throw new Error('physics');
    f.savedResults = resultJSON({ physics: run.physics.value, rules: run.rules?.status === 'ok' ? run.rules.value : null }) as never;
    f.resultInputHash = await inputHash(f.project);
    const back = await importProject(await exportProject(redactProject(f)));
    const text = JSON.stringify(back);
    for (const secret of ['Иванов', 'А123АА', '0123456789', 'Петров', 'IMG_0001', '55.75']) expect(text).not.toContain(secret);
    expect(back.savedResults).toBeUndefined();
    expect(back.journal).toEqual([]);
    expect(back.attachments).toEqual([]);
  });

  it.skipIf(!existsSync('dist'))('в собранном dist нет внешних адресов вне списка с обоснованием', async () => {
    const { auditBuild } = await import('../tools/audit-build.mjs');
    const { unknown } = await auditBuild('dist');
    expect(unknown).toEqual([]);
  });
});
