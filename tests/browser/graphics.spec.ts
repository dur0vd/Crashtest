import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { decryptProject, isEncrypted } from '../../src/privacy/crypto';
import { decode } from 'fast-png';
import { importProject } from '../../src/project/archive';
import { canonical, sha256, utf8 } from '../../src/project/canonical';
const open = async (page: Page) => {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page
    .getByRole('button', { name: 'Материалы, проекты и мобильный комиссар' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Материалы и реконструкция' }),
  ).toBeVisible();
};
const tab = (page: Page, name: string) =>
  page.locator('.ct-nav').getByRole('button', { name, exact: true }).click();
test('production editor, real files, VFR frame navigation, PDF, archive, persistence and network audit', async ({
  page,
  context,
}) => {
  const network: string[] = [],
    errors: string[] = [];
  page.on('request', (r) => network.push(r.url()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#cv')).toBeVisible();
  await open(page);
  await tab(page, 'Параметры');
  await expect(
    page.getByText('Расчёт недоступен в этой сборке', { exact: true }),
  ).toBeVisible();
  await tab(page, 'Вещественная обстановка');
  await page
    .getByLabel('Координаты [{x,y}] (м)', { exact: true })
    .fill('[{"x":0,"y":0},{"x":3,"y":4}]');
  await page
    .getByLabel('Источник', { exact: true })
    .fill('Синтетический обмер');
  await page.getByLabel('Погрешность ±м (пусто — неизвестна)').fill('0.02');
  await page
    .getByRole('button', { name: 'Сохранить наблюдение', exact: true })
    .click();
  await expect(
    page.getByLabel('Наблюдение', { exact: true }).locator('option'),
  ).toHaveCount(2);
  await tab(page, 'Видео и фото');
  await page
    .getByLabel('Добавить материалы', { exact: true })
    .setInputFiles([
      'tests/fixtures/graphics/photo.jpg',
      'tests/fixtures/graphics/vfr.webm',
    ]);
  await expect(page.locator('.ct-body details')).toHaveCount(2);
  await page
    .locator('details')
    .filter({ has: page.getByText(/photo.jpg · ID/) })
    .locator('summary')
    .click();
  await expect(page.getByText(/Synthetic EXIF fixture/)).toBeVisible();
  await page
    .getByLabel(
      'Ручные области маскирования [{x,y,width,height}], px; протяните по фото',
    )
    .fill('[{"x":0,"y":0,"width":10,"height":10}]');
  const maskedWait = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Сохранить и скачать маскированный PNG' })
    .click();
  const masked = await maskedWait;
  const png = decode(new Uint8Array(await readFile((await masked.path())!)));
  expect(Array.from(png.data.slice(0, 3))).toEqual([85, 85, 85]);
  await expect(page.locator('.ct-body details')).toHaveCount(3);

  const videoDetails = page
    .locator('details')
    .filter({ has: page.getByText(/vfr.webm · ID/) });
  await videoDetails.locator('summary').click();
  await page.getByRole('button', { name: 'Открыть покадровый анализ' }).click();
  await expect(page.getByText(/ВНИМАНИЕ: VFR/)).toBeVisible();
  await expect(page.getByText(/PTS 0.000000/)).toBeVisible();
  await page.getByRole('button', { name: 'Следующий кадр' }).click();
  await expect(page.getByText(/PTS 0.040000/)).toBeVisible();
  await page.getByRole('button', { name: 'Следующий кадр' }).click();
  await expect(page.getByText(/PTS 0.120000/)).toBeVisible();
  await expect(page.locator('.ct-video')).toHaveAttribute('data-pts', '0.12');
  await expect(page.locator('.ct-video')).toHaveJSProperty('width', 160);
  await page.getByLabel('Погрешность клика ±px').fill('1');
  await page.locator('.ct-video').click({ position: { x: 70, y: 40 } });
  await expect(page.getByText(/"pts": 0.12/)).toBeAttached();
  await page.getByRole('button', { name: 'К материалам' }).click();
  await tab(page, 'Документы');
  await page.getByLabel('Автор', { exact: true }).fill('Синтетический автор');
  const pdfWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PDF', exact: true }).click();
  const pdf = await pdfWait;
  const pdfPath = (await pdf.path())!;
  const pdfText = execFileSync('pdftotext', [pdfPath, '-'], {
    encoding: 'utf8',
  });
  expect(pdfText).toContain('Расчёт для специалиста');
  expect(pdfText).not.toContain('Legal —');
  await tab(page, 'Проект');
  const zipWait = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Экспорт .crashtest', exact: true })
    .click();
  const zip = await zipWait;
  const bytes = new Uint8Array(await readFile((await zip.path())!));
  const file = await importProject(bytes);
  expect(file.project.evidence).toHaveLength(1);
  expect(file.attachments).toHaveLength(3);
  expect(file.project.extensions.workspace.videoAnnotations).toHaveLength(1);
  expect(file.attachments[0].bytes).toEqual(
    new Uint8Array(await readFile('tests/fixtures/graphics/photo.jpg')),
  );

  await page
    .getByLabel('Пароль экспорта / импорта (пусто — без шифрования)')
    .fill('synthetic-password');
  const encryptedWait = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Экспорт .crashtest', exact: true })
    .click();
  const encrypted = await encryptedWait;
  const encryptedPath = (await encrypted.path())!;
  const encryptedBytes = new Uint8Array(await readFile(encryptedPath));
  expect(isEncrypted(encryptedBytes)).toBe(true);
  const decrypted = await importProject(
    await decryptProject(encryptedBytes, 'synthetic-password'),
  );
  expect(decrypted.attachments).toHaveLength(3);
  await page.getByLabel('Открыть проект или старую сцену').setInputFiles({
    name: 'encrypted.crashtest',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(encryptedBytes),
  });
  await expect(page.locator('.ct-status')).toContainText(
    /импортирован|Сохранено/,
  );
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await open(page);
  await tab(page, 'Вещественная обстановка');
  await expect(
    page.getByLabel('Наблюдение', { exact: true }).locator('option'),
  ).toHaveCount(2);
  await page.screenshot({
    path: 'docs/graphics-verification/desktop.png',
    fullPage: true,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, {
          once: true,
        }),
      );
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#cv')).toBeVisible();
  await open(page);
  await tab(page, 'Документы');
  const offlinePdf = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PDF', exact: true }).click();
  expect((await offlinePdf).suggestedFilename()).toBe('report.pdf');
  await page.goto('/index.html');
  await open(page);
  await tab(page, 'Проект');
  await writeFile(
    'docs/graphics-verification/network.json',
    JSON.stringify(
      {
        external: network.filter(
          (u) =>
            !u.startsWith('http://127.0.0.1:4173/') && !u.startsWith('blob:'),
        ),
        requests: network.length,
        origins: [...new Set(network.map((u) => new URL(u).origin))],
      },
      null,
      2,
    ),
  );
  expect(
    network.filter(
      (u) => !u.startsWith('http://127.0.0.1:4173/') && !u.startsWith('blob:'),
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
test('mobile wizard, large controls, offline autosave and conservative redaction', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await open(page);
  await tab(page, 'Мобильный комиссар');
  await page.getByLabel('Адрес', { exact: true }).fill('СИНТЕТИЧЕСКИЙ-АДРЕС');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByLabel('Госномер', { exact: true }).first().fill('А123АА');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(page.locator('.ct-plan')).toBeVisible();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByLabel('Измеренная длина рулеткой, м').fill('5.23');
  await page.getByLabel('Точность ±м').fill('0.01');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page
    .getByRole('button', { name: 'Передняя часть', exact: true })
    .click();
  await expect(page.locator('.ct-status')).toContainText(/Записано|Сохранено/);
  await page.screenshot({
    path: 'docs/graphics-verification/mobile.png',
    fullPage: true,
  });
  expect(
    await page
      .locator('.ct-workbench')
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await tab(page, 'Проект');
  const wait = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Экспорт без ПДн', exact: true })
    .click();
  const download = await wait;
  const f = await importProject(
    new Uint8Array(await readFile((await download.path())!)),
  );
  expect(JSON.stringify(f)).not.toMatch(/СИНТЕТИЧЕСКИЙ-АДРЕС|А123АА/);
  expect(f.journal).toEqual([]);
  expect(f.attachments).toEqual([]);
  await page
    .getByRole('button', { name: 'Удалить проект и вложения с устройства' })
    .click();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await open(page);
  await tab(page, 'Мобильный комиссар');
  await expect(page.getByLabel('Адрес', { exact: true })).toHaveValue('');
});
test('injected synthetic ports: descriptors, tri-state, timeline, diagnostics, trace, cancellation, destroy, cross-runtime hash', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:5173/tests/browser/harness.html');
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { mountWorkbench } = await load('/src/workbench/mount.ts');
    const { newProject } = await load('/src/project/model.ts');
    const { emptyScene } = await load('/src/scene.ts');
    const { canonical, sha256, utf8 } = await load('/src/project/canonical.ts');
    const file = newProject(emptyScene());
    const record = {
      id: 'synthetic-calc',
      method: 'synthetic-ui-fixture',
      inputs: { v: 2 },
      formula: 'synthetic only',
      result: {
        residuals: [{ evidenceId: 'obs', value: 0.2, unit: 'м' }],
        figures: [
          {
            kind: 'histogram',
            title: 'Синтетическое распределение',
            unit: 'м/с',
            points: [
              { x: 1, y: 2 },
              { x: 2, y: 4 },
            ],
          },
        ],
      },
      units: { v: 'м/с' },
      sources: ['SYNTHETIC'],
      assumptions: ['Only UI testing'],
    };
    const physics = {
      contractVersion: 1,
      describe: () => [
        {
          id: 'test',
          title: 'Синтетические поля порта',
          available: true,
          inputs: [
            {
              path: '/extensions/physics/test',
              label: 'Скорость fixture',
              kind: 'number',
              unit: 'м/с',
              minimum: 0,
            },
          ],
        },
      ],
      simulate: async (_p: any, c: any) => {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 30));
          if (c?.isCancelled?.())
            return {
              status: 'error',
              issues: [{ code: 'cancelled', message: 'Отменено' }],
            };
          c?.onProgress?.(i, 4);
        }
        return {
          status: 'ok',
          issues: [],
          value: {
            timeline: {
              dt: 0.1,
              n: 2,
              duration: 0.1,
              mu: 0.5,
              tracks: new Map(),
              collisions: [],
            },
            calculations: [record],
            technical: { synthetic: true },
            observations: [],
            renderData: {
              samples: [
                {
                  t: 0,
                  wheels: [{ x: 1, y: 1 }],
                  vectors: [
                    {
                      x: 1,
                      y: 1,
                      dx: 2,
                      dy: 0,
                      label: 'F',
                      value: 10,
                      unit: 'Н',
                    },
                  ],
                },
              ],
            },
          },
        };
      },
      calculate: async () => ({ status: 'ok', issues: [], value: [record] }),
    };
    const rules = {
      contractVersion: 1,
      describe: () => [
        {
          id: 'test.rule',
          title: 'Факты',
          available: true,
          inputs: [
            {
              path: '/extensions/rules/fact',
              label: 'Установленный факт',
              kind: 'boolean',
            },
          ],
        },
      ],
      evaluate: async () => ({
        status: 'unsupported',
        issues: [
          {
            code: 'synthetic',
            message: 'Synthetic fixture has no legal engine',
          },
        ],
      }),
    };
    (window as any).handle = mountWorkbench(
      document.getElementById('fixture')!,
      {
        project: file.project,
        file,
        ports: { physics, rules },
        onProjectChange: (p: any) => ((window as any).project = p),
      },
    );
    return {
      text: canonical(file.project),
      hash: await sha256(utf8(canonical(file.project))),
    };
  });
  expect(result.hash).toBe(await sha256(utf8(result.text)));
  expect(result.text).toBe(canonical(JSON.parse(result.text)));
  await tab(page, 'Параметры');
  await page.getByLabel('Скорость fixture (м/с)').fill('4.5');
  await page.getByLabel('Скорость fixture (м/с)').blur();
  await expect(page.getByLabel('Установленный факт')).toHaveValue('');
  await page.getByLabel('Установленный факт').selectOption('false');
  expect(
    await page.evaluate(() => (window as any).project.extensions.rules.fact),
  ).toBe(false);
  await page.getByLabel('Установленный факт').selectOption('');
  expect(
    await page.evaluate(
      () => 'fact' in (window as any).project.extensions.rules,
    ),
  ).toBe(false);
  await tab(page, 'Реконструкция');
  await page
    .getByRole('button', { name: 'Моделировать через порт', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: /Синтетическое распределение/ }),
  ).toBeVisible();
  await expect(page.locator('.ct-chart')).toBeVisible();
  await page
    .getByText('synthetic-calc · synthetic-ui-fixture · формула и trace')
    .click();
  await expect(page.getByText(/Only UI testing/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Моделировать через порт', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Отменить расчёт', exact: true })
    .click();
  await expect(page.locator('.ct-status')).toContainText('Отмена');
  await page.evaluate(() => (window as any).handle.destroy());
  await expect(page.locator('.ct-workbench')).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const storage = await load('/src/project/storage.ts');
      const model = await load('/src/project/model.ts');
      const scene = await load('/src/scene.ts');
      const file = model.newProject(scene.emptyScene());
      const writes = Array.from({ length: 12 }, () =>
        storage.saveLocal('queue-fixture', file),
      );
      const deletion = storage.deleteLocal('queue-fixture');
      await Promise.all([...writes, deletion]);
      return (await storage.loadLocal('queue-fixture')) === undefined;
    }),
  ).toBe(true);
});
