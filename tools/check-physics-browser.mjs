// Run against a Vite dev server and production preview. Playwright is a local
// verification tool, not a runtime dependency. See docs/PHYSICS.md.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const dev = process.env.PHYSICS_DEV_URL || 'http://127.0.0.1:5173';
const preview = process.env.PHYSICS_PREVIEW_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(dev);
  await page.locator('#btnPlay').waitFor();
  const verification = await page.evaluate(async () => {
    const physics = await import('/src/physics/index.ts');
    const { PRESETS } = await import('/src/presets.ts');
    const { simulate } = await import('/src/sim.ts');
    const { emptyScene, normalizeScene } = await import('/src/scene.ts');
    const p = physics.syntheticVehicle(); p.brakes.abs = 'disabled';
    const road = { mu: 0.8, source: { kind: 'synthetic', description: 'Chromium analytic verification' } };
    const initial = { x: 0, y: 0, heading: 0, vx: 20, vy: 0, yawRate: 0, ax: 0, ay: 0 };
    const run = () => {
      let state = initial;
      for (let i = 0; i < 160; i++) state = physics.stepDynamics(state, p, { steering: 0, drive: 0, brake: 1 }, road).state;
      return state;
    };
    const a = run(), b = run();
    const finitePresets = PRESETS.filter(preset => {
      const tl = simulate(normalizeScene(preset.build()));
      return [...tl.tracks.values()].every(tr => [tr.x, tr.y, tr.h, tr.v].every(v => [...v].every(Number.isFinite)));
    }).length;
    const scene = emptyScene(); scene.name = '07.1 Chromium reference parameters'; scene.env.duration = 5;
    const actor = (id, x, heading, dynamics) => ({ id, kind: 'vehicle', type: 'car', x, y: 0, heading,
      speed: 36, delay: 0, color: '#fff', path: [], flags: { drunk: false, noLicense: false, flees: false }, dynamics });
    scene.actors = [actor('a1', 0, 0, physics.parametersFromReference('commonroad-vehicle1', p)),
      actor('a2', 40, Math.PI, p)];
    return { a, b, finitePresets, count: PRESETS.length, scene };
  });
  assert.deepEqual(verification.a, verification.b);
  assert.equal(verification.a.vx, 0);
  assert.ok(Math.abs(verification.a.x / (400 / (2 * 0.8 * 9.81)) - 1) < 0.01);
  results.push('Chromium kernel: deterministic braking to exact rest; distance error <1%');
  assert.equal(verification.finitePresets, verification.count);
  results.push(`${verification.count} legacy presets: finite kinematic tracks in Chromium`);

  await page.goto(preview);
  await page.locator('#btnPlay').click();
  await page.locator('[data-tab="report"]').click();
  await page.locator('#pane-report').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#pane-report').innerText()).length > 100);
  results.push('Production UI: legacy preset starts and report renders');
  await page.evaluate(scene => localStorage.setItem('crashtest.scene.v1', JSON.stringify(scene)), verification.scene);
  await page.reload();
  assert.equal(await page.locator('#sceneName').inputValue(), verification.scene.name);
  await page.locator('#btnPlay').click();
  await page.locator('[data-tab="report"]').click();
  await page.waitForFunction(() => document.querySelector('#pane-report')?.textContent?.includes('physicalParameters'));
  const traces = await page.locator('#pane-report').textContent();
  assert.ok(traces.includes('1225.8878467253344'));
  assert.ok(traces.includes('legacy-kinematic'));
  assert.ok(traces.includes('commonroad-vehicle1'));
  results.push('Production UI: imported reference survives reload; technical trace shows shared mass, reference and legacy motion label');
  await page.locator('#pane-report details.trace summary').first().click();
  const screenshot = process.env.PHYSICS_SCREENSHOT || '/tmp/crashtest-physics-071/browser.png';
  await page.screenshot({ path: screenshot, fullPage: true });
  const license = await page.request.get(`${preview}/licenses/CommonRoad-BSD-3-Clause.txt`);
  assert.equal(license.status(), 200);
  assert.match(await license.text(), /Copyright 2020 Technical University of Munich/);
  results.push('Production distribution includes complete CommonRoad BSD notice');
  assert.deepEqual(errors, []);
  results.push('No uncaught browser exceptions');
  const report = { browser: await browser.version(), results, screenshot, errors };
  await writeFile(process.env.PHYSICS_BROWSER_REPORT || '/tmp/crashtest-physics-071/browser.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
