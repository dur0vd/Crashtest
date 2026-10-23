/**
 * Verification table (code computes what is claimed): each row compares the
 * implementation with an independent analytic result, a hand calculation or a
 * published value. Set PHYSICS_VERIFICATION_OUT=<file> to write the markdown table.
 * This is NOT validation against field data (none with a redistribution licence is bundled).
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
  AUGENSTEIN_2003, GRAVITY, TEFFT_2011, crushEnergy, impactForward, occupantMais3Risk, pedestrianRisk, planarImpact, reconstructImpact,
  runMonteCarlo, searleThrow, stepDynamics, stiffnessFromTest, syntheticVehicle, woodImpactSpeed, woodThrowDistance, type ImpactProblem,
} from '../../src/physics';
import { safeSpeed, stoppingDistance } from '../../src/expert';
import { CALCULATORS } from '../../src/expert/calc';
import { fitHomography } from '../../src/video-math';
import { emptyScene } from '../../src/scene';
import { simulate } from '../../src/sim';

interface Row { area: string; formula: string; source: string; example: string; expected: number; actual: number; tolerance: number; relative: boolean }
const rows: Row[] = [];
const check = (r: Row) => {
  const err = r.relative ? Math.abs(r.actual / r.expected - 1) : Math.abs(r.actual - r.expected);
  rows.push(r);
  expect(err, `${r.area}: ${r.example}`).toBeLessThanOrEqual(r.tolerance);
};
const synthetic = { kind: 'synthetic' as const, description: 'verification fixture' };

describe('physics verification table', () => {
  it('07: kernel and scene braking, grade, curve', () => {
    const p = syntheticVehicle(); p.brakes.abs = 'disabled';
    let s = { x: 0, y: 0, heading: 0, vx: 20, vy: 0, yawRate: 0, ax: 0, ay: 0 };
    for (let k = 0; k < 200; k++) s = stepDynamics(s, p, { steering: 0, drive: 0, brake: 1 }, { mu: 0.8, source: synthetic }, { substepSeconds: 0.001 }).state;
    check({ area: '07 ядро', formula: 'S = v²/(2μg), блокировка', source: 'аналитика', example: 'v=20 м/с, μ=0,8', expected: 400 / (2 * 0.8 * GRAVITY), actual: s.x, tolerance: 0.01, relative: true });
    const d = syntheticVehicle(); d.brakes.abs = 'ideal';
    const sc = emptyScene(); sc.env.physics = 'dynamic'; sc.env.duration = 10;
    sc.actors = [{ id: 'a1', kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 72, path: [], color: '#fff', delay: 0, flags: { drunk: false, noLicense: false, flees: false }, dynamics: d }];
    const tl = simulate(sc, { vehicles: { a1: { braking: { t2: { value: 0.2, source: 'v' }, t3: { value: 0.4, source: 'v' } }, hazard: { at: 0.5, reaction: 1, deceleration: 6, steering: 'track', source: synthetic } } }, substepSeconds: 0.001 });
    const tr = tl.tracks.get('a1')!;
    check({ area: '07 сцена', formula: 'S = v(t1+t2+0,5t3) + v²/(2j)', source: 'экспертная формула (аналитика)', example: 'v=20, t1=1, t2=0,2, t3=0,4, j=6', expected: stoppingDistance(20, 1, 0.2, 0.4, 6), actual: tr.x[tl.n - 1] - tr.x[20], tolerance: 0.01, relative: true });
    const g = 0.1, sin = g / Math.sqrt(1.01), cos = 1 / Math.sqrt(1.01);
    let b = { x: 0, y: 0, heading: Math.PI, vx: -15, vy: 0, yawRate: 0, ax: 0, ay: 0 };
    for (let k = 0; k < 400; k++) b = stepDynamics(b, p, { steering: 0, drive: 0, brake: 1 }, { mu: 0.6, source: synthetic, grade: { x: g, y: 0, source: synthetic } }, { substepSeconds: 0.001 }).state;
    check({ area: '07 уклон', formula: 'S = v²/(2g(μcosθ − sinθ))', source: 'аналитика', example: 'v=15, μ=0,6, 10 % под уклон', expected: 225 / (2 * GRAVITY * (0.6 * cos - sin)), actual: -b.x, tolerance: 0.01, relative: true });
  });
  it('08: impact, CRASH3, risk', () => {
    const body = (m: number, x: number, vx: number) => ({ mass: m, yawInertia: 2000, position: { x, y: 0 }, velocity: { x: vx, y: 0 }, yawRate: 0 });
    const c = planarImpact({ a: body(1000, 0, 20), b: body(1500, 4, 0), point: { x: 2, y: 0 }, normal: { x: 1, y: 0 }, restitution: 0.2 });
    check({ area: '08 удар', formula: "v1' = (m1v1 − m2k(v1−v2))/(m1+m2)", source: 'учебная формула центрального удара', example: 'm1=1000, m2=1500, v1=20, k=0,2', expected: 5.6, actual: c.a.velocity.x, tolerance: 1e-10, relative: false });
    const el = planarImpact({ a: { ...body(1200, 0, 15), velocity: { x: 15, y: 9 } }, b: body(1500, 4, -2), point: { x: 2, y: 0.8 }, normal: { x: 1, y: 0.2 }, restitution: 1, contactFriction: 0 });
    check({ area: '08 удар', formula: 'k=1, μc=0: E сохраняется', source: 'предельный случай', example: 'косой эксцентричный', expected: 0, actual: el.energyLoss / el.energyBefore, tolerance: 1e-9, relative: false });
    const st = stiffnessFromTest({ mass: 1400, speed: 15.6, noDamageSpeed: 2.2, averageCrush: 0.55, width: 1.6, source: 'v' });
    check({ area: '08 CRASH3', formula: 'w(AC+BC²/2+A²/(2B)) = mV²/2', source: 'тождество Campbell (вывод)', example: 'm=1400, V=15,6, b0=2,2, C=0,55', expected: 0.5 * 1400 * 15.6 ** 2,
      actual: crushEnergy({ width: 1.6, crush: Array(6).fill(0.55), source: 'v' }, st).energy, tolerance: 1e-9, relative: true });
    for (const [mode, pub] of [['all', 0.427], ['frontal', 0.389], ['nearside', 0.838], ['farside', 0.478], ['rear', 0.199]] as const) {
      check({ area: '08 риск', formula: 'P = 1/(1+e^−(b0+b1Δv))', source: 'Augenstein et al. 2003, табл. 2–3', example: `${mode}, Δv=30 mph`, expected: pub, actual: occupantMais3Risk(30 * 0.44704, mode as keyof typeof AUGENSTEIN_2003).probability!, tolerance: 0.0006, relative: false });
    }
    check({ area: '09 риск', formula: 'опубликованная точка', source: 'Tefft 2011, табл. 3', example: 'смерть 50 % при 42 mph', expected: 0.5, actual: (pedestrianRisk(TEFFT_2011.death[2] * 0.44704, 'death') as { probability: number }).probability, tolerance: 1e-10, relative: false });
  });
  it('09: throw models', () => {
    const mu = 0.6;
    check({ area: '09 Searle', formula: 'tanθ = 1/μ (граница скольжения)', source: 'Becker et al. 2015 (59° при μ=0,6)', example: 'μ=0,6', expected: 59, actual: Math.atan(1 / mu) * 180 / Math.PI, tolerance: 0.05, relative: false });
    const D = searleThrow(13.4112, 0.35, mu).total;
    check({ area: '09 Searle', formula: 'v = √(2μgD)/(cosθ+μsinθ)', source: 'Becker et al. 2015, ур. 33', example: 'v=30 mph, θ=0,35', expected: 13.4112, actual: Math.sqrt(2 * GRAVITY * mu * D) / (Math.cos(0.35) + mu * Math.sin(0.35)), tolerance: 1e-9, relative: true });
    check({ area: '09 Wood', formula: 'V = (mv+mp)/mv·√(2μg(D−μh))', source: 'Soica 2018, ур. 2 (Wood 1988)', example: 'V=14, mv=1300, mp=75', expected: 14,
      actual: woodImpactSpeed(woodThrowDistance(14, 0.66, 1, 1300, 75), 0.66, 1, 1300, 75)!, tolerance: 1e-10, relative: true });
  });
  it('10/12: hand examples of expert formulas', () => {
    check({ area: '10 остановочный путь', formula: 'S = v(t1+t2+0,5t3) + v²/(2j)', source: 'ручной расчёт', example: '60 км/ч, 1/0,1/0,35 с, 6,8 м/с²', expected: 41.675, actual: stoppingDistance(60 / 3.6, 1, 0.1, 0.35, 6.8), tolerance: 0.005, relative: false });
    check({ area: '10 безопасная скорость', formula: 'v = j(−T+√(T²+2S/j))', source: 'обратная функция', example: 'S=40 м', expected: 40, actual: stoppingDistance(safeSpeed(40, 1, 0.1, 0.35, 6.8), 1, 0.1, 0.35, 6.8), tolerance: 1e-9, relative: true });
    const r = CALCULATORS['expert.braking'].run({ skidLength: 20, j: 6.8, t3: 0.35 });
    check({ area: '12 след юза', formula: 'V = 1,8·t3·j + √(25,92·j·S)', source: 'ручной расчёт', example: 'S=20, j=6,8, t3=0,35', expected: 63.657, actual: r.status === 'ok' ? (r.records[0].result as { speedKmh: number }).speedKmh : NaN, tolerance: 0.005, relative: false });
  });
  it('12: synthetic inverse and Monte Carlo', async () => {
    const p = syntheticVehicle(); p.brakes.abs = 'disabled';
    const pr: ImpactProblem = { vehicles: [{ id: 'a', parameters: p, x: 0, y: 0, heading: 0, postImpact: 'locked' }, { id: 'b', parameters: structuredClone(p), x: 2.6, y: 2.2, heading: -Math.PI / 2, postImpact: 'locked' }],
      contact: { point: { x: 2.25, y: 0.9 }, normal: { x: 0, y: 1 } }, restitution: 0.1, mu: 0.7, muSource: synthetic,
      variables: [{ name: 'speed0', min: 5, max: 25 }, { name: 'speed1', min: 3, max: 20 }], evidence: [], seed: 7, starts: 4 };
    const truth = impactForward(pr, { speed0: 16, speed1: 8 });
    pr.evidence = truth.rest.map((x, i) => ({ id: `r${i}`, vehicle: i as 0 | 1, x: x.state.x, y: x.state.y, heading: x.state.heading, sigmaPosition: 0.2, sigmaHeading: 0.05 }));
    const out = reconstructImpact(pr);
    check({ area: '12 обратная задача', formula: 'min Σ((прогноз−набл.)/σ)²', source: 'синтетические данные', example: 'v1=16 м/с', expected: 16, actual: out.variables.speed0, tolerance: 0.1, relative: false });
    const vs = safeSpeed(40, 1, 0.1, 0.35, 6.8);
    const mc = await runMonteCarlo({ model: 'expert.braking', seed: 3, inputs: { v0: { kind: 'uniform', min: 10, max: 20 }, available: { kind: 'fixed', value: 40 },
      t1: { kind: 'fixed', value: 1 }, t2: { kind: 'fixed', value: 0.1 }, t3: { kind: 'fixed', value: 0.35 }, j: { kind: 'fixed', value: 6.8 } } });
    check({ area: '12 Монте-Карло', formula: 'доля = P(v0 ≤ vбез)', source: 'аналитика равномерного распределения', example: 'N=1000, seed=3', expected: (vs - 10) / 10, actual: mc.outputs.avoidable.fraction!, tolerance: 0.05, relative: false });
  }, 60000);
  it('13: homography exactness', () => {
    const H = [[40, 3, 900], [1, -25, 1000], [0.0005, 0.02, 1]];
    const proj = (x: number, y: number) => { const w = H[2][0] * x + H[2][1] * y + H[2][2]; return { u: (H[0][0] * x + H[0][1] * y + H[0][2]) / w, v: (H[1][0] * x + H[1][1] * y + H[1][2]) / w }; };
    const h = fitHomography([[0, 0], [5, 0], [0, 10], [5, 12]].map(([x, y]) => ({ image: proj(x, y), plane: { x, y } })));
    const w = H[2][0] * 2 + H[2][1] * 7 + H[2][2];
    const q = { u: (H[0][0] * 2 + H[0][1] * 7 + H[0][2]) / w, v: (H[1][0] * 2 + H[1][1] * 7 + H[1][2]) / w };
    const back = { x: (h.H[0][0] * q.u + h.H[0][1] * q.v + h.H[0][2]) / (h.H[2][0] * q.u + h.H[2][1] * q.v + h.H[2][2]) };
    check({ area: '13 гомография', formula: 'DLT по 4 точкам', source: 'точная синтетическая проекция', example: 'точка (2; 7)', expected: 2, actual: back.x, tolerance: 1e-6, relative: false });
  });
  it('writes the table when requested', () => {
    const out = process.env.PHYSICS_VERIFICATION_OUT;
    if (!out) return;
    const fmt = (x: number) => Number.isFinite(x) ? (Math.abs(x) >= 1000 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(4) : x.toFixed(4)) : String(x);
    const lines = ['| Область | Формула | Источник | Пример | Ожидание | Результат | Допуск | Статус |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map(r => `| ${r.area} | ${r.formula} | ${r.source} | ${r.example} | ${fmt(r.expected)} | ${fmt(r.actual)} | ${r.relative ? `${r.tolerance} (отн.)` : r.tolerance} | пройдено |`)];
    writeFileSync(out, lines.join('\n') + '\n');
  });
});
