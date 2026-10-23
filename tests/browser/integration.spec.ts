/**
 * Integrated build in Chromium: ▶ runs the real ports, expert mode hides the
 * legal section, dynamic mode without parameters is explicitly unsupported,
 * the workbench calculates through the real ports (Worker Monte Carlo with
 * progress/cancel), and Node and Chromium produce identical result hashes.
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const OUT = 'docs/integration-verification';
// Presets stamp the current minute as the accident date; compare identical inputs.
const FIXED_DATE = '2026-10-22T12:00';
const MC = { model: 'expert.braking', seed: 7, n: 2000,
  inputs: { v0: { kind: 'uniform', min: 13, max: 15 }, available: { kind: 'fixed', value: 40 }, t1: { kind: 'triangular', min: 0.6, mode: 0.8, max: 1.2 },
    t2: { kind: 'fixed', value: 0.1 }, t3: { kind: 'fixed', value: 0.35 }, j: { kind: 'normal', mean: 6.8, sd: 0.4, min: 5.5, max: 8 } } };
// First twelve examples of the menu plus a pedestrian collision.
const TITLES = ['Пешеход выбежал вне перехода'];

async function preset(page: Page, title: string) {
  await page.locator('#btnExamples').click();
  await page.locator('#menuExamples').getByText(title, { exact: true }).click();
}

test('▶ на реальных портах: учебный/экспертный режим, явный unsupported динамики, без внешних запросов', async ({ page }) => {
  const requests: string[] = [], errors: string[] = [];
  page.on('request', r => requests.push(r.url()));
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await preset(page, 'Пешеход выбежал вне перехода');
  await page.locator('#btnPlay').click();
  await expect(page.locator('#pane-report')).toContainText('Ориентировочная правовая оценка');
  await expect(page.locator('#pane-report')).toContainText('Учебный режим');
  await expect(page.locator('#repBadge')).toHaveText('!');
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/desktop-educational.png` });

  await page.locator('[data-tab="env"]').click();
  await page.getByLabel('Режим разбора').selectOption('expert');
  await page.locator('#btnPlay').click();
  await page.locator('[data-tab="report"]').click();
  await expect(page.locator('#pane-report')).toContainText('Правовая оценка выключена');
  await expect(page.locator('#pane-report')).not.toContainText('Ориентировочная правовая оценка');
  await expect(page.locator('#pane-report')).toContainText('Экспертный режим');

  await page.locator('[data-tab="env"]').click();
  await page.getByLabel('Модель движения').selectOption('dynamic');
  await page.locator('#btnPlay').click();
  await expect(page.getByRole('heading', { name: 'Расчёт в выбранном режиме не поддерживается' })).toBeVisible();
  await expect(page.locator('#modalBody')).toContainText('не подставляется');
  await page.screenshot({ path: `${OUT}/desktop-dynamic-unsupported.png` });
  // The timeline was not replaced by a kinematic one: the badge is not shown.
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.locator('#repBadge')).toBeHidden();

  const origin = new URL(page.url()).origin;
  const external = requests.filter(u => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  await writeFile(`${OUT}/network.json`, JSON.stringify({ origin, requests: requests.length, external }, null, 2));
});

test('мобильный экран: ▶ и разбор помещаются по ширине', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await preset(page, 'Пешеход выбежал вне перехода').catch(async () => {
    // On narrow screens the examples menu is the same control; retry once after layout.
    await preset(page, 'Пешеход выбежал вне перехода');
  });
  await page.locator('#btnPlay').click();
  await expect(page.locator('#repBadge')).toHaveText('!');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${OUT}/mobile-play.png` });
});

test('рабочая область: моделирование через порт, Монте-Карло в Worker с прогрессом и отменой', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await preset(page, 'Пешеход выбежал вне перехода');
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Материалы, проекты и мобильный комиссар' }).click();
  const nav = page.locator('.ct-nav');
  await nav.getByRole('button', { name: 'Реконструкция', exact: true }).click();
  await page.getByRole('button', { name: 'Моделировать через порт', exact: true }).click();
  await expect(page.locator('.ct-status')).toContainText('Результат получен от подключённого порта');

  const workers: string[] = [];
  page.on('worker', w => workers.push(w.url()));
  const params = page.getByLabel('Ограничения / диапазоны / распределения / seed / N (JSON, схема движка)');
  await params.fill(JSON.stringify(MC));
  await page.getByRole('button', { name: 'Монте-Карло', exact: true }).click();
  await expect(page.locator('.ct-status')).toContainText('Результат получен от подключённого порта', { timeout: 30000 });
  expect(workers.some(u => /mc-worker/.test(u))).toBe(true);
  await expect(page.locator('.ct-body')).toContainText('reconstruction.monte-carlo');

  await params.fill(JSON.stringify({ ...MC, n: 1_000_000 }));
  await page.getByRole('button', { name: 'Монте-Карло', exact: true }).click();
  await expect(page.locator('.ct-status')).toContainText(/Расчёт: \d+/, { timeout: 30000 });
  await page.getByRole('button', { name: 'Отменить расчёт', exact: true }).click();
  await expect(page.locator('.ct-status')).toContainText('Отмена запрошена');
  await page.waitForTimeout(500);
  await expect(page.locator('.ct-status')).not.toContainText('Результат получен');
  await page.screenshot({ path: `${OUT}/workbench-reconstruction.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('детерминизм Node ↔ Chromium: одинаковые хэши результатов портов и Монте-Карло (Worker)', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/');
  const titles = [...await page.evaluate(async () => {
    const path = '/src/presets.ts';
    const { PRESETS } = await import(/* @vite-ignore */ path);
    return PRESETS.slice(0, 12).map((p: { title: string }) => p.title);
  }), ...TITLES];
  // Reference values from a separate Node process without DOM.
  const node = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'tools/integration-hashes.ts', JSON.stringify({ titles, mc: MC, fixedDate: FIXED_DATE })], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const browser = await page.evaluate(async ({ titles, mc, fixedDate, dump }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createPorts, runProject } = await load('/src/integration/ports.ts');
    const { workerMonteCarlo } = await load('/src/integration/browser.ts');
    const { PRESETS } = await load('/src/presets.ts');
    const { newProject } = await load('/src/project/model.ts');
    const { canonical, resultJSON, sha256, utf8 } = await load('/src/project/canonical.ts');
    const ports = createPorts({ monteCarlo: workerMonteCarlo });
    const out: Record<string, string> = {};
    for (const title of titles) {
      const p = newProject(PRESETS.find((x: { title: string }) => x.title === title).build()).project;
      p.extensions.rules = { mode: 'educational' };
      p.scene.env.accidentDate = fixedDate;
      const run = await runProject(p, ports);
      const text = canonical(resultJSON({ physics: run.physics.value, rules: run.rules.value }));
      out[title] = dump ? text : await sha256(utf8(text));
    }
    if (dump) return { out, ua: navigator.userAgent };
    const r = await ports.physics.calculate('reconstruction.monte-carlo', newProject(PRESETS[0].build()).project, mc);
    out['monte-carlo'] = await sha256(utf8(canonical(resultJSON(r.value))));
    return { out, ua: navigator.userAgent };
  }, { titles, mc: MC, fixedDate: FIXED_DATE, dump: false });
  const differing = titles.filter(t => browser.out[t] !== node[t]);
  if (differing.length) {
    // Diagnostics: the first differing leaves (path, Node value, Chromium value) per scene.
    const nodeJson = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'tools/integration-hashes.ts', JSON.stringify({ titles: differing, mc: MC, fixedDate: FIXED_DATE, dump: true })], { encoding: 'utf8', maxBuffer: 1 << 28 }));
    const dumped = await page.evaluate(async ({ titles, mc, fixedDate, dump }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { createPorts, runProject } = await load('/src/integration/ports.ts');
      const { PRESETS } = await load('/src/presets.ts');
      const { newProject } = await load('/src/project/model.ts');
      const { canonical, resultJSON } = await load('/src/project/canonical.ts');
      const ports = createPorts();
      const out: Record<string, string> = {};
      for (const title of titles) {
        const p = newProject(PRESETS.find((x: { title: string }) => x.title === title).build()).project;
        p.extensions.rules = { mode: 'educational' };
        p.scene.env.accidentDate = fixedDate;
        const run = await runProject(p, ports);
        out[title] = canonical(resultJSON({ physics: run.physics.value, rules: run.rules.value }));
      }
      return { out, dump, mc };
    }, { titles: differing, mc: MC, fixedDate: FIXED_DATE, dump: true });
    const leaves: Record<string, { path: string; node: unknown; chromium: unknown }[]> = {};
    const walk = (a: unknown, b: unknown, path: string, acc: { path: string; node: unknown; chromium: unknown }[]) => {
      if (acc.length >= 12 || JSON.stringify(a) === JSON.stringify(b)) return;
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as any)[k], (b as any)[k], `${path}/${k}`, acc);
      } else acc.push({ path, node: a, chromium: b });
    };
    for (const t of differing) walk(JSON.parse(nodeJson[t]), JSON.parse(dumped.out[t]), '', leaves[t] = []);
    await mkdir(OUT, { recursive: true });
    await writeFile(`${OUT}/determinism-diff.json`, JSON.stringify({ node: process.version, chromium: browser.ua, leaves }, null, 1));
    console.log('determinism diff', browser.ua, JSON.stringify(leaves, null, 1).slice(0, 6000));
  }
  expect(browser.out).toEqual(node);
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/determinism.json`, JSON.stringify({ node: process.version, chromium: browser.ua, hashes: node }, null, 2));
});
