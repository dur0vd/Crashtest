// Optional browser check: needs Playwright and Chromium, does not change project dependencies.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message));
  const ok = (condition, name) => { assert(condition, name); checks.push(name); };
  const field = text => page.locator('#pane-props label.field').filter({ has: page.locator('.lbl', { hasText: text }) }).first();
  const setInput = async (text, value) => { const input = field(text).locator('input'); await input.fill(String(value)); await input.dispatchEvent('change'); };
  const stored = async () => { await page.waitForTimeout(450); return page.evaluate(() => JSON.parse(localStorage.getItem('crashtest.scene.v1'))); };
  const selectCenter = async () => { const b = await page.locator('#cv').boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.evaluate(() => localStorage.clear()); await page.reload();
  const version = browser.version();
  // Load each example through the actual menu and run its analysis.
  for (const name of ['Велосипед', 'СИМ']) for (const correct of [true, false]) {
    await page.locator('#btnExamples').click();
    const title = `${name}: ${correct ? 'правильно — велодорожка' : 'нарушение — переход верхом'}`;
    await page.locator('#menuExamples button').filter({ hasText: title }).click();
    await page.locator('#btnPlay').click();
    await page.locator('[data-tab="report"]').click();
    await page.waitForTimeout(120);
    const report = await page.locator('#pane-report').innerText();
    ok(correct ? /Нарушений ПДД не выявлено/.test(report) : /24\.8/.test(report), title);
    if (name === 'СИМ' && !correct) { await page.locator('#pane-report details.finding > summary').filter({ hasText: 'СИМ: превышен применимый предел скорости' }).click(); ok(/предел 25/.test(await page.locator('#pane-report').innerText()), 'СИМ: предел 25 в видимом разборе'); }
    await page.locator('#btnEdit').click();
  }
  // Unconfigured SIM draft: no catalogue parameters, no inherited 40 km/h.
  await page.locator('#btnMenu').click(); await page.locator('#menuMain button').filter({ hasText: 'Новая ситуация' }).click();
  await page.locator('[data-tool=vehicle]').click();
  const palette = page.locator('#palette select');
  if (await palette.count()) await palette.first().selectOption('sim');
  else await page.locator('#palette button').filter({ hasText: /^СИМ$/ }).click();
  await selectCenter();
  await page.locator('[data-tool=select]').click(); await selectCenter();
  ok((await stored()).actors[0].type === 'sim' && (await stored()).actors[0].speed === 0, 'Новый СИМ: отдельная категория и скорость 0');
  ok(await field('Масса устройства, кг').locator('input').inputValue() === '', 'Масса устройства не подставлена');
  ok(await field('Масса ездока, кг').locator('input').inputValue() === '', 'Масса ездока не подставлена');
  await page.locator('#btnPlay').click();
  ok(/СИМ.*введите массу/.test(await page.locator('body').innerText()), 'Расчёт отклоняет незаданные параметры СИМ');
  for (const [label, value] of [['Возраст, полных лет', 30], ['Масса устройства, кг', 35], ['Масса ездока, кг', 100], ['Длина, м', 1.2], ['Ширина, м', .55], ['Высота с ездоком, м', 1.7], ['Ускорение, м/с²', 1], ['Замедление на сухом покрытии, м/с²', 3]]) await setInput(label, value);
  await setInput('Источник параметров СИМ', 'Условные параметры браузерной проверки');
  await field('Масса устройства, кг').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/cyclists-browser-parameters.png', fullPage: true });
  let s = await stored();
  ok(s.actors[0].simParameters.deviceMass === 35 && s.actors[0].simParameters.riderMass === 100, 'Редактор сохраняет массы раздельно');
  ok(s.actors[0].simParameters.source === 'Условные параметры браузерной проверки', 'Редактор сохраняет источник параметров');
  await field('Созданы помехи пешеходам').locator('select').selectOption('no');
  ok((await stored()).actors[0].mobilityContext.pedestrianObstruction === false, 'Явное Нет сохраняется false');
  await field('Созданы помехи пешеходам').locator('select').selectOption('unknown');
  ok(!('pedestrianObstruction' in (await stored()).actors[0].mobilityContext), 'Не установлено удаляет факт');
  await page.getByRole('button', { name: 'Спешиться: вести устройство как пешеход', exact: true }).click();
  s = await stored();
  ok(s.actors[0].kind === 'pedestrian' && s.actors[0].leadingDevice === 'sim', 'Спешивание создаёт пешехода, ведущего СИМ');
  ok(await field('Ведёт устройство').locator('select').inputValue() === 'sim', 'Форма пешехода показывает ведущееся устройство');
  // Check geometric corridor editor and silhouette controls with minimal persisted scenes.
  await page.evaluate(async () => {
    const { emptyScene } = await import('/src/scene.ts');
    const scene = emptyScene(); scene.roads = [{ id: 'r1', pts: [{ x: -10, y: 0 }, { x: 10, y: 0 }], lanes: 1, center: 'dashed', oneWay: false, smooth: false, zone: 'city' }]; scene.sidewalks = [{ id: 's1', pts: [{ x: -10, y: 0 }, { x: 10, y: 0 }], width: 3, smooth: false }];
    localStorage.setItem('crashtest.scene.v1', JSON.stringify(scene));
  });
  await page.reload(); await selectCenter();
  for (const surface of ['cyclepath', 'cycle-lane', 'sharedpath', 'pedestrian-side', 'shoulder', 'pedestrian-zone', 'cycle-zone']) {
    await field('Назначение коридора').locator('select').selectOption(surface);
    ok((await stored()).sidewalks[0].mobilityKind === surface, `Редактор коридора ${surface}`);
    if (surface === 'cycle-lane') { await field('Направление велополосы').locator('select').selectOption('reverse'); ok((await stored()).sidewalks[0].travelDirection === 'reverse', 'Направление велополосы сохраняется отдельно'); }
  }
  await setInput('Источник назначения и обмера', 'Условный обмер коридора');
  ok((await stored()).sidewalks[0].source === 'Условный обмер коридора', 'Источник геометрии сохранён');
  await page.evaluate(async () => {
    const { emptyScene } = await import('/src/scene.ts'); const scene = emptyScene();
    scene.lights = [{ id: 'l1', x: 0, y: 0, angle: 0, lineLength: 3.5, green: 10, yellow: 0, red: 10, offset: 0 }];
    scene.actors = [{ id: 'a1', kind: 'pedestrian', type: 'adult', x: 0, y: 5, heading: 0, speed: 0, delay: 0, path: [], color: '#fff', flags: {} }];
    localStorage.setItem('crashtest.scene.v1', JSON.stringify(scene));
  });
  await page.reload();
  // Fit is centred on the actor; use fit extent ±15 and measured canvas scale.
  const box = await page.locator('#cv').boundingBox();
  const scale = Math.max(1.2, Math.min(30, box.width / 30, box.height / 30));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 5 * scale);
  for (const kind of ['bicycle', 'pedestrian', 'controller']) {
    await field('Управление движением').locator('select').selectOption(kind);
    ok((await stored()).lights[0].kind === kind, `Редактор сигнала ${kind}`);
    if (kind !== 'controller') { ok(await field('Зелёный, с').locator('input').isVisible(), `Цикл силуэта ${kind} редактируется`); ok((await stored()).lights[0].yellow === 0, `У силуэта ${kind} нет автоматического жёлтого`); }
  }
  await page.screenshot({ path: process.env.SCREENSHOT_PATH || '/tmp/cyclists-browser.png', fullPage: true });
  ok(errors.length === 0, 'Нет pageerror в Chromium');
  const result = { browser: `Chromium ${version}`, viewport: '1440x1000', passed: checks.length, checks, pageErrors: errors };
  fs.writeFileSync(process.env.BROWSER_REPORT_PATH || '/tmp/cyclists-browser.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2)); await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
