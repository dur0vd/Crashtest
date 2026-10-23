#!/usr/bin/env node
/**
 * Downloads open crash-test records for validation (stage 17) from the NHTSA
 * Vehicle Crash Test Database API (https://nrd.api.nhtsa.dot.gov/). Raw data is
 * NOT committed: the redistribution licence is not verified here
 * (TODO(source-check)), so the repository carries only this loader.
 *
 * Selection: single vehicle into a RIGID FLAT barrier, impact angle 0, no
 * offset, with test weight, speed, width and a six-point damage profile.
 * Usage: node tools/fetch-validation-data.mjs [--max N] [--out FILE]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const API = 'https://nrd.api.nhtsa.dot.gov/nhtsa/vehicle/api/v1/vehicle-database-test-results';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const MAX = Number(opt('--max', '150'));
const OUT = opt('--out', 'tests/validation/data/nhtsa-frontal-rigid.json');
const PAGE = 20; // the API returns at most 20 records per page
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 4) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (k + 1 >= tries) throw e;
      await sleep(1000 * 2 ** k);
    }
  }
}
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

const first = await get(`${API}?pageNumber=0&pageSize=${PAGE}`);
const total = first.meta.pagination.total;
const records = [], rejected = {};
const reject = why => { rejected[why] = (rejected[why] ?? 0) + 1; };
// Newest tests first: they describe current vehicle structures.
for (let page = Math.ceil(total / PAGE) - 1; page >= 0 && records.length < MAX; page--) {
  const list = await get(`${API}?pageNumber=${page}&pageSize=${PAGE}`);
  for (const t of list.results.slice().reverse()) {
    if (records.length >= MAX) break;
    if (t.testConfigurationKey !== 'VTB' || t.impactAngle !== 0 || (t.offsetDistance ?? 0) !== 0) { reject('not frontal VTB'); continue; }
    const barrier = (await get(`${API}/get-barrier-info/${t.testNo}`)).results?.[0];
    if (barrier?.rigidOrDeformableBarrier !== 'RIGID' || barrier?.barrierShape !== 'FLAT BARRIER') { reject('barrier not rigid flat'); continue; }
    const vehicles = (await get(`${API}/get-vehicle-info/${t.testNo}`)).results ?? [];
    if (vehicles.length !== 1) { reject('not single vehicle'); continue; }
    const detail = (await get(`${API}/get-vehicle-detail-info/${vehicles[0].vehicleNo}/${t.testNo}`)).results?.[0];
    if (!detail) { reject('no detail'); continue; }
    const profileMm = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(k => num(detail[`damageProfileDistances${k}`]));
    const rec = {
      testNo: t.testNo, testType: t.testType, testDate: t.testDate, make: detail.vehicleMake, model: detail.vehicleModel, modelYear: num(detail.modelYear),
      testWeightKg: num(detail.vehicleTestWeight), speedKmh: num(detail.vehicleSpeed) ?? num(t.closingSpeed), widthMm: num(detail.vehicleWidth),
      indentationLengthMm: num(detail.totalLengthofIndentation), maximumCrushMm: num(detail.maximumCrushDistance), profileMm,
      pdof: num(detail.principalDirectionofForce), vdi: detail.vehicleDamageIndex ?? null,
    };
    if (!(rec.testWeightKg > 0) || !(rec.speedKmh > 0) || !(rec.widthMm > 0)) { reject('missing mass/speed/width'); continue; }
    if (profileMm.some(c => c === null || !(c >= 0)) || profileMm.filter(c => c > 0).length < 4) { reject('incomplete damage profile'); continue; }
    records.push(rec);
    await sleep(150);
  }
  await sleep(150);
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  source: 'NHTSA Vehicle Crash Test Database API', api: API, retrieved: new Date().toISOString(),
  licence: 'TODO(source-check): условия распространения не проверены; файл не входит в репозиторий',
  selection: 'VTB, RIGID FLAT BARRIER, impactAngle 0, no offset, single vehicle, mass/speed/width, ≥4 non-zero of 6 damage-profile points; newest first',
  units: { testWeightKg: 'kg', speedKmh: 'km/h', widthMm: 'mm', profileMm: 'mm' },
  rejected, records,
}, null, 1));
console.log(`${records.length} records → ${OUT}; rejected: ${JSON.stringify(rejected)}`);
