import { it, expect } from 'vitest';
import { emptyScene } from '../src/scene';
import { newProject, inputHash } from '../src/project/model';
import { canonical, resultJSON } from '../src/project/canonical';
import {
  writePointer,
  readPointer,
  validateInput,
} from '../src/workbench/inputs';
import { savedData } from '../src/project/results';
import { diagnostics } from '../src/workbench/diagnostics';
import { chartPNG } from '../src/reports/charts';
import { exportDOCX, exportPDF } from '../src/reports/export';
import { reportDocument } from '../src/reports/model';
import { decode } from 'fast-png';
import { unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import type { CalculationRecord } from '../src/parallel/contracts';
import type { Report } from '../src/analysis/types';
it('descriptor pointers preserve false versus unknown, escaped IDs, and existing scene paths', () => {
  const f = newProject(emptyScene());
  const a = writePointer(f.project, '/extensions/rules/a~1b~0c', false);
  expect(readPointer(a, '/extensions/rules/a~1b~0c')).toBe(false);
  expect(
    readPointer(
      writePointer(a, '/extensions/rules/a~1b~0c', undefined),
      '/extensions/rules/a~1b~0c',
    ),
  ).toBeUndefined();
  expect(writePointer(a, '/scene/name', 'new').scene.name).toBe('new');
  expect(() => writePointer(a, '/extensions/rules/__proto__/evil', 1)).toThrow(
    'Запрещённый',
  );
  expect(() => writePointer(a, '/alien/key', 1)).toThrow('контракта');
  expect(validateInput({ kind: 'boolean', path: '', label: '' }, 'false')).toBe(
    false,
  );
  expect(
    validateInput(
      { kind: 'number', minimum: 0, maximum: 1, path: '', label: '' },
      '',
    ),
  ).toBeUndefined();
  expect(() =>
    validateInput(
      { kind: 'number', minimum: 0, maximum: 1, path: '', label: '' },
      '2',
    ),
  ).toThrow();
});
it('sparse arrays and nonfinite values cannot become deceptively valid JSON', () => {
  expect(() => canonical(new Array(2))).toThrow();
  expect(() => canonical({ a: Infinity })).toThrow();
});
it('saved timeline rehydrates as data with original dt; stale input hash is rejected', async () => {
  const f = newProject(emptyScene());
  f.resultInputHash = await inputHash(f.project);
  f.savedResults = resultJSON({
    physics: {
      timeline: {
        dt: 0.1,
        n: 2,
        duration: 0.1,
        mu: 0.4,
        tracks: new Map([
          [
            'a',
            {
              id: 'a',
              x: new Float32Array([0, 1]),
              y: new Float32Array([0, 0]),
              h: new Float32Array([0, 0]),
              v: new Float32Array([10, 10]),
              present: new Uint8Array([1, 1]),
              free: new Uint8Array(2),
            },
          ],
        ]),
        collisions: [],
      },
      calculations: [],
      technical: {},
      observations: [],
    },
    rules: null,
  }) as any;
  const r = await savedData(f);
  expect(r.output?.timeline.dt).toBe(0.1);
  expect(r.output?.timeline.tracks.get('a')?.x[1]).toBe(1);
  f.project.scene.name = 'new';
  expect((await savedData(f)).output).toBeUndefined();
});
it('supplied histogram/tornado values are preserved in PNG, PDF and actual DOCX media', async () => {
  const c: CalculationRecord = {
    id: 'synthetic',
    method: 'synthetic-ui',
    formula: 'fixture',
    inputs: {},
    result: {
      figures: [
        {
          title: 'Синтетическая чувствительность',
          kind: 'tornado',
          unit: 'м',
          xUnit: 'м',
          yUnit: 'параметр',
          points: [
            { x: -2, y: 1 },
            { x: 3, y: 2 },
          ],
        },
      ],
      residuals: [{ evidenceId: 'e', value: 0.2, unit: 'м' }],
    },
    units: {},
    sources: ['Синтетические данные'],
    assumptions: ['Только формат документа'],
  };
  const d = diagnostics([c]);
  expect(d.residuals).toEqual([{ evidenceId: 'e', value: 0.2, unit: 'м' }]);
  const png = chartPNG(d.figures[0]);
  expect(decode(png).width).toBe(700);
  const doc = await reportDocument(newProject(emptyScene()), [c], undefined, {
    template: 'specialist',
    author: '',
    date: '2026-10-22',
    request: '',
    questions: [],
  });
  const zip = unzipSync(await exportDOCX(doc));
  expect(
    Object.keys(zip).some(
      (p) => p.startsWith('word/media/') && p.endsWith('.png'),
    ),
  ).toBe(true);
  const font = new Uint8Array(
    await readFile(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url)),
  );
  expect((await exportPDF(doc, font)).length).toBeGreaterThan(1000);
});
it('legal stays absent by default even when supplied; explicit inclusion uses supplied text only', async () => {
  const report = {
    accidentDate: '2026-10-22',
    laws: [],
    legalWarnings: [],
    technical: { assumptions: [], events: [], collisions: [] },
    rules: { findings: [] },
    legal: {
      assessmentDate: '2026-10-22',
      editionDate: '2026-10-22',
      verdicts: [
        {
          legal: [
            { text: 'SYNTHETIC LEGAL SENTINEL', refs: ['fixture'], trace: {} },
          ],
        },
      ],
    },
  } as unknown as Report;
  const options = {
      template: 'specialist' as const,
      author: '',
      date: '2026-10-22',
      request: '',
      questions: [],
    },
    f = newProject(emptyScene());
  expect((await reportDocument(f, [], report, options)).text).not.toContain(
    'SYNTHETIC LEGAL SENTINEL',
  );
  expect(
    (await reportDocument(f, [], report, { ...options, includeLegal: true }))
      .text,
  ).toContain('SYNTHETIC LEGAL SENTINEL');
});
