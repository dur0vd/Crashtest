// Chromium check of the headless physics port and the Monte Carlo Web Worker
// against a Vite dev server. Playwright is a local verification tool only.
// PLAYWRIGHT_MODULE_PATH / CHROMIUM_PATH / PHYSICS_DEV_URL / PHYSICS_PARALLEL_REPORT.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const dev = process.env.PHYSICS_DEV_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', headless: true, args: ['--no-sandbox'] });
const results = [], errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(dev);
  await page.locator('#btnPlay').waitFor();
  const out = await page.evaluate(async () => {
    const { createPhysicsPort } = await import('/src/physics/port.ts');
    const { syntheticVehicle, runMonteCarlo } = await import('/src/physics/index.ts');
    const { runMonteCarloInWorker } = await import('/src/physics/mc-client.ts');
    const { emptyScene } = await import('/src/scene.ts');
    const port = createPhysicsPort();
    const scene = emptyScene(); scene.env.physics = 'dynamic'; scene.env.duration = 4;
    const actor = (id, x, heading) => ({ id, kind: 'vehicle', type: 'car', x, y: 0, heading, speed: 36, path: [], color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false } });
    scene.actors = [actor('a1', 0, 0), actor('a2', 30, Math.PI)];
    const p = syntheticVehicle(); p.brakes.abs = 'ideal';
    const envelope = { contractVersion: 1, scene, extensions: { physics: { vehicles: { a1: { dynamics: p }, a2: { dynamics: p, postImpact: { wheels: 'locked', source: { kind: 'synthetic', description: 'browser check' } } } } }, rules: {}, workspace: {} }, evidence: [] };
    const sim = await port.simulate(envelope);
    const unsupported = await port.simulate({ ...envelope, extensions: { physics: {}, rules: {}, workspace: {} } });
    const calc = await port.calculate('expert.braking', envelope, { skidLength: 20, j: 6.8, t3: 0.35 });
    const spec = { model: 'expert.braking', seed: 5, n: 1000, inputs: { v0: { kind: 'uniform', min: 10, max: 20 }, available: { kind: 'fixed', value: 40 },
      t1: { kind: 'triangular', min: 0.8, mode: 1, max: 1.2 }, t2: { kind: 'fixed', value: 0.1 }, t3: { kind: 'fixed', value: 0.35 }, j: { kind: 'uniform', min: 6, max: 7.5 } } };
    let progress = 0;
    const job = runMonteCarloInWorker(spec, done => { progress = done; });
    const viaWorker = await job.promise;
    const direct = await runMonteCarlo(spec);
    const cancelJob = runMonteCarloInWorker({ ...spec, n: 200000 });
    setTimeout(() => cancelJob.cancel(), 50);
    const cancelled = await cancelJob.promise;
    return { simStatus: sim.status, collisions: sim.status === 'ok' ? sim.value.calculations.length : -1, renderActors: sim.status === 'ok' ? Object.keys(sim.value.renderData.actors) : [],
      unsupportedStatus: unsupported.status, unsupportedPaths: unsupported.issues.map(i => i.path), calcStatus: calc.status,
      speedKmh: calc.status === 'ok' ? calc.value[0].result.speedKmh : null, workerEqual: JSON.stringify(viaWorker) === JSON.stringify(direct), progress,
      fraction: viaWorker.outputs.avoidable.fraction, cancelledStatus: cancelled.status };
  });
  assert.equal(out.simStatus, 'ok'); assert.ok(out.collisions >= 1); assert.deepEqual(out.renderActors.sort(), ['a1', 'a2']);
  results.push(`Port.simulate dynamic: ok, impact records ${out.collisions}, renderData for ${out.renderActors.join(', ')}`);
  assert.equal(out.unsupportedStatus, 'unsupported'); assert.deepEqual(out.unsupportedPaths, ['/scene/actors/0', '/scene/actors/1']);
  results.push('Port.simulate without parameters: explicit unsupported with actor paths');
  assert.equal(out.calcStatus, 'ok'); assert.ok(Math.abs(out.speedKmh - 63.657) < 0.005);
  results.push(`Port.calculate expert.braking: ${out.speedKmh.toFixed(3)} km/h`);
  assert.equal(out.workerEqual, true); assert.equal(out.progress, 1000);
  results.push(`Monte Carlo in a module Web Worker equals the direct run (seed 5, N=1000, fraction ${out.fraction.toFixed(3)})`);
  assert.equal(out.cancelledStatus, 'cancelled');
  results.push('Worker cancellation resolves with status cancelled');
  assert.deepEqual(errors, []);
  results.push('No uncaught browser errors');
  const report = { browser: await browser.version(), results, errors };
  await writeFile(process.env.PHYSICS_PARALLEL_REPORT || '/tmp/crashtest-physics-parallel.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
