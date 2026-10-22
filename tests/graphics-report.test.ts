import { it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { PRESETS } from '../src/presets';
import { newProject } from '../src/project/model';
import { reportDocument, type ReportTemplate } from '../src/reports/model';
import { exportPDF, exportDOCX, schemePDF } from '../src/reports/export';
import { newEvidence } from '../src/evidence/model';
const font = await readFile(
  new URL('../public/fonts/DejaVuSans.ttf', import.meta.url),
);
for (const [i, template] of (
  ['commissioner', 'specialist', 'training'] as ReportTemplate[]
).entries())
  it(`real preset text snapshot: ${template}`, async () => {
    const scene = PRESETS[i].build();
    scene.env.accidentDate = '2026-10-22T12:00';
    const file = newProject(scene);
    const doc = await reportDocument(file, [], undefined, {
      template,
      author: 'Тестовый автор',
      request: 'Проверка структуры',
      date: '2026-10-22',
      questions: [{ text: 'Какова скорость?', calculationIds: [] }],
    });
    expect(doc.text).toMatchSnapshot();
    expect(doc.text).not.toContain('Legal —');
    expect(doc.text).not.toMatch(/виновен/i);
    expect(doc.text).toContain('недостаточно данных');
  });
it('PDF actually opens, extracts Cyrillic and full SHA256; DOCX XML has Cyrillic and links to calculation IDs', async () => {
  const file = newProject(PRESETS[0].build());
  const doc = await reportDocument(
    file,
    [
      {
        id: 'synthetic-1',
        method: 'synthetic-test-fixture',
        inputs: { v: 3 },
        formula: 'x = v · t',
        result: { x: 6 },
        units: { x: 'м' },
        sources: ['Синтетические данные теста'],
        assumptions: ['Только проверка экспорта'],
      },
    ],
    undefined,
    {
      template: 'specialist',
      author: 'Иван',
      request: 'Запрос',
      date: '2026-10-22',
      questions: [{ text: 'Перемещение', calculationIds: ['synthetic-1'] }],
    },
  );
  const bytes = await exportPDF(doc, font);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
  const dir = await mkdtemp(tmpdir() + '/crashtest-pdf-');
  try {
    await writeFile(dir + '/report.pdf', bytes);
    const text = execFileSync('pdftotext', [dir + '/report.pdf', '-'], {
      encoding: 'utf8',
    });
    expect(text).toContain('Расчёт для специалиста');
    expect(text.replace(/\s/g, '')).toContain(doc.inputHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const xml = strFromU8(unzipSync(await exportDOCX(doc))['word/document.xml']);
  expect(xml).toContain('Иван');
  expect(xml).toContain('synthetic-1');
  expect(xml).not.toContain('Legal —');
});
it('scheme PDF uses actual A3 page size at selected scale', async () => {
  const p = newProject(PRESETS[0].build()).project;
  p.evidence = [
    newEvidence(
      'braking',
      [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ],
      {},
      'Линейка',
      0.01,
    ),
  ];
  const pdf = await PDFDocument.load(
    await schemePDF(p, { scale: 100, originX: 0, originY: 0 }, font),
  );
  expect(pdf.getPage(0).getWidth()).toBeCloseTo((420 * 72) / 25.4);
});
